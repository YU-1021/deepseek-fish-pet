/* indep-nearguard.js —— 用先验过位置的「职业3近卫」模板做非循环验证 + 由峰位差估整列 pitch ✓
 * ① 近卫模板在干净帧上的峰位/分数/领先次优 ✓ ② 与现有 9 个具名行模板一起匹配，报各自最高分行与分数 ✓
 * ③ pitch **只由模板峰位差估**（不用 gridcount ✓）：k 行 y = y_近卫 + (k−2)×pitch ✓ 给 pitch 与残差 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const IC = require(path.join(APP, 'src/iconcut'));
const Jimp = require('jimp').Jimp;
const F = 'C:/deepseek/realclass/class-column-clean.png';
const BAND = { x0: 1770, y0: 40, x1: 1919, y1: 1040 };
const TD = path.join(process.env.APPDATA, 'dayu-pet', 'templates');
const ROWDIR = 'C:/deepseek/realclass/rowtpl';
const NAMES = ['ALL', '先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];

function match(tl, tw, th, fl, W) {
  let best = { s: -Infinity, x: 0, y: 0 }, second = -Infinity;
  for (let x = 1795; x + tw <= 1919; x += 5) {
    for (let y = BAND.y0; y + th <= BAND.y1; y += 2) {
      let d = 0, n = 0;
      for (let dy = 0; dy < th; dy += 2) for (let dx = 0; dx < tw; dx += 2) { const a = tl[dy * tw + dx], b = fl[(y + dy) * W + (x + dx)]; d += (a - b) * (a - b); n++; }
      const s = 1 - (d / n) / (255 * 255);
      if (s > best.s) { second = best.s; best = { s, x: x + Math.round(tw / 2), y: y + Math.round(th / 2) }; }
      else if (s > second) second = s;
    }
  }
  return { ...best, margin: best.s - second };
}

(async () => {
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const img = await Jimp.fromBuffer(fs.readFileSync(F));
  const fl = IC.lumaFromJimp(img), W = img.width;
  const files = [];
  const ng = path.join(TD, '明日方舟-职业3近卫.png');
  if (fs.existsSync(ng)) files.push({ tag: '职业3近卫(先验过位置 ✓)', p: ng });
  if (fs.existsSync(ROWDIR)) fs.readdirSync(ROWDIR).filter((f) => /\.png$/i.test(f)).sort().forEach((f) => files.push({ tag: '行模板 ' + f.replace('.png', ''), p: path.join(ROWDIR, f) }));
  const res = [];
  for (const f of files) {
    const t = await Jimp.fromBuffer(fs.readFileSync(f.p));
    const m = match(IC.lumaFromJimp(t), t.width, t.height, fl, W);
    res.push({ tag: f.tag, file: f.p, tw: t.width, th: t.height, ...m });
  }
  console.log('=== ① 近卫模板 + 现有行模板匹配（干净帧 ✓）===');
  res.forEach((r) => console.log('  ' + r.tag.padEnd(24) + '峰 (' + r.x + ',' + r.y + ')　分数 ' + r.s.toFixed(3) + '　领先次优 ' + r.margin.toFixed(3) + '　(' + r.tw + 'x' + r.th + ')'));
  /* ③ pitch 只由峰位差估 ✓ */
  const ng2 = res.find((r) => /近卫/.test(r.tag));
  const line = [];
  if (ng2) for (const r of res) { if (r === ng2) continue; const k = r.tag.match(/(\d\d)_/) ? Number(r.tag.match(/(\d\d)_/)[1]) - 1 : null; if (k == null) continue; const p = (r.y - ng2.y) / (k - 2); line.push({ tag: r.tag, k, y: r.y, pitch: p }); }
  console.log('');
  console.log('=== ③ 由峰位差估 pitch（不用 gridcount ✓；近卫是第 3 行 k=2 ✓）===');
  line.forEach((l) => console.log('  ' + l.tag + '（第 ' + (l.k + 1) + ' 行 k=' + l.k + '）y=' + l.y + ' → pitch=(y−y近卫)/(k−2)=' + l.pitch.toFixed(1) + 'px'));
  const ps = line.map((l) => l.pitch).filter((p) => isFinite(p) && p > 30);
  if (ps.length) {
    const med = ps.slice().sort((a, b) => a - b)[Math.floor(ps.length / 2)];
    const resid = ps.map((p) => Math.abs(p - med));
    console.log('  ★估出 pitch = ' + med.toFixed(1) + 'px（中位 ✓）　残差 最大 ' + Math.max.apply(null, resid).toFixed(1) + 'px / 平均 ' + (resid.reduce((a, b) => a + b, 0) / resid.length).toFixed(1) + 'px★');
    console.log('  内部一致判定（残差 ≤6px 才认 ✓ 不放水 ✓）：' + (Math.max.apply(null, resid) <= 6 ? '★一致 → 可作行级独立真值 ✓★' : '★不一致✗ → 仍无独立真值 ✓ 维持"不可用"✓★'));
  } else console.log('  ★峰位差不够 → 估不出 pitch → 仍无独立真值 ✓（不凑 ✓）★');
  fs.writeFileSync('C:/deepseek/gametest/indep-nearguard.json', JSON.stringify({ at: new Date().toISOString(), frame: F, res, line }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/indep-nearguard.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
