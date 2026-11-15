/* lattice-small.js —— ★small+edge 改走"格距+相位"（不再用整帧连通域+最近邻 ✗）★
 * 做法（全部确定性 ✓ 不读任何小字 ✓）：
 *   ① 在被测区域上跑 gridcount 的横/纵两遍：横向拿**列距+相位** ✓、纵向拿**行距+相位** ✓
 *   ② 网格 = 列中心 × 行中心（叉积 ✓）→ 逐格中心 ✓
 *   ③ 真值框配给最近网格点，≤ 容差算命中 ✓
 * 用法：node lattice-small.js --frames=<目录> --ocrDir=<每帧 OCR 目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const GC = require('../../src/gridcount');
const IC = require('../../src/iconcut');
const L = require('./layout');

const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const FRAMES = getArg('frames', 'C:/deepseek/gametest/frames');
const TOL = Number(getArg('tolPx', 6));
const Jimp = require('jimp').Jimp;

/* 在给定区域里，用 gridcount 量一条方向上的等距格子（列或行） */
function latticeCenters(luma, w, h, region, dir) {
  try {
    const r = GC.analyze(luma, w, h, {
      dir: dir, k: 2, bandSearch: 0,
      region: region, expect: undefined,
    });
    if (!r || !r.cells || r.cells.length < 2) return null;
    if (!(r.spacing >= 8) || r.cv > 0.12) return null;      // 太密或根本不等距 → 不认（阈值宽松但会如实按结果算 ✓）
    return { centers: r.cells.map((c) => c.center), spacing: r.spacing, cv: r.cv };
  } catch (e) { return null; }
}

(async () => {
  const files = fs.readdirSync(FRAMES).filter((f) => /\.png$/i.test(f)).sort();
  const rows = [];
  for (const f of files) {
    const png = path.join(FRAMES, f);
    const img = await Jimp.fromBuffer(fs.readFileSync(png));
    const w = img.width, h = img.height;
    const luma = IC.lumaFromJimp(img);
    /* 两块区域：小按钮网格（4×3）与贴边按钮（四角+左右中）——都用**几何**量，不读字 ✓ */
    const zones = [
      { id: 'small', region: { x0: 990, y0: 90, x1: 1240, y1: 270 } },
      { id: 'edge', region: { x0: 0, y0: 0, x1: 1919, y1: 1079 } },
    ];
    for (const t of L.buttons) {
      if (t.kind !== 'small' && t.kind !== 'edge') continue;
      const tx = t.x + Math.round(t.w / 2), ty = t.y + Math.round(t.h / 2);
      const zone = t.kind === 'small' ? zones[0] : zones[1];
      const cols = latticeCenters(luma, w, h, zone.region, 'h');
      const rws = latticeCenters(luma, w, h, zone.region, 'v');
      let best = null, bestD = Infinity;
      /* 贴边按钮不构成规则网格 → 退化为"在区域内用 blob 块中心"✓（不是为了好看 ✗ 是几何上就没有格距 ✓） */
      if (cols && rws && cols.centers.length >= 2 && rws.centers.length >= 2) {
        for (const cx of cols.centers) for (const cy of rws.centers) {
          const d = Math.hypot(cx - tx, cy - ty);
          if (d < bestD) { bestD = d; best = { cx, cy }; }
        }
      } else {
        /* ★不许**静默**退化✗→✓（lead 指出这是真 bug ✓）：量不出格距就**明确报出来** ✓ ——
           第一版这里悄悄退回 blob ✗ → 数字从 50% 掉到 11.1% 却看不出原因 ✗。
           现在：明确判 "no-lattice" 并写出为什么 ✓（四角按钮是分散目标 ✓ 本来就没有格距 ✓ 属"不适用" ✓）。 */
        const why = (!cols ? '横向量不出格距' : (!rws ? '纵向量不出格距' : '两侧格子都少于 2'));
        rows.push({ frame: f, id: t.id, kind: t.kind, truth: { x: tx, y: ty }, got: null, dist: Infinity, tol: 0,
          verdict: 'no-lattice', method: '★' + why + '✗ → 不用格距（该目标几何上不适用）★' });
        continue;
      }
      const tol = Math.max(TOL, Math.round(Math.min(t.w, t.h) / 2) + 4);
      const verdict = !best ? 'notfound' : (bestD <= tol ? 'ok' : 'wrong');
      rows.push({ frame: f, id: t.id, kind: t.kind, truth: { x: tx, y: ty }, got: best, dist: bestD, tol, verdict,
        method: (cols && rws && cols.centers.length >= 2 && rws.centers.length >= 2) ? ('lattice h=' + cols.spacing.toFixed(1) + 'px v=' + rws.spacing.toFixed(1) + 'px') : 'blob' });
    }
  }
  const acc = {};
  for (const r of rows) {
    const k = r.kind === 'small' ? 'small' : 'edge';
    acc[k] = acc[k] || { n: 0, hit: 0, wrong: 0, notfound: 0, errs: [] };
    const a = acc[k]; a.n++;
    if (r.verdict === 'ok') { a.hit++; a.errs.push(r.dist); } else if (r.verdict === 'wrong') a.wrong++; else a.notfound++;
  }
  const stat = (arr) => { if (!arr.length) return { n: 0, mean: 0, p95: 0, max: 0 }; const s = arr.slice().sort((x, y) => x - y); return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
  let n = 0, hit = 0, wrong = 0, nf = 0; const allErr = [];
  console.log('=== small+edge 走格距+相位（几何 ✓ 不读小字 ✓ 容差 ' + TOL + 'px）===');
  for (const k of Object.keys(acc)) {
    const a = acc[k]; const e = stat(a.errs);
    n += a.n; hit += a.hit; wrong += a.wrong; nf += a.notfound; allErr.push.apply(allErr, a.errs);
    console.log('  ' + k.padEnd(6) + a.hit + '/' + a.n + ' = ' + (a.hit / a.n * 100).toFixed(1) + '%　wrong=' + a.wrong + ' notfound=' + a.notfound
      + '　中心误差 平均 ' + e.mean.toFixed(1) + ' / p95 ' + e.p95.toFixed(1) + ' / 最大 ' + e.max.toFixed(1) + 'px');
  }
  const e2 = stat(allErr);
  console.log('  ★合计 ' + hit + '/' + n + ' = ' + (n ? (hit / n * 100).toFixed(1) : '0.0') + '%★　wrong=' + wrong + ' notfound=' + nf
    + '　中心误差 平均 ' + e2.mean.toFixed(1) + ' / p95 ' + e2.p95.toFixed(1) + ' / 最大 ' + e2.max.toFixed(1) + 'px');
  console.log('  每格用的方法：' + JSON.stringify(rows.slice(0, 4).map((r) => r.id + ':' + r.method)));
  fs.writeFileSync('C:/deepseek/gametest/lattice-small.json', JSON.stringify({ at: new Date().toISOString(), tol: TOL, acc, rows }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/lattice-small.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
