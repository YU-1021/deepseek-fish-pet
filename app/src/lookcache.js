/* lookcache.js —— screen_look 的同帧同问题缓存（P2 性能）
 *
 * 为什么：视觉模型调用单次 avg 2.1s，而她在同一轮里经常对"没变过的画面"连看好几次。
 * 做法：按 (图像 sha1 + 问题文本) 缓存最近一次描述，TTL 90s、最多 16 条 LRU。
 * 命中时直接复用文字，并附带"画面没变、别重复看"的提示（顺带治重复 look 的坏习惯）。
 * 关闭开关：环境变量 PA_LOOK_CACHE=0。
 */
'use strict';
const crypto = require('crypto');

const TTL_MS = 90 * 1000;
const MAX_ENTRIES = 16;
const cache = new Map();

function disabled() {
  return String(process.env.PA_LOOK_CACHE || '') === '0';
}

function key(imageBuf, question) {
  return crypto.createHash('sha1').update(imageBuf || Buffer.alloc(0)).update('|').update(String(question || '')).digest('hex');
}

/** 命中返回 { text, hits }（hits=被复用的次数，从 1 开始算第一次；第二次命中时是 2） */
function get(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { cache.delete(k); return null; }
  e.hits = (e.hits || 1) + 1;
  return { text: e.text, hits: e.hits };
}

function put(k, text) {
  if (disabled()) return;
  cache.set(k, { text: String(text || ''), at: Date.now(), hits: 1 });
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

module.exports = {
  disabled, key, get, put,
  _size: () => cache.size,
  _reset: () => cache.clear(),
  TTL_MS, MAX_ENTRIES,
};
