/* 长期记忆 · 日记（一天一篇）
 * 只保留最近 N 天（默认 20），超期删除。
 * 这是唯一展示给用户看的一层（📖 面板）。
 */
const store = require('../store');
const bus = require('../bus');

const NS = 'long';

function list() {
  const v = store.read(NS, []);
  return Array.isArray(v) ? v : [];
}
function save(v) { store.write(NS, v); bus.emit('memory:changed', NS); }

function add(entry) {
  const v = list().filter((e) => e.date !== entry.date);
  v.push(entry);
  v.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  save(v);
  return entry;
}

/* 只留最近 days 天 */
function pruneDays(days) {
  const v = list();
  const n = Number(days) || 20;
  if (v.length <= n) return v;
  const out = v.slice(-n);
  save(out);
  return out;
}
function removeAt(ts) { save(list().filter((e) => e.ts !== ts)); }

module.exports = { list, save, add, pruneDays, removeAt, NS };
