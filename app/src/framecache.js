/* framecache.js —— 同帧抓帧复用（P3：工具调用编排 · 合并同帧操作）
 *
 * 问题：find_text / screen_look 每次都走 captureScreenFallback()（无损 PNG，实测 ~650ms）。
 * 但同一屏内连续几个工具调用，画面往往根本没变 —— 那 650ms 是白花的。
 *
 * 做法：
 *   1. 先用屏幕流抓一张便宜帧（~50ms，Electron desktopCapturer 流，JPEG）当"指纹"；
 *   2. 指纹命中缓存 → 直接复用上次的 PNG 文件路径，跳过 650ms 抓图；
 *   3. 不命中 → 正常抓 PNG，并把 (指纹 → PNG 文件) 存起来。
 *
 * 注意：JPEG 帧只作指纹用，不做识别（识别仍用 PNG）；光标默认不画进便宜帧，
 * 避免鼠标移动导致指纹抖动（noCursor=true）。
 * 开关：PA_FRAME_CACHE=0 关闭。
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const TTL_MS = 30 * 1000;
const MAX_ENTRIES = 8;
const cache = new Map();

function disabled() {
  return String(process.env.PA_FRAME_CACHE || '') === '0';
}

/** 从 dataUrl 算指纹（只取 base64 部分） */
function keyOfDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  const b64 = i >= 0 ? s.slice(i + 1) : s;
  return crypto.createHash('sha1').update(b64).digest('hex');
}

function get(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { cache.delete(k); return null; }
  if (!fs.existsSync(e.path)) { cache.delete(k); return null; }
  e.hits = (e.hits || 1) + 1;
  return { path: e.path, dataUrl: e.dataUrl, hits: e.hits, at: e.at };
}

function put(k, path, dataUrl) {
  if (disabled() || !k || !path) return;
  cache.set(k, { path, dataUrl: String(dataUrl || ''), at: Date.now(), hits: 1 });
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

module.exports = {
  disabled, keyOfDataUrl, get, put,
  _size: () => cache.size,
  _reset: () => cache.clear(),
  TTL_MS, MAX_ENTRIES,
};
