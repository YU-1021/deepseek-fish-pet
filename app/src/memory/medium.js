/* 中期记忆（隐藏，只给模型当上下文，不在 UI 展示）
 * 一次会话一条摘要，只保留最新 N 条（默认 20），多的直接删。
 */
const store = require('../store');
const bus = require('../bus');

const NS = 'medium';

function list() {
  const v = store.read(NS, []);
  return Array.isArray(v) ? v : [];
}
function save(v) { store.write(NS, v); bus.emit('memory:changed', NS); }

function add(entry) {
  const v = list();
  v.push(entry);
  save(v);
  return entry;
}
function has(id) { return list().some((e) => e.id && e.id === id); }

/* 只留最新 keep 条 */
function prune(keep) {
  const v = list();
  const n = Number(keep) || 20;
  if (v.length <= n) return v;
  const out = v.slice(-n);
  save(out);
  return out;
}
function olderThan(date) { return list().filter((e) => e.date !== date); }
function keepOnly(date) { save(list().filter((e) => e.date === date)); }
function removeAt(ts) { save(list().filter((e) => e.ts !== ts)); }

module.exports = { list, save, add, has, prune, olderThan, keepOnly, removeAt, NS };
