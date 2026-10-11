/* som.js —— Set-of-Marks：把"猜坐标"变成"选编号"
 *
 * ============================ 为什么要有它 ============================
 * 调研数据（已核实）：
 *   · GPT-4V 零样本直接要坐标：ScreenSpot 16.2%
 *   · 同样的模型，改成"在编号框里选一个"：70.5%
 *   · ★再加"每框附局部语义"（框里写了什么字）：93.8%★ ← 关键在这一步
 * 而我们**天然就有局部语义**：候选框本来就是从 OCR 词框来的，框里写了什么一目了然。
 *
 * 用法：先 collectCandidates 收候选（OCR 词 + 模板命中 + UIA 矩形），
 *       dedupe 去重（>90% 重叠，OCR/模板优先），
 *       drawMarks 画编号框，把"候选清单 + 编号图"给模型，
 *       模型只回 {id, confidence}（或 -1），**永远不要它给像素坐标**。
 */
'use strict';

/* ---------------- 纯逻辑：收集候选 ---------------- */

/* 把各类来源的候选合并成统一结构 {x,y,w,h,text,kind,confidence} */
function collectCandidates(src) {
  const s = src || {};
  const out = [];
  for (const w of (s.words || [])) {
    if (!w || w.w <= 0 || w.h <= 0) continue;
    out.push({ x: w.x, y: w.y, w: w.w, h: w.h, text: String(w.t || ''), kind: 'ocr', confidence: 0.8 });
  }
  for (const t of (s.templates || [])) {
    if (!t || t.w <= 0 || t.h <= 0) continue;
    out.push({ x: t.x, y: t.y, w: t.w, h: t.h, text: String(t.name || ''), kind: 'template', confidence: 0.95 });
  }
  for (const u of (s.uiaRects || [])) {
    if (!u || u.w <= 0 || u.h <= 0) continue;
    out.push({ x: u.x, y: u.y, w: u.w, h: u.h, text: String(u.name || u.automationId || ''), kind: 'uia', confidence: 0.98 });
  }
  for (const e of (s.extra || [])) {
    if (!e || e.w <= 0 || e.h <= 0) continue;
    out.push({ x: e.x, y: e.y, w: e.w, h: e.h, text: String(e.text || ''), kind: e.kind || 'extra', confidence: e.confidence == null ? 0.5 : e.confidence });
  }
  return out;
}

/* 重叠比例（交集面积 ÷ 较小者面积）—— OmniParser 用的是这个口径 */
function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const small = Math.min(a.w * a.h, b.w * b.h);
  return small > 0 ? inter / small : 0;
}

/* 去重：重叠超过阈值的只留一个 —— 优先级 uia > template > ocr > extra（同优先级比置信度） */
const KIND_RANK = { uia: 4, template: 3, ocr: 2, extra: 1 };
function dedupe(cands, overlapThreshold) {
  const th = overlapThreshold == null ? 0.9 : overlapThreshold;
  const sorted = (cands || []).slice().sort((a, b) => {
    const r = (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
    if (r !== 0) return r;
    return (b.confidence || 0) - (a.confidence || 0);
  });
  const kept = [];
  for (const c of sorted) {
    let dup = false;
    for (const k of kept) { if (overlapRatio(c, k) >= th) { dup = true; break; } }
    if (!dup) kept.push(c);
  }
  /* 按阅读顺序编号（从上到下、从左到右）—— 编号顺序要稳定，模型才好对 */
  kept.sort((a, b) => (Math.round(a.y / 12) - Math.round(b.y / 12)) || (a.x - b.x));
  kept.forEach((c, i) => { c.id = i + 1; });
  return kept;
}

/* ---------------- 纯逻辑：拼提示词 / 解析回答 ---------------- */

/* 候选清单 + 要求：只回 id，不要坐标（调研明确"模型永不产出像素坐标"） */
function buildPrompt(cands, goal, opts) {
  const o = opts || {};
  const lines = (cands || []).map((c) => {
    const label = c.text ? '「' + c.text.slice(0, 24) + '」' : '(无文字)';
    return '  ' + c.id + '. ' + label + (o.withKind ? ' [' + c.kind + ']' : '');
  });
  return '图上的候选元素已经用红框和编号标出来了（编号画在框的左上角）。\n'
    + '候选清单：\n' + lines.join('\n') + '\n\n'
    + '请从中选出「' + String(goal || '目标') + '」对应的那一个。\n'
    + '**只输出一行 JSON**：{"id": <编号>, "confidence": <0~1>}\n'
    + '如果清单里没有对应的，输出 {"id": -1, "confidence": 0}。\n'
    + '**绝对不要输出坐标。**';
}

/* 解析模型回答（容忍外面包着解释文字或 ```json ```） */
function parseAnswer(text) {
  const t = String(text || '');
  const m = t.match(/\{\s*"id"\s*:\s*(-?\d+)\s*(?:,\s*"confidence"\s*:\s*([0-9.]+)\s*)?\}/)
    || t.match(/\{\s*'id'\s*:\s*(-?\d+)\s*(?:,\s*'confidence'\s*:\s*([0-9.]+)\s*)?\}/)
    || t.match(/id\s*[:=]\s*(-?\d+)/);
  if (!m) return { ok: false, reason: 'no-id-in-answer', raw: t.slice(0, 120) };
  const id = Number(m[1]);
  const conf = m[2] != null ? Number(m[2]) : (id > 0 ? 0.6 : 0);
  return { ok: id > 0, id, confidence: isNaN(conf) ? 0.6 : conf, raw: t.slice(0, 120) };
}

/* ---------------- 画编号框（纯像素操作，可测）----------------
 * 为什么自己画而不引图像库：只需要"矩形 + 数字"，自己写 5x7 点阵够用，
 * 而且**纯 Buffer 操作可以单测**（不依赖 electron / canvas）。 */

const FONT5x7 = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

function setPx(buf, w, h, x, y, rgb) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const p = (y * w + x) * 4;
  buf[p] = rgb[2]; buf[p + 1] = rgb[1]; buf[p + 2] = rgb[0]; buf[p + 3] = 255;   // BGRA
}

function drawRect(buf, w, h, r, rgb, thickness) {
  const t = thickness == null ? 2 : thickness;
  for (let d = 0; d < t; d++) {
    for (let x = r.x - d; x < r.x + r.w + d; x++) { setPx(buf, w, h, x, r.y - d, rgb); setPx(buf, w, h, x, r.y + r.h + d, rgb); }
    for (let y = r.y - d; y < r.y + r.h + d; y++) { setPx(buf, w, h, r.x - d, y, rgb); setPx(buf, w, h, r.x + r.w + d, y, rgb); }
  }
}

function drawDigits(buf, w, h, text, x, y, rgb, scale) {
  const s = scale == null ? 2 : scale;
  let cx = x;
  for (const ch of String(text)) {
    const glyph = FONT5x7[ch];
    if (!glyph) { cx += 4 * s; continue; }
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) setPx(buf, w, h, cx + gx * s + dx, y + gy * s + dy, rgb);
      }
    }
    cx += 6 * s;
  }
  return cx;
}

/* 在 BGRA buffer 上画所有编号框。返回 {drawn, marks} */
function drawMarks(buf, w, h, cands, opts) {
  const o = opts || {};
  const rgb = o.color || [255, 64, 64];          // 红框
  const labelBg = o.labelBg || [0, 0, 0];        // 编号底
  const labelFg = o.labelFg || [255, 255, 255];  // 编号字
  const scale = o.scale == null ? 2 : o.scale;
  let drawn = 0;
  for (const c of (cands || [])) {
    if (!c || c.w <= 0 || c.h <= 0) continue;
    const r = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
    drawRect(buf, w, h, r, rgb, o.thickness == null ? 2 : o.thickness);
    const label = String(c.id == null ? drawn + 1 : c.id);
    const lw = label.length * 6 * scale + 4, lh = 7 * scale + 4;
    const lx = Math.max(0, r.x - 2), ly = Math.max(0, r.y - lh);
    for (let yy = ly; yy < Math.min(h, ly + lh); yy++) for (let xx = lx; xx < Math.min(w, lx + lw); xx++) setPx(buf, w, h, xx, yy, labelBg);
    drawDigits(buf, w, h, label, lx + 2, ly + 2, labelFg, scale);
    drawn++;
  }
  return { drawn, marks: cands };
}

module.exports = {
  collectCandidates, dedupe, overlapRatio, buildPrompt, parseAnswer,
  drawMarks, drawRect, drawDigits, FONT5x7, KIND_RANK,
};
