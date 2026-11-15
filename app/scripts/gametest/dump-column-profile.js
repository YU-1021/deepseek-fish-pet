/* dump-column-profile.js —— ★把真机列那一带的能量曲线与峰位 dump 出来（lead 要看原始曲线）★
 * 输出：C:\deepseek\gametest\column-profile.json（逐行 y 的投影能量 + 峰位 + 峰间距 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const IC = require(path.join(APP, 'src/iconcut'));
const GC = require(path.join(APP, 'src/gridcount'));
const Jimp = require('jimp').Jimp;
const F = (process.argv.find((a) => a.startsWith('--frame=')) || '').split('=')[1] || 'C:/deepseek/realclass/class-column-clean.png';
const BAND = { x0: 1770, y0: 40, x1: 1919, y1: 1040 };

(async () => {
  const img = await Jimp.fromBuffer(fs.readFileSync(F));
  const luma = IC.lumaFromJimp(img);
  const E = GC.multiScaleEnergy(luma, img.width, img.height, 5, 15);
  const prof = [];
  for (let y = BAND.y0; y <= BAND.y1; y++) {
    let s = 0;
    for (let x = BAND.x0; x <= BAND.x1; x++) s += E[y * img.width + x];
    prof.push({ y, e: s });
  }
  const mx = Math.max.apply(null, prof.map((p) => p.e)), mn = Math.min.apply(null, prof.map((p) => p.e));
  const thr = mn + (mx - mn) * 0.35;
  const peaks = [];
  let run = null;
  prof.forEach((p) => {
    if (p.e > thr) { if (!run) run = { a: p.y, b: p.y }; else run.b = p.y; }
    else if (run) { peaks.push({ y: Math.round((run.a + run.b) / 2), width: run.b - run.a + 1 }); run = null; }
  });
  if (run) peaks.push({ y: Math.round((run.a + run.b) / 2), width: run.b - run.a + 1 });
  const gaps = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i].y - peaks[i - 1].y);
  console.log('=== 真机列能量曲线 dump（帧 ' + path.basename(F) + ' 带 y ' + BAND.y0 + '~' + BAND.y1 + ' ✓）===');
  console.log('  峰位 y：' + peaks.map((p) => p.y).join(',') + '（共 ' + peaks.length + ' 个峰 ✓）');
  console.log('  峰宽：' + peaks.map((p) => p.width).join(',') + '　峰间距：' + gaps.join(',') + '　平均峰间距 ' + (gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : '?') + 'px（真值间距 115.9 ✓）');
  console.log('  阈值 ' + thr.toFixed(3) + '（= min + 0.35×(max−min) ✓ 确定性 ✓）　能量范围 ' + mn.toFixed(1) + '~' + mx.toFixed(1));
  fs.writeFileSync('C:/deepseek/gametest/column-profile.json', JSON.stringify({ frame: F, band: BAND, thr, peaks, gaps, prof }, null, 2));
  console.log('  曲线与峰位已落盘：C:/deepseek/gametest/column-profile.json（' + prof.length + ' 个采样点 ✓）');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
