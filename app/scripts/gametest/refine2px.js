/* refine2px.js —— ★② ≤2px 精配准：梯度加权亚像素细化（用合成屏的独立真值 layout.js ✓）★
 * 做法（确定性✓ 无模型✓）：
 *   对每个 icon 目标的**已检出中心**，在 ±R 像素窗口内用**梯度幅值加权**求亚像素重心 ✓
 *   （权重 = 该像素的梯度幅值 ✓ —— 边缘越强的地方越"像"图案轮廓 ✓ 比"能量重心"更贴边 ✓）
 * 报：★改前（检出中心直接当结果）与改后（亚像素细化）★的 ≤2px / ≤6px 通过率 + 中心误差三项 ✓
 * ★诚实边界（先说清 ✓）：±R 的搜索窗**只能修"初始估计已经落在 ±R 内"的误差** ✗ ——
 *   合成屏那个 **22.8px 最大误差是"碎片配对错"✗**（72x72 被切成 11 块、挑了 19x10 碎片 ✓），
 *   它**不在精配准能管的范围**✗（要修得靠分格/合并 ✓ 见 iconcut 的 close 实验与 modeGrid ✓）。这条我会照实报 ✓。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const IC = require(path.join(APP, 'src/iconcut'));
const L = require('./layout');
const Jimp = require('jimp').Jimp;
const PNG = 'C:/deepseek/gametest/myframes/f000.png';
const BAND = { x0: 40, y0: 600, x1: 1780, y1: 960 };
const TOLS = [6, 2];

function gradMag(gray, w, h) {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = gray[i + 1] - gray[i - 1], gy = gray[i + w] - gray[i - w];
    g[i] = Math.hypot(gx, gy);
  }
  return g;
}
function subpixel(g, w, h, cx, cy, R) {
  let sx = 0, sy = 0, s = 0;
  for (let y = Math.max(1, cy - R); y <= Math.min(h - 2, cy + R); y++)
    for (let x = Math.max(1, cx - R); x <= Math.min(w - 2, cx + R); x++) {
      const v = g[y * w + x]; sx += x * v; sy += y * v; s += v;
    }
  return s > 0 ? { cx: sx / s, cy: sy / s } : { cx, cy };
}

(async () => {
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const img = await Jimp.fromBuffer(fs.readFileSync(PNG));
  const w = img.width, h = img.height;
  const gray = IC.lumaFromJimp(img);
  const g = gradMag(gray, w, h);
  const det = (await IC.scan(PNG, { mode: 'b', region: BAND })).items || [];
  const icons = L.buttons.filter((b) => b.kind === 'icon');
  const rows = [];
  for (const t of icons) {
    const tx = t.x + Math.round(t.w / 2), ty = t.y + Math.round(t.h / 2);
    const near = det.map((d) => ({ d, dist: Math.hypot(d.cx - tx, d.cy - ty) })).sort((a, b) => a.dist - b.dist)[0];
    if (!near) { rows.push({ id: t.id, before: null }); continue; }
    const before = Math.hypot(near.d.cx - tx, near.d.cy - ty);
    const sp = subpixel(g, w, h, near.d.cx, near.d.cy, 3);      // ★±3px 细配准（lead 允许的做法 ✓）★
    const after = Math.hypot(sp.cx - tx, sp.cy - ty);
    rows.push({ id: t.id, before, after, moved: Math.hypot(sp.cx - near.d.cx, sp.cy - near.d.cy) });
  }
  const stat = (a) => { if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
  const B = rows.filter((r) => r.before != null).map((r) => r.before);
  const A = rows.filter((r) => r.after != null).map((r) => r.after);
  const sb = stat(B), sa = stat(A);
  const rate = (arr, tol) => arr.filter((v) => v <= tol).length + '/' + arr.length + ' = ' + (arr.length ? (arr.filter((v) => v <= tol).length / arr.length * 100).toFixed(1) : '0.0') + '%';
  console.log('=== ② 精配准（梯度加权亚像素 ✓ ±3px 窗 ✓ 真值 = layout.js ✓）===');
  console.log('  样本 n=' + B.length + '（icon 类；检出中心能配上真值框的 ✓）');
  for (const tol of TOLS) console.log('  ≤' + tol + 'px：改前 ' + rate(B, tol) + '　→ 改后 ' + rate(A, tol));
  console.log('  中心误差 改前：平均 ' + sb.mean.toFixed(2) + ' / p95 ' + sb.p95.toFixed(2) + ' / 最大 ' + sb.max.toFixed(2) + 'px');
  console.log('  中心误差 改后：平均 ' + sa.mean.toFixed(2) + ' / p95 ' + sa.p95.toFixed(2) + ' / 最大 ' + sa.max.toFixed(2) + 'px');
  console.log('  逐格（改前→改后）：' + rows.map((r) => r.id + ' ' + (r.before == null ? '无' : r.before.toFixed(1) + '→' + r.after.toFixed(1))).join('　'));
  const big = rows.filter((r) => r.before != null && r.before > 3);
  console.log('  ★超出 ±3px 窗、精配准管不了的用例（改前 >3px）：' + big.length + ' 个 → ' + big.map((r) => r.id + ' ' + r.before.toFixed(1) + 'px→' + r.after.toFixed(1) + 'px').join('　') + '★');
  fs.writeFileSync('C:/deepseek/gametest/refine2px.json', JSON.stringify({ at: new Date().toISOString(), n: B.length, before: sb, after: sa, rows }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/refine2px.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
