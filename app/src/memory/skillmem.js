/* 共有的技能长期记忆库（候选池）
 *
 * 和 permanent.js（普通永久记忆）的区别：这里**只有候选池**。
 * 原因：这条经验的"永久形态"不是一条记录，而是**技能文件夹里的文件**——
 * 权重够了之后会被归档进对应技能（AI 自己整理写文件），然后从池子里移出。
 *
 * 结构：cand[] —— 攒权重的经验；长期不再出现会衰减、被清掉。
 */
const store = require('../store');
const bus = require('../bus');

const NS = 'skillmem';
const EMPTY = { cand: [] };

function load() {
  const v = store.read(NS, EMPTY);
  return { cand: Array.isArray(v && v.cand) ? v.cand : [] };
}
function save(v) { store.write(NS, v); bus.emit('memory:changed', NS); }

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

/* 合并一条经验：已有的累加权重，没有的入池 */
function upsert(cand, item, now) {
  const key = norm(item.text);
  if (!key) return null;
  const hit = cand.find((c) => norm(c.text) === key);
  if (hit) {
    const add = Number(item.weight) || 1;
    hit.weight = Math.min(10, Math.round((Number(hit.weight) || 0) + add * 0.6));
    hit.hits = (Number(hit.hits) || 1) + 1;
    hit.lastSeen = now;
    if (item.skill && !hit.skill) hit.skill = item.skill;
    return hit;
  }
  const c = {
    text: String(item.text).slice(0, 300),
    weight: Math.max(1, Math.min(10, Number(item.weight) || 1)),
    skill: item.skill ? String(item.skill).slice(0, 40) : '',
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
    hits: 1,
    firstSeen: now,
    lastSeen: now,
  };
  cand.push(c);
  return c;
}

function merge(items, maxCand) {
  const v = load();
  const now = Date.now();
  let n = 0;
  for (const it of items || []) {
    if (!it || !it.text) continue;
    if (upsert(v.cand, it, now)) n++;
  }
  save(v);
  const pruned = maxCand ? prune(maxCand) : { dropped: 0, left: v.cand.length };
  return { added: n, total: load().cand.length, pruned: pruned.dropped };
}

/* 条数上限：超了就按「权重低的优先、其次最久没出现的」淘汰 */
function prune(maxCand) {
  const v = load();
  const cap = Math.max(10, Number(maxCand) || 200);
  if (v.cand.length <= cap) return { dropped: 0, left: v.cand.length };
  v.cand.sort((a, b) =>
    (Number(b.weight) || 0) - (Number(a.weight) || 0) ||
    (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
  const before = v.cand.length;
  v.cand = v.cand.slice(0, cap);
  save(v);
  return { dropped: before - v.cand.length, left: v.cand.length };
}

/* 衰减：很久没再出现的经验慢慢掉权重，掉到底就清掉 */
function decay(daysWindow, factor, floor) {
  const v = load();
  const now = Date.now();
  const win = (Number(daysWindow) || 21) * 86400000;
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

/* 权重够了的经验（等待归档进技能文件夹） */
function ready(threshold) {
  const th = Number(threshold) || 4;
  return load().cand.filter((c) => (Number(c.weight) || 0) >= th)
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
}

/* 归档成功后，把这些从池子里移出（它们的永久形态已经在技能文件夹里了） */
function drop(texts) {
  const keys = new Set((texts || []).map(norm));
  const v = load();
  const before = v.cand.length;
  v.cand = v.cand.filter((c) => !keys.has(norm(c.text)));
  save(v);
  return { removed: before - v.cand.length, left: v.cand.length };
}

function candidates() { return load().cand; }

module.exports = { load, save, merge, decay, ready, drop, candidates, prune, NS };
