/* ocrcache.js —— 同图 OCR 结果缓存（P3：工具调用编排 · 缓存）
 *
 * 问题：find_text 每次 OCR 一张图（旧路径 0.76s / 新常驻服务 0.30s）。
 * 同一屏上连续找几段文字时，OCR 结果完全可以复用（图相同 → OCR 结果必然相同）。
 *
 * 做法：按图片内容 sha1 缓存 ocrJson 的完整结果（lines/words/text），TTL 60s、LRU 8 条。
 * 开关：PA_OCR_CACHE=0 关闭。
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 8;
const cache = new Map();

function disabled() {
  return String(process.env.PA_OCR_CACHE || '') === '0';
}

/** 文件内容的 sha1；读不到文件返回 null（调用方就跳过缓存） */
function keyOfFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch (e) {
    return null;
  }
}

function get(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { cache.delete(k); return null; }
  e.hits = (e.hits || 1) + 1;
  return { ...e.value, __cacheHits: e.hits };
}

function put(k, value) {
  if (disabled() || !k || !value || !value.ok) return;
  cache.set(k, { value, at: Date.now(), hits: 1 });
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

module.exports = {
  disabled, keyOfFile, get, put,
  _size: () => cache.size,
  _reset: () => cache.clear(),
  TTL_MS, MAX_ENTRIES,
};
