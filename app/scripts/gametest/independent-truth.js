/* independent-truth.js —— ★用 icon_lib 的**职业列模板**匹配峰值位置当独立真值（与 gridcount/lattice 无关 ✓）★
 * 口径（lead 定的 ✓）：① 每个模板在真机列带内滑窗匹配 → 取**峰值位置**当真值 ✓ 写 provenance（模板名/分数/峰位 ✓）
 *   ② 测 snap=1 的格心 vs 独立真值（≤2px/≤6px + 中心误差 + n ✓）③ 测默认（snap 关）作对照 ✓
 *   ④ 与"间距 116.0 vs 独立 115.9 = 0.1px"那条旁证对看是否自洽 ✓
 * 匹配：luma 上的 SSD（归一化 ✓），x 在 1795~1905 步 10、y 在带内步 2 ✓（确定性 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const IC = require(path.join(APP, 'src/iconcut'));
const Jimp = require('jimp').Jimp;
const F = (process.argv.find((a) => a.startsWith('--frame=')) || '').split('=')[1] || 'C:/deepseek/realclass/class-column-clean.png';
const TD = path.join(process.env.APPDATA, 'dayu-pet', 'templates');
const BAND = { x0: 1770, y0: 40, x1: 1919, y1: 1040 };

(async () => {
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const frame = await Jimp.fromBuffer(fs.readFileSync(F));
  const fl = IC.lumaFromJimp(frame);
  const W = frame.width, H = frame.height;
  const names = fs.readdirSync(TD).filter((f) => /\.png$/i.test(f) && /职业/.test(f)).sort();
  const peaks = [];
  for (const n of names) {
    const t = await Jimp.fromBuffer(fs.readFileSync(path.join(TD, n)));
    if (t.width < 12 || t.height < 12) continue;
    const tl = IC.lumaFromJimp(t);
    let best = { s: Infinity, x: 0, y: 0 };
    for (let x = 1795; x <= 1905; x += 10) {
      for (let y = BAND.y0; y + t.height <= BAND.y1; y += 2) {
        let s = 0;
        for (let dy = 0; dy < t.height; dy += 2) {
          for (let dx = 0; dx < t.width; dx += 2) {
            const a = tl[dy * t.width + dx], b = fl[(y + dy) * W + (x + dx)];
            s += (a - b) * (a - b);
          }
        }
        if (s < best.s) best = { s, x, y };
      }
    }
    const score = 1 - best.s / (255 * 255 * (t.width * t.height) / 4);
    peaks.push({ template: n, x: best.x + Math.round(t.width / 2), y: best.y + Math.round(t.height / 2), score: Number(score.toFixed(3)), tw: t.width, th: t.height });
  }
  console.log('=== 独立真值（icon_lib 职业列模板匹配峰 ✓ 与 gridcount 无关 ✓）===');
  console.log('  provenance：' + peaks.map((p) => p.template.replace('明日方舟-', '').replace('.png', '') + '@y' + p.y + '(score ' + p.score + ', ' + p.tw + 'x' + p.th + ')').join('　'));
  /* 去重：峰位相差 ≤6px 视为同一行 ✓ */
  const uniq = [];
  peaks.slice().sort((a, b) => a.y - b.y).forEach((p) => { if (!uniq.find((u) => Math.abs(u.y - p.y) <= 6)) uniq.push(p); });
  console.log('  独立真值行数 n=' + uniq.length + '（峰位去重后 ✓）：' + uniq.map((u) => u.y).join(','));
  if (!uniq.length) { console.log('★没匹配到任何模板 → 独立真值不成立 ✗ 结论保持"不可用"✗★'); process.exit(0); }

  /* 两组格心：snap=1 与默认 ✓ */
  const run = async (snap) => {
    const r = await IC.scan(F, { mode: 'a', region: BAND, dir: 'v', expect: 9, snap: snap ? 1 : 0 });
    return r.items.map((i) => i.cy).sort((a, b) => a - b);
  };
  const sets = { 'snap=1': await run(1), '默认(snap关)': await run(0) };
  for (const [tag, cs] of Object.entries(sets)) {
    const errs = []; const per = { 2: 0, 6: 0 };
    for (const u of uniq) {
      const near = cs.map((c) => ({ c, d: Math.abs(c - u.y) })).sort((a, b) => a.d - b.d)[0];
      if (!near) continue;
      errs.push(near.d);
      if (near.d <= 2) per[2]++;
      if (near.d <= 6) per[6]++;
    }
    const ds = errs.slice().sort((a, b) => a - b);
    const st = ds.length ? { mean: ds.reduce((a, b) => a + b, 0) / ds.length, p95: ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))], max: ds[ds.length - 1] } : { mean: 0, p95: 0, max: 0 };
    console.log('  ' + tag.padEnd(12) + '（检出 ' + cs.length + ' 项）：≤2px ' + per[2] + '/' + uniq.length + '　≤6px ' + per[6] + '/' + uniq.length
      + '　中心误差 平均 ' + st.mean.toFixed(2) + ' / p95 ' + st.p95.toFixed(2) + ' / 最大 ' + st.max.toFixed(2) + 'px　逐项误差 ' + errs.map((e) => e.toFixed(1)).join(','));
  }
  const sp = await IC.scan(F, { mode: 'a', region: BAND, dir: 'v', expect: 9, snap: 1 });
  const spGaps = []; const cs = sp.items.map((i) => i.cy).sort((a, b) => a - b);
  for (let i = 1; i < cs.length; i++) spGaps.push(cs[i] - cs[i - 1]);
  console.log('  自洽性对照：snap=1 间距中位 ' + (spGaps.length ? spGaps.slice().sort((a, b) => a - b)[Math.floor(spGaps.length / 2)] : '?') + 'px vs 早先独立旁证 115.9px（差 0.1px 那条 ✓）');
  fs.writeFileSync('C:/deepseek/gametest/independent-truth.json', JSON.stringify({ at: new Date().toISOString(), frame: F, peaks, uniq, sets }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/independent-truth.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
