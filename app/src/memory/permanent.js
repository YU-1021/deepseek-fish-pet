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

/* 合并一条候选要点：已有的累加权重，没有的入池 */
function upsertCand(cand, item, now) {
  const key = norm(item.text);
  if (!key) return null;
  const hit = cand.find((c) => norm(c.text) === key);
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
    if (v.facts.some((f) => norm(f.text) === norm(it.text))) continue;   // 已经是永久记忆了
    upsertCand(v.cand, it, now);
  }
  save(v);
  return v;
}

/* 权重到阈值 → 晋升为永久记忆 */
function promote(threshold) {
  const v = load();
  const th = Number(threshold) || 7;
  const keep = [];
  let promoted = 0;
  for (const c of v.cand) {
    if (Number(c.weight) >= th) {
      v.facts.push({ text: c.text, weight: c.weight, tags: c.tags || [], hits: c.hits || 1, ts: Date.now() });
      promoted++;
    } else keep.push(c);
  }
  v.cand = keep;
  save(v);
  return { promoted, total: v.facts.length };
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

module.exports = { load, save, merge, promote, decay, topFacts, facts, candidates, removeFact, upsertCand, NS };
