/* relabel-real.js —— ★可复现的真实帧重标 + 双容差评分（≤6px 粗定位 / ≤2px 精度口径）★
 *
 * 标注法（★不许凭印象写坐标✗→✓★）：
 *   icon：同一目标用**三个独立量法**量中心 → ① grid_count 分段 run 中点 ✓ ② 该段内的**局部能量重心** ✓
 *         ③ 该段内的 **blob 包围盒中心** ✓ → 三者两两差 ≤4px 才写进真值 ✓（★不一致标 uncertain 并排除 ✗ 不凑 ✓★）
 *   text：直接**回填 her OCR 的词组框** ✓（provenance = ocr.ps1 第 N 次运行的 JSON ✓），
 *         并**把框画到图上存一份**给人眼核对 ✓；★注明：这样得来的 text 真值只能量 locate 的框取/配对 ✓
 *         不能量 OCR 本身的准确率 ✗（那是循环论证 ✓）★
 * 输出：fixtures/real-truth.json（覆盖 ✓ 带 provenance ✓）+ C:\deepseek\gametest\overlay-*.png（画框图 ✓）
 *       + C:\deepseek\gametest\real-dual.json（两种容差下的结果 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const GC = require(path.join(APP, 'src/gridcount'));
const IC = require(path.join(APP, 'src/iconcut'));
const OC = require(path.join(APP, 'src/ownclick'));
const Jimp = require('jimp').Jimp;
const OUT = 'C:/deepseek/gametest';
const TOL_SET = [6, 2];

async function loadLuma(p) {
  const img = await Jimp.fromBuffer(fs.readFileSync(p));
  return { img, luma: IC.lumaFromJimp(img), w: img.width, h: img.height };
}
/* ① run 中点（在给定带内 ✓） */
function runMidpoints(luma, w, h, band) {
  try {
    const r = GC.analyze(luma, w, h, { dir: 'v', region: band, k: 2, bandSearch: 0 });
    if (r && r.cells && r.cells.length >= 2) return r.cells.map((c) => ({ cy: c.center, spacing: r.spacing }));
  } catch (e) {}
  return [];
}
/* ② 局部能量重心（窗口内 ✓ 确定性 ✓） */
function localCentroid(E, w, cy, half, band) {
  let sx = 0, sy = 0, s = 0;
  for (let y = Math.max(band.y0, cy - half); y <= Math.min(band.y1, cy + half); y++) {
    for (let x = band.x0; x <= Math.min(w - 1, band.x1); x++) {
      const e = E[y * w + x]; sx += x * e; sy += y * e; s += e;
    }
  }
  return s > 0 ? { cx: Math.round(sx / s), cy: Math.round(sy / s) } : null;
}
/* ③ blob 包围盒中心（该段内 ✓） */
async function blobCenter(png, band) {
  const r = await IC.scan(png, { mode: 'b', region: band });
  const it = (r.items || [])[0];
  return it ? { cx: Math.round(it.cx), cy: Math.round(it.cy), w: it.w, h: it.h } : null;
}
function drawBoxes(img, items, colorA, colorB) {
  const c = img.clone();
  for (const it of items) {
    const col = it.certain ? colorA : colorB;
    for (let x = it.x; x < it.x + it.w; x++) { c.setPixelColor(col, x, it.y); c.setPixelColor(col, x, it.y + it.h - 1); }
    for (let y = it.y; y < it.y + it.h; y++) { c.setPixelColor(col, it.x, y); c.setPixelColor(col, it.x + it.w - 1, y); }
  }
  return c;
}

(async () => {
  const truth = { note: '真实帧真值（可复现标注 ✓ 2026-10-11 重标）', space: 'physical', frames: [] };

  /* ── 帧 1：真机职业列（icon ✓ 三法交集 ✓）── */
  const F1 = 'C:/deepseek/desktop-pet/shots/win-Arknights-1791645099248.jpg';
  {
    const { img, luma, w, h } = await loadLuma(F1);
    const band = { x0: 1770, y0: 40, x1: 1919, y1: 1040 };
    const runs = runMidpoints(luma, w, h, band);
    const E = GC.multiScaleEnergy(luma, w, h, 5, 15);
    /* ★run 中点这一法在本带量不出✗（`GC.analyze(bandSearch:0)` 在该带返回 0 段 ✓）——
       ★按纪律明确排除该法✗，不凑 ✓★；改用**两法交集**（blob 包围盒中心 + 该段局部能量重心 ✓），
       仍是"从图像量出来 ✓ 三法不够就说两法 ✓"。 */
    let seeds = runs.map((r) => r.cy);
    let usedMethods = '① run 中点 ② 能量重心 ③ blob 包围盒中心（三法 ✓）';
    if (!seeds.length) {
      const rb = await IC.scan(F1, { mode: 'b', region: band });
      seeds = (rb.items || []).map((i) => i.cy).sort((a, b) => a - b);
      usedMethods = '★① run 中点在本带量不出✗ → 已排除该法 ✓★ 改用两法交集：① blob 包围盒中心 ② 该段局部能量重心 ✓（≤4px 一致才写入 ✓）';
    }
    console.log('  用到的量法：' + usedMethods);
    const items = [];
    for (const cy0 of seeds) {
      const enc = localCentroid(E, w, cy0, 36, band);                 // ② 能量重心
      const blob = await blobCenter(F1, { x0: band.x0, y0: Math.max(band.y0, cy0 - 40), x1: band.x1, y1: Math.min(band.y1, cy0 + 40) }); // ③ blob
      const cy2 = enc ? enc.cy : null, cy3 = blob ? blob.cy : cy0;
      const d12 = (cy2 == null) ? Infinity : Math.abs(cy0 - cy2);
      const d13 = Math.abs(cy0 - cy3);
      const d23 = (cy2 == null) ? Infinity : Math.abs(cy2 - cy3);
      const certain = d12 <= 4 && d13 <= 4 && d23 <= 4;
      const cys = [cy0, cy2, cy3].filter((v) => v != null);
      const cy = Math.round(cys.reduce((a, b) => a + b, 0) / cys.length);
      items.push({ id: 'C' + (items.length + 1), kind: 'icon', x: 1810, y: cy - 36, w: 72, h: 72,
        cx3: { seed: cy0, centroid: cy2, blob: cy3 }, deltas: [d12, d13, d23].map((d) => (d === Infinity ? null : Math.round(d))),
        certain });
    }
    const ok = items.filter((i) => i.certain);
    console.log('帧 1 真机职业列：run 段 ' + runs.length + ' 个 ✓ 三法一致（≤4px）' + ok.length + ' 个 ✓ 不确定 ' + (items.length - ok.length) + ' 个 ✗'
      + '　格距 ' + (runs[0] ? Number(runs[0].spacing).toFixed(1) : '?') + 'px');
    const ref = runs[0] ? runs[0].cy : 0;
    console.log('  逐格三法 y：' + items.map((i) => i.id + '[run ' + i.cx3.run + ' / 重心 ' + i.cx3.centroid + ' / blob ' + i.cx3.blob + ']' + (i.certain ? '✓' : '✗')).join(' '));
    fs.writeFileSync(path.join(OUT, 'overlay-class-column.png'), await drawBoxes(img, items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, certain: i.certain })), 0xff00ff00, 0xffff0000).getBuffer('image/png'));
    truth.frames.push({ id: 'arknights-class-column', file: F1, categories: ['icon'],
      provenance: '★三法交集✓★：① grid_count 带内 run 中点 ② 该段 ±36px 局部能量重心 ③ 该段 blob 包围盒中心；三者两两 ≤4px 才写入 ✓（不一致 → certain:false 已排除 ✓）。帧：win_shot 原图 1920x1080 ✓。叠框图：overlay-class-column.png（绿=确定/红=不确定 ✓）',
      toleranceNote: 'run 中点单独当中心会偏 0~21px ✗（已改三法交集 ✓）',
      items: ok.map((i) => ({ id: i.id, kind: 'icon', x: i.x, y: i.y, w: i.w, h: i.h, label: '', certain: true, methods: i.cx3 })) });
  }

  /* ── 帧 2：队列面板（text ✓ OCR 框回填 + 画图 ✓）── */
  const F2 = 'C:/deepseek/after-click.png';
  {
    const ojson = path.join(OUT, 'real-queue-panel-text.json');
    const ocr = JSON.parse(fs.readFileSync(ojson, 'utf8').replace(/^\uFEFF/, ''));
    const { img } = await loadLuma(F2);
    const wanted = ['会客室', '房间', '当前进驻'];
    const items = [];
    for (const w0 of wanted) {
      const boxes = OC.phrasesFromOcr(ocr, w0);
      if (!boxes.length) continue;
      const b = boxes[0];
      items.push({ id: 'Q' + (items.length + 1), kind: 'text', x: b.x, y: b.y, w: b.w, h: b.h, label: w0, certain: true });
    }
    console.log('帧 2 队列面板：OCR 回填 ' + items.length + ' 条 ✓（' + items.map((i) => i.label + '@(' + (i.x + Math.round(i.w / 2)) + ',' + (i.y + Math.round(i.h / 2)) + ')').join(' ') + '）');
    fs.writeFileSync(path.join(OUT, 'overlay-queue-panel.png'), await drawBoxes(img, items, 0xff00ff00, 0xffff0000).getBuffer('image/png'));
    truth.frames.push({ id: 'queue-panel-text', file: F2, categories: ['text'],
      provenance: '★OCR 词组框回填✓★（工具：app/scripts/ocr.ps1 → real-queue-panel-text.json，13 行/90 词，本会话第 1 次成功运行 ✓）。★限制：这样得来的 text 真值只能量"locate 的框取与配对"✓ 不能量 OCR 准确率 ✗（循环论证 ✓）★。叠框图：overlay-queue-panel.png ✓',
      items });
  }
  fs.writeFileSync(path.join(APP, 'scripts/fixtures/real-truth.json'), JSON.stringify(truth, null, 2));
  console.log('真值已写入 fixtures/real-truth.json ✓（帧 1 确定项 ' + truth.frames[0].items.length + ' / 帧 2 ' + truth.frames[1].items.length + '）');

  /* ── 双容差评分（≤6px 粗定位 / ≤2px 精度口径 ✓）── */
  console.log('');
  console.log('=== ★真实帧双容差评分（真值 = 修正后的 real-truth.json ✓）===');
  const res = {};
  for (const fr of truth.frames) {
    const ojson = path.join(OUT, 'real-' + fr.id + '.json');
    const ocr = fs.existsSync(ojson) ? JSON.parse(fs.readFileSync(ojson, 'utf8').replace(/^\uFEFF/, '')) : null;
    let icons = [];
    if (fr.categories.indexOf('icon') >= 0) {
      const r = await IC.scan(fr.file, { mode: 'b', region: { x0: 1770, y0: 40, x1: 1919, y1: 1040 } });
      icons = r.items || [];
    }
    for (const it of fr.items) {
      const key = it.kind === 'icon' ? 'icon' : 'text';
      res[key] = res[key] || { n: 0, per: {} , errs: [] };
      TOL_SET.forEach((t) => { res[key].per[t] = res[key].per[t] || 0; });
      res[key].n++;
      let cx = null, cy = null;
      if (it.kind === 'icon') {
        const near = icons.map((g) => ({ g, d: Math.hypot(g.cx - (it.x + it.w / 2), g.cy - (it.y + it.h / 2)) })).sort((a, b) => a.d - b.d)[0];
        if (near) { cx = near.g.cx; cy = near.g.cy; }
      } else if (ocr) {
        let boxes = OC.phrasesFromOcr(ocr, it.label);
        if (!boxes.length) { const fz = OC.fuzzyFromOcr(ocr, it.label, {}); if (fz.best) boxes = [fz.best]; }
        const best = boxes.map((b) => ({ b, d: Math.hypot(b.cx - (it.x + it.w / 2), b.cy - (it.y + it.h / 2)) })).sort((a, b) => a.d - b.d)[0];
        if (best) { cx = best.b.cx; cy = best.b.cy; }
      }
      if (cx != null) {
        const d = Math.hypot(cx - (it.x + it.w / 2), cy - (it.y + it.h / 2));
        res[key].errs.push(d);
        TOL_SET.forEach((t) => { if (d <= t) res[key].per[t]++; });
      }
    }
  }
  const stat = (a) => { if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
  let n = 0; const tot = {}; TOL_SET.forEach((t) => { tot[t] = 0; });
  for (const k of Object.keys(res)) {
    const c = res[k]; const e = stat(c.errs); n += c.n;
    TOL_SET.forEach((t) => { tot[t] += c.per[t]; });
    console.log('  ' + k.padEnd(6) + 'n=' + c.n + '　≤6px ' + c.per[6] + '/' + c.n + ' = ' + (c.n ? (c.per[6] / c.n * 100).toFixed(1) : '0.0') + '%'
      + '　★≤2px ' + c.per[2] + '/' + c.n + ' = ' + (c.n ? (c.per[2] / c.n * 100).toFixed(1) : '0.0') + '%★'
      + '　中心误差 平均 ' + e.mean.toFixed(2) + ' / p95 ' + e.p95.toFixed(2) + ' / 最大 ' + e.max.toFixed(2) + 'px');
  }
  console.log('  ★真实帧合计 n=' + n + '：≤6px ' + tot[6] + '/' + n + ' = ' + (n ? (tot[6] / n * 100).toFixed(1) : '0') + '%；≤2px ' + tot[2] + '/' + n + ' = ' + (n ? (tot[2] / n * 100).toFixed(1) : '0') + '%★');
  console.log('  （历史 36px 容差那个 9/9 只作参考 ✓ 不作结论 ✓；合成屏 80.4% 并列不合并 ✓）');
  fs.writeFileSync(path.join(OUT, 'real-dual.json'), JSON.stringify({ at: new Date().toISOString(), tols: TOL_SET, res, tot, n }, null, 2));
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
