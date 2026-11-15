/* row-truth.js —— ★行级独立真值（9 行具名模板 + 三条独立约束 ✓ 与 lattice/gridcount 无关）★
 * ① 行位置来源：**列带纵向能量投影 + 独立的 (pitch,phase) 对齐搜索**（pitch 60~160px 步 0.5、相位步 1px，
 *    目标 = 预测行心处能量均值最大 ✓）—— 这条是我自己写的独立量法 ✓，**不用 gridcount/lattice** ✓。
 * ② 按已知权威顺序命名裁剪：职业行01_ALL … 职业行09_特种 ✓（模板存 C:\deepseek\realclass\rowtpl\ ✓ 不动她的模板库 ✓）。
 * ③ 三条独立约束（lead 定的 ✓ 不放水 ✓）：a) 每个模板在自己那行得分最高 ✓
 *    b) 领先次优 ≥ 0.06 且自身分 ≥ 0.92 ✓  c) 9 个模板的最高分行序与已知顺序完全一致 ✓
 * ④ 用通过的行当独立真值，裁定 snap=1 与默认两组格心 ✓（≤2px / ≤6px + 中心误差 + n ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const IC = require(path.join(APP, 'src/iconcut'));
const Jimp = require('jimp').Jimp;
const F = 'C:/deepseek/realclass/class-column-clean.png';
const BAND = { x0: 1770, y0: 40, x1: 1919, y1: 1040 };
const NAMES = ['ALL', '先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const TDIR = 'C:/deepseek/realclass/rowtpl';
const CROP_W = 76, CROP_H = 76;      // 一行一个正方形块 ✓（覆盖图标本身 ✓）

(async () => {
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const img = await Jimp.fromBuffer(fs.readFileSync(F));
  const luma = IC.lumaFromJimp(img);
  const W = img.width;
  fs.mkdirSync(TDIR, { recursive: true });

  /* ① 独立量行位置：(pitch, phase) 对齐搜索（不用 gridcount ✓） */
  const E = [];
  for (let y = BAND.y0; y <= BAND.y1; y++) { let s = 0; for (let x = BAND.x0; x <= BAND.x1; x++) s += luma[y * W + x]; E.push(s); }
  const mean = E.reduce((a, b) => a + b, 0) / E.length;
  const A = E.map((v) => v - mean);
  const strength = (p, ph) => { let s = 0, c = 0; for (let k = 0; ; k++) { const i = Math.round(ph + k * p); if (i >= A.length) break; if (i >= 0) { s += A[i]; c++; } } return c >= 3 ? s / c : -Infinity; };
  let best = { p: 0, ph: 0, s: -Infinity };
  for (let p = 60; p <= 160; p += 0.5) for (let ph = 0; ph < p; ph += 1) { const v = strength(p, ph); if (v > best.s) best = { p, ph, s: v }; }
  const rows = [];
  for (let k = 0; k < 9; k++) rows.push(BAND.y0 + Math.round(best.ph + k * best.p));
  console.log('=== ① 行位置（独立对齐搜索 ✓ 不用 gridcount ✓）===');
  console.log('  pitch=' + best.p.toFixed(1) + 'px（独立旁证 115.9 ✓）　phase=' + Math.round(best.ph) + 'px　行心 y：' + rows.join(','));

  /* ② 按权威顺序裁剪命名模板 ✓ */
  const tpl = [];
  for (let i = 0; i < 9; i++) {
    const y = Math.max(0, Math.min(img.height - CROP_H, rows[i] - Math.round(CROP_H / 2)));
    const x = Math.max(0, Math.min(img.width - CROP_W, 1810 - Math.round(CROP_W / 2)));
    const c = img.clone().crop({ x, y, w: CROP_W, h: CROP_H });
    const name = '职业行' + String(i + 1).padStart(2, '0') + '_' + NAMES[i];
    fs.writeFileSync(path.join(TDIR, name + '.png'), await c.getBuffer('image/png'));
    tpl.push({ name, idx: i, y: y + Math.round(CROP_H / 2), luma: IC.lumaFromJimp(c), w: CROP_W, h: CROP_H });
  }
  console.log('  已存 9 个具名模板 → ' + TDIR + '（' + tpl.map((t) => t.name).join(', ') + '）');

  /* ③ 三条独立约束 */
  const score = (a, b, ax, ay, bx, by) => {   // 归一化 SSD → 相似度
    let s = 0, n = 0;
    for (let dy = 0; dy < CROP_H; dy += 2) for (let dx = 0; dx < CROP_W; dx += 2) { const d = a[dy * CROP_W + dx] - b[(by + dy) * W + (bx + dx)]; s += d * d; n++; }
    return 1 - (s / n) / (255 * 255);
  };
  const results = [];
  for (const t of tpl) {
    const scores = [];
    for (let y = BAND.y0; y + CROP_H <= BAND.y1; y += 2) scores.push({ y: y + Math.round(CROP_H / 2), s: score(t.luma, luma, 0, 0, 1795 + 15, y) });
    scores.sort((a, b) => b.s - a.s);
    const top = scores[0], second = scores[1];
    const argmaxRow = rows.map((r, i) => ({ i, d: Math.abs(r - top.y) })).sort((a, b) => a.d - b.d)[0];
    results.push({ name: t.name, idx: t.idx, peak: top.y, score: Number(top.s.toFixed(3)), second: Number(second.s.toFixed(3)),
      margin: Number((top.s - second.s).toFixed(3)), argmaxRow: argmaxRow ? argmaxRow.i : -1, rowDist: argmaxRow ? argmaxRow.d : 999 });
  }
  console.log('');
  console.log('=== ③ 三条独立约束 ===');
  results.forEach((r) => console.log('  ' + r.name + '：峰 y=' + r.peak + '（score ' + r.score + '，次优 ' + r.second + '，领先 ' + r.margin + '）→ 最强行序 ' + (r.argmaxRow + 1) + '（距本行 ' + r.rowDist + 'px）'));
  const cA = results.every((r) => r.argmaxRow === r.idx);
  const cB = results.every((r) => r.score >= 0.92 && r.margin >= 0.06);
  const cC = results.map((r) => r.argmaxRow).join(',') === results.map((r) => r.idx).join(',');
  console.log('  a) 每个模板在自己那行得分最高：' + (cA ? '满足 ✓' : '★不满足✗：' + results.filter((r) => r.argmaxRow !== r.idx).map((r) => r.name + '→行' + (r.argmaxRow + 1)).join('，') + '★'));
  console.log('  b) 自身分 ≥0.92 且领先 ≥0.06：' + (cB ? '满足 ✓' : '★不满足✗：' + results.filter((r) => !(r.score >= 0.92 && r.margin >= 0.06)).map((r) => r.name + '(分' + r.score + '/领先' + r.margin + ')').join('，') + '★'));
  console.log('  c) 9 个最高分行序与已知顺序完全一致：' + (cC ? '满足 ✓' : '★不满足✗（得到 ' + results.map((r) => r.argmaxRow + 1).join(',') + ' ✓）★'));
  const okRows = cA && cC ? results.filter((r) => r.score >= 0.92 && r.margin >= 0.06) : results.filter((r) => r.argmaxRow === r.idx && r.score >= 0.92 && r.margin >= 0.06);
  const truth = okRows.map((r) => ({ row: r.idx + 1, name: NAMES[r.idx], y: r.peak, score: r.score, margin: r.margin }));
  console.log('  ★可用行（三条全过）n=' + truth.length + '/9★' + (truth.length ? '：' + truth.map((t) => '行' + String(t.row).padStart(2, '0') + '_' + t.name + '@y' + t.y).join('　') : '（无 ✓ 不凑 ✗）'));

  /* ④ 裁定格距法 */
  const run = async (snap) => (await IC.scan(F, { mode: 'a', region: BAND, dir: 'v', expect: 9, snap: snap ? 1 : 0 })).items.map((i) => i.cy).sort((a, b) => a - b);
  if (truth.length) {
    console.log('');
    console.log('=== ④ 格距法 vs 行级独立真值（n=' + truth.length + ' ✓）===');
    for (const [tag, snap] of [['snap=1', 1], ['默认(snap关)', 0]]) {
      const cs = await run(snap);
      const errs = []; let p2 = 0, p6 = 0;
      for (const t of truth) {
        const near = cs.map((c) => ({ c, d: Math.abs(c - t.y) })).sort((a, b) => a.d - b.d)[0];
        if (!near) continue;
        errs.push(near.d); if (near.d <= 2) p2++; if (near.d <= 6) p6++;
      }
      const ds = errs.slice().sort((a, b) => a - b);
      const st = ds.length ? { mean: ds.reduce((a, b) => a + b, 0) / ds.length, p95: ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))], max: ds[ds.length - 1] } : { mean: 0, p95: 0, max: 0 };
      console.log('  ' + tag.padEnd(12) + '（检出 ' + cs.length + ' 项）：≤2px ' + p2 + '/' + truth.length + '　≤6px ' + p6 + '/' + truth.length
        + '　中心误差 平均 ' + st.mean.toFixed(2) + ' / p95 ' + st.p95.toFixed(2) + ' / 最大 ' + st.max.toFixed(2) + 'px　逐项 ' + errs.map((e) => e.toFixed(1)).join(','));
    }
  } else console.log('★没有可用行 → 无法裁定 ✗ 维持"不可用"✓（不凑 ✗）★');
  fs.writeFileSync('C:/deepseek/gametest/row-truth.json', JSON.stringify({ at: new Date().toISOString(), align: { pitch: best.p, phase: best.ph }, rows, results, constraints: { a: cA, b: cB, c: cC }, truth }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/row-truth.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
