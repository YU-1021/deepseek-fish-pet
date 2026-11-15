/* score-step1.js —— ★第二张干净真实帧（step1.png 基地房间列表）的标注 + 评分（三方并列之一）★
 *
 * 标注口径（与合成屏一致 ✓ lead 定的）：**text 用 her OCR 词组框回填 ✓**，provenance 写清（工具/文件/运行 ✓）；
 *   ★限制照实写：这样得来的 text 真值只能量"locate 的框取与配对"✓ 不能量 OCR 准确率 ✗（循环 ✓）★。
 * 遮挡自检：已单独跑过 ✓（亮度 144.4 / 近黑 3.7% → 干净 ✓），这里再算一次留档 ✓。
 * 评分：≤6px 与 ≤2px 双口径 ✓（与合成屏同口径 ✓ 不合并 ✓）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const OC = require(path.join(APP, 'src/ownclick'));
const PE = require(path.join(APP, 'src/percept'));
const Jimp = require('jimp').Jimp;
const OUT = 'C:/deepseek/gametest';
const F = 'C:/deepseek/step1.png';
const OCRJ = path.join(OUT, 'real-step1.json');

(async () => {
  if (!fs.existsSync(F)) { console.log('缺帧 ' + F); process.exit(1); }
  if (!fs.existsSync(OCRJ)) { console.log('缺 OCR：' + OCRJ + '（先用 PowerShell 侧生成 ✓）'); process.exit(1); }
  const ocr = JSON.parse(fs.readFileSync(OCRJ, 'utf8').replace(/^\uFEFF/, ''));
  const img = await Jimp.fromBuffer(fs.readFileSync(F));
  /* 遮挡自检（留档 ✓） */
  let dark = 0, n = 0, sum = 0;
  for (let i = 0; i < img.bitmap.data.length; i += 4 * 53) { const l = 0.299 * img.bitmap.data[i] + 0.587 * img.bitmap.data[i + 1] + 0.114 * img.bitmap.data[i + 2]; sum += l; n++; if (l < 40) dark++; }
  console.log('=== step1（基地房间列表）=== 尺寸 ' + img.width + 'x' + img.height + '　OCR ' + (ocr.lines || []).length + ' 行 / '
    + (ocr.lines || []).reduce((a, L) => a + (L.words || []).length, 0) + ' 词　遮挡自检：平均亮度 ' + (sum / n).toFixed(1) + ' / 近黑 ' + (dark / n * 100).toFixed(1) + '% → '
    + (dark / n > 0.6 ? '★被遮挡✗★' : '✓ 干净 ✓'));

  /* 从 OCR 里挑"像房间名/面板标签"的词组当标注对象 ✓（真值=OCR 框本身 ✓ 循环真值，已声明 ✓） */
  const WORDS = ['会客室', '制造站', '贸易站', '发电站', '训练室', '加工站', '宿舍', '办公室', '控制中枢', '仓库'];
  const items = [];
  for (const w of WORDS) {
    const bx = OC.phrasesFromOcr(ocr, w);
    if (bx.length) items.push({ id: 'S' + (items.length + 1), label: w, x: bx[0].x, y: bx[0].y, w: bx[0].w, h: bx[0].h, n: bx.length });
  }
  console.log('标注（OCR 回填 ✓ 循环真值已声明 ✓）：' + items.length + ' 条 → ' + items.map((i) => i.label + (i.n > 1 ? '(×' + i.n + ')' : '')).join(' / '));
  if (!items.length) { console.log('没有可标对象 → 结束'); process.exit(0); }
  fs.writeFileSync(path.join(OUT, 'step1-truth.json'), JSON.stringify({
    frame: 'step1', file: F, categories: ['text'], provenance: '★OCR 词组框回填（ocr.ps1 → real-step1.json ✓ 本会话运行 ✓）；★只能量 locate 的框取/配对 ✓ 不能量 OCR 准确率 ✗（循环 ✓）★；遮挡自检：平均亮度 ' + (sum / n).toFixed(1) + ' / 近黑 ' + (dark / n * 100).toFixed(1) + '% ✓ 干净 ✓',
    items }, null, 2));

  /* 评分（与合成屏同口径 ✓ 双容差 ✓） */
  PE.install({
    capture: async () => ({ path: F }), ocrJson: async () => ocr,
    act: async () => { throw new Error('离线不点击 ✓'); }, vision: async () => '（离线）',
    space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }), shotDir: () => OUT,
  });
  const rows = [];
  for (const it of items) {
    const tx = it.x + Math.round(it.w / 2), ty = it.y + Math.round(it.h / 2);
    const loc = await PE.run('locate', it.label + '||img=' + F + '|region=' + [it.x, it.y, it.w, it.h].join(','));
    const m = /（中心 (-?\d+),(-?\d+)）/.exec(loc);
    const cx = m ? Number(m[1]) : null, cy = m ? Number(m[2]) : null;
    const d = cx == null ? null : Math.hypot(cx - tx, cy - ty);
    rows.push({ id: it.id, label: it.label, truth: { x: tx, y: ty }, got: { x: cx, y: cy }, d,
      v6: d != null && d <= 6, v2: d != null && d <= 2, amb: /ambiguous/.test(loc) });
  }
  const n6 = rows.filter((r) => r.v6).length, n2 = rows.filter((r) => r.v2).length;
  const ds = rows.filter((r) => r.d != null).map((r) => r.d).sort((a, b) => a - b);
  const st = ds.length ? { mean: ds.reduce((a, b) => a + b, 0) / ds.length, p95: ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))], max: ds[ds.length - 1] } : { mean: 0, p95: 0, max: 0 };
  console.log('  ★step1 结果（n=' + rows.length + ' ✓ 循环真值 ✓）：≤6px ' + n6 + '/' + rows.length + '　≤2px ' + n2 + '/' + rows.length
    + '　中心误差 平均 ' + st.mean.toFixed(2) + ' / p95 ' + st.p95.toFixed(2) + ' / 最大 ' + st.max.toFixed(2) + 'px★');
  console.log('  逐条：' + rows.map((r) => r.id + '「' + r.label + '」' + (r.d == null ? '未定位' : r.d.toFixed(1) + 'px' + (r.amb ? '(ambiguous)' : ''))).join('　'));
  console.log('');
  console.log('=== ★三方并列（不合并、不平均 ✓）★ ===');
  console.log('  ① 合成屏（Chrome 渲染 render.html，204 次判定 ✓）：总分 80.4%（text 78.6 / dup 100 / icon 93.3 / small+edge 50.0）；★icon 类 ≤2px = 90.0%(27/30)★');
  console.log('  ② step1 真机帧（房间列表 ✓ 循环 text 真值 ✓ n=' + rows.length + '）：≤6px ' + n6 + '/' + rows.length + '；≤2px ' + n2 + '/' + rows.length);
  console.log('  ③ 真机职业列（★暂停✗★：真值互证 113.8 vs 115.9 差 2.1px 未过 + 原帧被遮挡 75.5% ✓ 精度数字待补 ✓）');
  fs.writeFileSync(path.join(OUT, 'step1-score.json'), JSON.stringify({ at: new Date().toISOString(), occlusion: { mean: sum / n, dark: dark / n }, n: rows.length, le6: n6, le2: n2, stat: st, rows }, null, 2));
  console.log('  明细落盘：' + path.join(OUT, 'step1-score.json'));
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
