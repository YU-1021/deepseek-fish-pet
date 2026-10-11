/* 永久记忆（全隐藏，**存储不设上限**）
 * 两段结构：
 *   cand[]   候选池 —— 权重还不够的要点在这里攒权重；长期不再出现会衰减、被清掉
 *   facts[]  永久记忆 —— 权重到阈值就"晋升"进来，永不删除
 *
 * 设计取向跟人一样：不看时间，看重要性；反复出现的东西权重会累加，
 * 一次性的琐事自己就衰减掉了。
 *
 * 注意：存储不设上限 ≠ 注入不设上限。注入时会按权重取前 N 条，
 * 否则永久记忆越长、上下文越爆。
 */
const store = require('../store');
const bus = require('../bus');

const NS = 'permanent';
const EMPTY = { cand: [], facts: [] };

function load() {
  const v = store.read(NS, EMPTY);
  return {
    cand: Array.isArray(v && v.cand) ? v.cand : [],
    facts: Array.isArray(v && v.facts) ? v.facts : [],
  };
}
function save(v) { store.write(NS, v); bus.emit('memory:changed', NS); }

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

/* 近似判定（实测必要性）：
 * 模型每次抽要点措辞都不同 —— 同一件事会写成
 *   「主人养了一只叫豆豆的猫」 / 「主人养了一只猫叫豆豆」
 *   「主人下周要去上海出差三天」 / 「主人出差去上海三天」
 * 只做精确匹配的话，3 天就能攒出两组重复的永久记忆，白占注入预算。
 * 判据（故意保守，宁可不合并也别把两件不同的事合掉）：
 *   · 一方包含另一方 → 算同一个
 *   · 否则看**字符集合**的 Jaccard（不看顺序，所以"猫叫豆豆"和"叫豆豆的猫"能对上）
 * 阈值可以用 config.permSimThreshold 覆盖。 */
const SIM_THRESHOLD = 0.72;
let simOverride = null;
function setSimThreshold(v) { const n = Number(v); simOverride = Number.isFinite(n) ? n : null; }
function similar(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B || A.indexOf(B) >= 0 || B.indexOf(A) >= 0) return true;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  const uni = sa.size + sb.size - inter;
  const th = simOverride == null ? SIM_THRESHOLD : simOverride;
  return uni > 0 && inter / uni >= th;
}

/* 合并一条候选要点：已有的（含近似）累加权重，没有的入池 */
function upsertCand(cand, item, now) {
  const key = norm(item.text);
  if (!key) return null;
  const hit = cand.find((c) => similar(c.text, item.text));
  if (hit) {
    const add = Number(item.weight) || 0;
    hit.weight = Math.min(10, Math.round((Number(hit.weight) || 0) + add * 0.6));
    hit.hits = (Number(hit.hits) || 1) + 1;
    hit.lastSeen = now;
    return hit;
  }
  const c = {
    text: String(item.text).slice(0, 200),
    weight: Math.max(1, Math.min(10, Number(item.weight) || 1)),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
    hits: 1,
    firstSeen: now,
    lastSeen: now,
  };
  cand.push(c);
  return c;
}

function merge(newItems) {
  const v = load();
  const now = Date.now();
  for (const it of newItems || []) {
    if (!it || !it.text) continue;
    if (v.facts.some((f) => similar(f.text, it.text))) continue;   // 已经是（或近似是）永久记忆了
    upsertCand(v.cand, it, now);
  }
  save(v);
  return v;
}

/* 权重到阈值 → 晋升为永久记忆。
 * 注意：晋升前要再查一次重 —— 候选池里可能有两条**措辞不同但近似**的条目
 * 同时到达阈值，直接 push 就会在永久记忆里留下重复（实测 3 天出过两组）。 */
function promote(threshold) {
  const v = load();
  const th = Number(threshold) || 7;
  const keep = [];
  let promoted = 0, merged = 0;
  for (const c of v.cand) {
    if (Number(c.weight) >= th) {
      const dup = v.facts.find((f) => similar(f.text, c.text));
      if (dup) {
        /* 合并进已有那条：取更高权重、累计命中次数；ts 保留最旧的（removeFact 按 ts 定位） */
        dup.weight = Math.max(Number(dup.weight) || 0, Number(c.weight) || 0);
        dup.hits = (Number(dup.hits) || 1) + (Number(c.hits) || 1);
        dup.text = (String(c.text).length > String(dup.text).length) ? c.text : dup.text;   // 留信息更多的那句
        merged++;
      } else {
        v.facts.push({ text: c.text, weight: c.weight, tags: c.tags || [], hits: c.hits || 1, ts: Date.now() });
        promoted++;
      }
    } else keep.push(c);
  }
  v.cand = keep;
  save(v);
  return { promoted, merged, total: v.facts.length };
}

/* 衰减：很久没再出现的候选慢慢掉权重，掉到底就清掉 */
function decay(daysWindow, factor, floor) {
  const v = load();
  const now = Date.now();
  const win = (Number(daysWindow) || 14) * 86400000;
  const f = Number(factor) || 0.8;
  const fl = Number(floor) || 1;
  const before = v.cand.length;
  for (const c of v.cand) {
    if (now - (Number(c.lastSeen) || now) > win) c.weight = (Number(c.weight) || 0) * f;
  }
  v.cand = v.cand.filter((c) => (Number(c.weight) || 0) >= fl);
  save(v);
  return { dropped: before - v.cand.length, left: v.cand.length };
}

/* 注入用：按权重取前 N 条（存储不设上限，注入要有上限） */
function topFacts(n) {
  const v = load();
  return v.facts.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, Number(n) || 40);
}
function facts() { return load().facts; }
function candidates() { return load().cand; }
function removeFact(ts) { const v = load(); v.facts = v.facts.filter((f) => f.ts !== ts); save(v); }

module.exports = { load, save, merge, promote, decay, topFacts, facts, candidates, removeFact, upsertCand, similar, setSimThreshold, SIM_THRESHOLD, NS };
