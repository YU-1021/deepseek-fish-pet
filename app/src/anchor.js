/* anchor.js —— 锚点驱动 ROI：禁止用"屏幕百分比"猜区域
 *
 * ============================ 为什么必须有它 ============================
 * 实测事故（2026-10-03）：我为了裁"结果卡片区"，先后用窗口高度的 32% / 48% 当 y 起点，
 * **两次都裁错**（一次裁到标签选择区、一次裁到页脚），视觉模型回"没有卡片"——
 * 它是对的，是我裁错了区域 ✗。八屏全废。
 *
 * 正确做法：**先用 OCR 找到页面上的锚点文字，再以锚点为基准算 ROI**。
 * 锚点自己是页面内容的一部分，它在哪里、ROI 就在哪里 —— 不依赖窗口位置、不依赖屏幕百分比。
 *
 * ============================ 本模块提供（全纯逻辑，可单测）============================
 *   findAnchor(words, patterns)      在词表里找锚点（可优先/次优先）
 *   roiBelow(anchor, opts)           锚点下方的 ROI（可限制高度、左右边界）
 *   roiAround(anchor, opts)          锚点周围的 ROI
 *   clampRoi(roi, bounds)            把 ROI 夹进安全区（比如屏幕、或可用区域）
 *   pickBest(anchors, opts)          多个锚点时按"最靠上/指定序号"选一个
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).replace(/[\s,，]/g, '');

/* 在词表里找锚点：patterns 可以是字符串或 RegExp；按 order 决定优先级 */
function findAnchor(words, patterns, opts) {
  const o = opts || {};
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const pool = (words || []).filter((w) => w && w.w > 0 && w.h > 0);
  for (const p of list) {
    const re = p instanceof RegExp ? p : null;
    const hits = pool.filter((w) => (re ? re.test(norm(w.t)) : norm(w.t).indexOf(norm(p)) >= 0));
    if (!hits.length) continue;
    hits.sort((a, b) => (o.order === 'bottom' ? b.y - a.y : a.y - b.y));
    const h = hits[0];
    return {
      ok: true, word: h, text: h.t,
      rect: { x: h.x, y: h.y, w: h.w, h: h.h },
      center: { x: Math.round(h.x + h.w / 2), y: Math.round(h.y + h.h / 2) },
      matchedBy: String(p), hits: hits.length,
    };
  }
  return { ok: false, reason: 'anchor-not-found', tried: list.map(String) };
}

/* 锚点下方的 ROI：gap 是离锚点底边的距离 */
function roiBelow(anchor, opts) {
  const o = opts || {};
  if (!anchor || !anchor.rect) return null;
  const a = anchor.rect;
  const gap = o.gap == null ? 18 : o.gap;
  const x = o.x == null ? Math.max(0, Math.round(a.x) - (o.padLeft == null ? 0 : o.padLeft)) : o.x;
  const y = Math.round(a.y + a.h + gap);
  const w = o.width == null ? 900 : o.width;
  const h = o.height == null ? 300 : o.height;
  return { x, y, w, h };
}

/* 锚点周围的 ROI（用于"确认这个元素是什么"这种核对） */
function roiAround(anchor, opts) {
  const o = opts || {};
  if (!anchor || !anchor.rect) return null;
  const a = anchor.rect;
  const padX = o.padX == null ? 40 : o.padX;
  const padY = o.padY == null ? 14 : o.padY;
  return {
    x: Math.max(0, Math.round(a.x - padX)),
    y: Math.max(0, Math.round(a.y - padY)),
    w: Math.round(a.w + padX * 2),
    h: Math.round(a.h + padY * 2 + (o.extraBottom || 0)),
  };
}

/* 把 ROI 夹进边界（屏幕 / 可用区），并保证至少有 20x20 */
function clampRoi(roi, bounds) {
  if (!roi) return null;
  const b = bounds || { x: 0, y: 0, w: 1920, h: 1080 };
  const x = Math.max(b.x, Math.min(roi.x, b.x + b.w - 20));
  const y = Math.max(b.y, Math.min(roi.y, b.y + b.h - 20));
  const w = Math.max(20, Math.min(roi.w, b.x + b.w - x));
  const h = Math.max(20, Math.min(roi.h, b.y + b.h - y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/* 多个候选锚点里挑一个（默认最靠上；也可以要最靠下） */
function pickBest(anchors, opts) {
  const o = opts || {};
  const list = (anchors || []).filter((a) => a && a.rect);
  if (!list.length) return null;
  list.sort((a, b) => (o.order === 'bottom' ? b.rect.y - a.rect.y : a.rect.y - b.rect.y));
  return list[Math.max(0, Math.min(list.length - 1, o.index || 0))];
}

module.exports = { findAnchor, roiBelow, roiAround, clampRoi, pickBest };
