/* zoomocr.js —— ★裁剪 + 放大 2~3 倍再 OCR：整屏 OCR vs 裁剪放大 OCR 的**逐字正确率**对比★
 * （主人的原话"图标里有文字再让 OCR 识别"的正确形态 ✓；也是 small/edge 类读不出的直接解法 ✓）
 *
 * 两阶段（★本会话里 Node→PowerShell spawn 不可靠 ✗，所以拆开✗→✓★）：
 *   A) node zoomocr.js --crops  → 从帧里按 layout.js 真值裁出每格，放大 3 倍，写成 PNG（C:\deepseek\gametest\crops\）
 *   B) PowerShell 批量 OCR 那些 crop → 每格一个 JSON
 *   C) node zoomocr.js --score → 比"整屏 OCR 的文本"与"裁剪放大 OCR 的文本"哪个更接近真值标签（逐字正确率 ✓）
 * ★判定用真值标签 = layout.js（真值唯一来源 ✓）；坐标一律不用 OCR（避免自证 ✗）★
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./layout');

const OUT = 'C:/deepseek/gametest';
const CROPS = path.join(OUT, 'crops');
const argv = process.argv.slice(2);
const MODE = argv[0] || '--crops';
const FRAME = (argv.find((a) => a.startsWith('--frame=')) || '').split('=')[1] || path.join(OUT, 'frames', 'f000.png');
const FACTOR = Number((argv.find((a) => a.startsWith('--factor=')) || '--factor=3').split('=')[1]);

function normC(s) { return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }
/* 逐字正确率（带顺序的编辑距离 ✓）：1 - Levenshtein(a,b)/max(len) ✓ */
function charAcc(truth, got) {
  const a = normC(truth), b = normC(got);
  if (!a.length) return 0;
  const n = a.length, m = b.length;
  let prev = new Array(m + 1).fill(0).map((_, j) => j), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    const t = prev; prev = cur; cur = t;
  }
  return Math.max(0, 1 - prev[m] / Math.max(n, m));
}
/* 整屏 OCR 的文本里，哪个"行"最像这个标签 ✓ */
function bestLineText(ocr, label) {
  let best = '', bestA = 0;
  for (const L2 of (ocr.lines || [])) {
    const t = String(L2.text || '');
    const a = charAcc(label, normC(t));
    if (a > bestA) { bestA = a; best = t; }
  }
  return { text: normC(best), acc: bestA };
}

(async () => {
  const Jimp = require('jimp').Jimp;
  if (MODE === '--crops') {
    fs.mkdirSync(CROPS, { recursive: true });
    const img = await Jimp.fromBuffer(fs.readFileSync(FRAME));
    let n = 0;
    for (const b of L.buttons) {
      if (!b.label) continue;                       // 纯图形没有文字 ✓ 不在这一项里
      const x = Math.max(0, b.x - 4), y = Math.max(0, b.y - 4);
      const w = Math.min(img.width - x, b.w + 8), h = Math.min(img.height - y, b.h + 8);
      if (w < 4 || h < 4) continue;
      const crop = img.clone().crop({ x, y, w, h });
      crop.resize({ w: Math.round(w * FACTOR), h: Math.round(h * FACTOR) });
      fs.writeFileSync(path.join(CROPS, b.id + '.png'), await crop.getBuffer('image/png'));
      n++;
    }
    console.log('已裁出并放大 ×' + FACTOR + '：' + n + ' 格 → ' + CROPS);
    process.exit(0);
  }

  if (MODE === '--score') {
    const full = JSON.parse(fs.readFileSync(path.join(OUT, 'frames/ocr/ocr-f000.json'), 'utf8').replace(/^\uFEFF/, ''));
    const rows = [];
    const TARGET_CLASSES = ['text', 'small', 'edge'];
    for (const b of L.buttons) {
      if (!b.label || TARGET_CLASSES.indexOf(b.kind) < 0) continue;
      const cropJson = path.join(CROPS, b.id + '.json');
      let got = '', ok = false;
      if (fs.existsSync(cropJson)) {
        try { const j = JSON.parse(fs.readFileSync(cropJson, 'utf8').replace(/^\uFEFF/, '')); got = normC(j.text || ''); ok = true; } catch (e) {}
      }
      const fullBest = bestLineText(full, b.label);
      rows.push({
        id: b.id, kind: b.kind, label: b.label,
        fullAcc: fullBest.acc, fullRead: fullBest.text,
        zoomAcc: ok ? charAcc(b.label, got) : null, zoomRead: got, zoomOk: ok,
      });
    }
    const cls = {};
    for (const r of rows) {
      const k = r.kind === 'edge' ? 'small+edge' : (r.kind === 'small' ? 'small+edge' : 'text');
      cls[k] = cls[k] || { n: 0, full: 0, zoom: 0, fullExact: 0, zoomExact: 0 };
      const c = cls[k]; c.n++;
      c.full += r.fullAcc; c.zoom += (r.zoomAcc == null ? 0 : r.zoomAcc);
      if (r.fullAcc >= 0.999) c.fullExact++;
      if (r.zoomAcc != null && r.zoomAcc >= 0.999) c.zoomExact++;
    }
    console.log('=== 逐字正确率：整屏 OCR vs 裁剪放大（×3）OCR（真值 = layout.js 标签 ✓）===');
    for (const k of Object.keys(cls)) {
      const c = cls[k];
      console.log('  ' + k.padEnd(11) + '格数 ' + String(c.n).padStart(3)
        + '　整屏 平均 ' + (c.full / c.n * 100).toFixed(1) + '%（完全正确 ' + c.fullExact + '/' + c.n + '）'
        + '　裁剪放大 平均 ' + (c.zoom / c.n * 100).toFixed(1) + '%（完全正确 ' + c.zoomExact + '/' + c.n + '）');
    }
    const a = rows.reduce((s, r) => s + r.fullAcc, 0) / (rows.length || 1);
    const b2 = rows.reduce((s, r) => s + (r.zoomAcc == null ? 0 : r.zoomAcc), 0) / (rows.length || 1);
    console.log('  ★合计 ' + rows.length + ' 格：整屏 ' + (a * 100).toFixed(1) + '%　→　裁剪放大 ' + (b2 * 100).toFixed(1) + '%★');
    console.log('  ★仍然读不全的（裁剪放大后 <100%）：' + rows.filter((r) => r.zoomAcc != null && r.zoomAcc < 0.999)
      .slice(0, 8).map((r) => r.id + '「' + r.label + '」→「' + r.zoomRead + '」' + (r.zoomAcc * 100).toFixed(0) + '%').join('　') + '★');
    fs.writeFileSync(path.join(OUT, 'zoomocr.json'), JSON.stringify({ at: new Date().toISOString(), factor: FACTOR, cls, rows }, null, 2));
    console.log('  明细已落盘：' + path.join(OUT, 'zoomocr.json'));
    process.exit(0);
  }
  console.log('用法：node zoomocr.js --crops | --score');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
