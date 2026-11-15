/* reconcile.js —— ★两边数字差得极远：逐项对比取证（偏移/词集/像素差）★
 * A = lead 的帧与 OCR：C:\deepseek\gametest\frames\fNNN.png + C:\deepseek\gametest\ocr\ocr-fNNN.json
 * B = 我（Chrome 从 render.html 渲染）的 OCR：C:\deepseek\gametest\frames\ocr\ocr-fNNN.json + 现场重渲染的 PNG
 * 判定"布局是否被整体平移"：用**已知位置的锚点**（E-TL 在 (0,0,90,36)、E-BR 在 (1830,1044)、S1 在 (1000,100) ✓）
 * 量 它们在两边的中心差 → 位移量 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./layout');
const OC = require('../../src/ownclick');
const normOC = OC.phrasesFromOcr;

const G = 'C:/deepseek/gametest';
const AOCR = path.join(G, 'ocr/ocr-f000.json');            // lead 的
const BOCR = path.join(G, 'frames/ocr/ocr-f000.json');     // 我的
const APNG = path.join(G, 'frames/f000.png');

function load(p) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : null; }
const A = load(AOCR), B = load(BOCR);
if (!A) { console.log('缺 lead 的 OCR：' + AOCR); process.exit(1); }
console.log('=== 0. 两份 OCR 的规模 ===');
console.log('  lead：图 ' + A.imgW + 'x' + A.imgH + '　行 ' + (A.lines || []).length + '　词 ' + (A.lines || []).reduce((n, l) => n + (l.words || []).length, 0));
if (B) console.log('  我  ：图 ' + B.imgW + 'x' + B.imgH + '　行 ' + (B.lines || []).length + '　词 ' + (B.lines || []).reduce((n, l) => n + (l.words || []).length, 0));
else console.log('  （我那份 OCR 已被覆盖 ✗ 用重渲染再算 ✓）');

/* 锚点位移：拿 layout 里**位置已知**的几个标签，在两边找它的框中心 → 位移 */
const ANCH = [
  { id: 'B001', label: '编辑队列' }, { id: 'B002', label: '进驻信息' },
  { id: 'B008', label: '发电站' }, { id: 'B015', label: '干员信息' },
  { id: 'B057', label: 'E-TL' }, { id: 'B060', label: 'E-BR' },
  { id: 'B085', label: 'S1' },
];
function centers(ocr, label) {
  const boxes = normOC(ocr, label);
  return boxes.map((b) => ({ cx: b.cx, cy: b.cy }));
}
console.log('');
console.log('=== 1. 锚点位移（lead 的帧 vs layout 真值；再 vs 我的帧）===');
for (const a of ANCH) {
  const t = L.buttons.find((b) => b.id === a.id);
  if (!t) continue;
  const tt = { cx: t.x + Math.round(t.w / 2), cy: t.y + Math.round(t.h / 2) };
  const ca = centers(A, a.label)[0];
  const cb = B ? centers(B, a.label)[0] : null;
  const fmt = (c) => (c ? '(' + c.cx + ',' + c.cy + ') Δ=(' + (c.cx - tt.cx) + ',' + (c.cy - tt.cy) + ')' : '（无）');
  console.log('  ' + a.id + '「' + a.label + '」真值 ' + JSON.stringify(tt) + '　lead ' + fmt(ca) + '　我 ' + fmt(cb));
}

/* 词集差异（归一化后的整行文本） */
console.log('');
console.log('=== 2. 词集差异（整行文本，归一化后）===');
const rowsA = new Set((A.lines || []).map((l) => OC.normTxt(l.text)));
const rowsB = B ? new Set((B.lines || []).map((l) => OC.normTxt(l.text))) : new Set();
const onlyA = [...rowsA].filter((t) => t && !rowsB.has(t));
const onlyB = [...rowsB].filter((t) => t && !rowsA.has(t));
console.log('  lead 独有 ' + onlyA.length + ' 行：' + onlyA.slice(0, 12).join(' ｜ '));
if (B) console.log('  我独有 ' + onlyB.length + ' 行：' + onlyB.slice(0, 12).join(' ｜ '));
/* 必须命中的锚点词（layout.js 里的宽泛词） */
const ANCHOR_WORDS = ['编辑队列', '进驻信息', '设施信息', '控制中枢', '会客室', '制造站', '贸易站', '发电站', '训练室', '宿舍'];
console.log('');
console.log('=== 3. 帧合格性自检（锚点词命中数 / 布局行数）===');
for (const [tag, ocr] of [['lead', A], ['我', B]]) {
  if (!ocr) continue;
  const hay = (ocr.lines || []).map((l) => OC.normTxt(l.text)).join('|');
  const hit = ANCHOR_WORDS.filter((w) => hay.indexOf(OC.normTxt(w)) >= 0);
  const words = (ocr.lines || []).reduce((n, l) => n + (l.words || []).length, 0);
  console.log('  ' + tag + '：锚点词命中 ' + hit.length + '/' + ANCHOR_WORDS.length + '（' + hit.join(',') + '）　词数 ' + words);
}
/* 像素差（若 lead 的 PNG 在 ✓） */
if (APNG && fs.existsSync(APNG)) {
  console.log('');
  console.log('=== 4. lead 帧的像素统计（看是不是"别的东西"）===');
  const Jimp = require('jimp').Jimp;
  Jimp.fromBuffer(fs.readFileSync(APNG)).then((img) => {
    let dark = 0, n = 0, sum = 0;
    const d = img.bitmap.data;
    for (let i = 0; i < d.length; i += 4 * 97) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += l; n++; if (l < 60) dark++; }
    console.log('  尺寸 ' + img.width + 'x' + img.height + '　平均亮度 ' + (sum / n).toFixed(1) + '　暗像素占比 ' + (dark / n * 100).toFixed(1) + '%'
      + '（我的渲染：浅底 #f2f2f2 ✓ 平均亮度应 ~230 ✓ 暗像素很少 ✓）');
  });
}
