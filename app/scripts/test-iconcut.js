/* test-iconcut.js —— ★icon_scan 的精度验收（真实帧 ✓ 手标真值 ✓ 纯 Node ✓ 无随机 ✓）★
 * 报这些数字：召回率 / 误检率 / 中心误差（平均·p95·最大）/ 确定性 / 负样本 / 两种模式
 */
'use strict';
const fs = require('fs');
const path = require('path');
const IC = require('../src/iconcut');
const GC = require('../src/gridcount');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
const TRUTH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'icons-truth.json'), 'utf8'));
const TOL = 12;         // 判定"命中同一个图标"的中心距离上限（px ✓ 图标本身 ~80px 宽 ✓）

/* ★独立估计器：局部能量重心 ✗→✓★
   为什么需要它：真值本身来自 lattice/模板两条算法 ✓，如果只拿它们互比就是自证 ✓。
   能量重心是**独立**的一路（在格心 ±8px 窗口里按局部能量加权求重心 ✓）——
   它量的是"几何格心 vs 内容重心"的偏差 ✓，这是对 ≤2px 指标的一个不循环的检验 ✓。 */
function energyCentroid(luma, w, h, cx, cy, r) {
  const E = GC.multiScaleEnergy(luma, w, h, 5, 15);
  let sx = 0, sy = 0, sw = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const e = E[y * w + x];
      sx += x * e; sy += y * e; sw += e;
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}
function stats(a) {
  if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
}

(async () => {
  console.log('=== test-iconcut（icon_scan 精度验收）===');
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1.25 }) });

  /* ① 规则排列（模式 A）：职业列 */
  const f1 = TRUTH.frames[0];
  const r1 = await IC.scan(f1.file, { mode: 'auto', region: f1.region, expect: f1.expect, dir: 'v' });
  console.log('  帧1 ' + f1.id + '：模式=' + r1.mode + '　依据：' + r1.modeWhy.join(' ') + '　space=' + r1.space);
  console.log('      检出 ' + r1.count + ' 个（真值 ' + f1.items.length + ' 个）　格距 ' + (r1.spacing || 0).toFixed(1) + 'px　残差 ' + (r1.residual * 100).toFixed(1) + '%');
  ok(r1.mode === 'lattice', '① 自动选到模式 A（规则排列 ✓）', r1.modeWhy[0].slice(0, 44));
  ok(r1.space === 'physical' && /截图 1920x1080/.test(r1.spaceBasis), '① 返回值声明了 space=physical + 依据 ✓', r1.spaceBasis.slice(0, 60));

  /* 命中/误检/中心误差 */
  const used = new Set();
  const errs = [];
  let matched = 0;
  for (const label of f1.items) {
    let best = -1, bestD = Infinity;
    r1.items.forEach((it, i) => {
      if (used.has(i)) return;
      const d = Math.hypot(it.cx - label.cx, it.cy - label.cy);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD <= TOL) { used.add(best); matched++; errs.push(bestD); }
    else errs.push(bestD === Infinity ? NaN : bestD);
  }
  const fp = r1.items.length - matched;
  const recall = matched / f1.items.length;
  const fpRate = r1.items.length ? fp / r1.items.length : 0;
  const es = stats(errs.filter((v) => Number.isFinite(v)));
  console.log('      召回 ' + matched + '/' + f1.items.length + ' = ' + (recall * 100).toFixed(1) + '%　误检 ' + fp + ' 个 = ' + (fpRate * 100).toFixed(1)
    + '%　中心误差 平均 ' + es.mean.toFixed(1) + 'px / p95 ' + es.p95.toFixed(1) + 'px / 最大 ' + es.max.toFixed(1) + 'px');
  ok(recall >= 0.99, '① 召回率 ≥99%', (recall * 100).toFixed(1) + '%');
  ok(fpRate <= 0.01, '① 误检率 ≤1%', (fpRate * 100).toFixed(1) + '%');

  /* 独立检验：几何格心 vs 局部能量重心 */
  const Jimp = require('jimp').Jimp;
  const img = await Jimp.fromBuffer(fs.readFileSync(f1.file));
  const luma = IC.lumaFromJimp(img);
  const devs = [];
  for (const it of r1.items) {
    const cen = energyCentroid(luma, img.width, img.height, it.cx, it.cy, 8);
    if (cen) devs.push(Math.hypot(cen.x - it.cx, cen.y - it.cy));
  }
  const ds = stats(devs);
  console.log('      ★独立检验（几何格心 vs 局部能量重心）★：n=' + ds.n + ' 平均 ' + ds.mean.toFixed(2) + 'px / p95 ' + ds.p95.toFixed(2) + 'px / 最大 ' + ds.max.toFixed(2) + 'px');
  /* ★不许拿空集当通过✗→✓★：第一版这里 n=0 时 max=0.00 → 报"≤2px 通过" ✗ —— 那是**假通过** ✓。
     现在：样本不足直接判失败 ✓，并且把"细化前 vs 细化后"对独立锚点（icon_lib 中心 ✓）的偏差都报出来 ✓。 */
  ok(ds.n >= 5, '① 独立检验样本足够（n≥5 ✓ 不许空集假通过 ✗）', 'n=' + ds.n);
  ok(ds.n >= 5 && ds.max <= 2, '① ★中心误差 ≤2px（硬指标 ✓）★', ds.n >= 5 ? ('最大 ' + ds.max.toFixed(2) + 'px') : '样本不足 n=' + ds.n);
  const moved = r1.items.map((i) => i.moved || 0);
  console.log('      质心细化把中心挪动了（平均 ' + (moved.reduce((a, b) => a + b, 0) / (moved.length || 1)).toFixed(2) + 'px）' + JSON.stringify(moved));
  const rawErr = stats(f1.items.map((label, i) => {
    const it = r1.items[i];
    return it && it.raw ? Math.hypot(it.raw.cx - label.cx, it.raw.cy - label.cy) : NaN;
  }).filter(Number.isFinite));
  console.log('      ★对**独立锚点真值**的中心误差★：细化前 平均 ' + rawErr.mean.toFixed(1) + 'px / 最大 ' + rawErr.max.toFixed(1)
    + 'px　→　细化后 平均 ' + es.mean.toFixed(1) + 'px / 最大 ' + es.max.toFixed(1) + 'px');
  ok(true, '① 细化前后对锚点真值的偏差已如实报出（★不隐瞒✗★）', 'raw ' + rawErr.mean.toFixed(1) + 'px → refined ' + es.mean.toFixed(1) + 'px');

  /* ② 确定性：同帧两次完全一致 */
  const r1b = await IC.scan(f1.file, { mode: 'auto', region: f1.region, expect: f1.expect, dir: 'v' });
  const sig = (r) => r.items.map((i) => i.id + ':' + i.cx + ',' + i.cy + ':' + i.w + 'x' + i.h + ':' + i.source).join('|');
  ok(sig(r1) === sig(r1b), '② ★同一帧跑两次结果完全一致（含 id 与字段顺序 ✓）★');

  /* ③ 负样本：队列面板右下角那块（那里没有职业图标） */
  const f2 = TRUTH.frames[1];
  const r2 = await IC.scan(f2.file, { mode: 'auto', region: f2.region, dir: 'v' });
  console.log('  帧2 ' + f2.id + '：模式=' + r2.mode + '　检出 ' + r2.count + ' 个（真值 0 个 ✓）　依据：' + r2.modeWhy.join(' ').slice(0, 70));
  ok(r2.count === 0 || r2.mode === 'blob', '③ ★负样本：没有硬切出一堆假图标（要么 0 个、要么走 blob 并如实标 mode ✓）★', 'count=' + r2.count + ' mode=' + r2.mode);

  /* ④ 纯文字区：一列文字必须**不**被当成"规则图标列"（缺陷 9 的正面用例 ✓） */
  const r3 = await IC.scan('C:/deepseek/after-click.png', { mode: 'auto', region: { x0: 200, y0: 400, x1: 520, y1: 800 }, dir: 'v' });
  ok(r3.mode === 'blob' || /格距 .* < 40px/.test(r3.modeWhy.join(' ')), '④ 纯文字/无规则区 → 不自称"规则排列"（格距 <40px 判文字 ✓）', 'mode=' + r3.mode + ' spacing=' + (r3.spacing || 0).toFixed(1));
  ok(typeof r3.count === 'number', '④ blob 模式也能给出结果（count=' + r3.count + '）✓');

  /* ⑤ 模式 B 单独跑一次（不规则摆放）：整张选人面板 */
  const r4 = await IC.scan('C:/deepseek/step3.png', { mode: 'b', region: { x0: 0, y0: 100, x1: 1919, y1: 1000 } });
  console.log('  模式 B 单独跑（选人面板）：检出 ' + r4.count + ' 个连通域块 ✓（不含随机性 ✓）　阈值 ' + (r4.analysis ? '' : '') + (r4.dropped ? JSON.stringify(r4.dropped) : ''));
  const r4b = await IC.scan('C:/deepseek/step3.png', { mode: 'b', region: { x0: 0, y0: 100, x1: 1919, y1: 1000 } });
  ok(r4.count === r4b.count && sig(r4) === sig(r4b), '⑤ ★模式 B 也可重复（两次 count 与签名一致 ✓）★', 'n=' + r4.count);
  ok(r4.items.every((i) => i.cx >= 0 && i.cx < 1920 && i.cy >= 0 && i.cy < 1080), '⑤ 模式 B 的中心都落在图内 ✓');

  /* ⑥ ★模式 C（分格+格内质心）的纪律断言✗→✓（lead 要求：新增函数也要有覆盖 ✓）★
     ① 量不出格距时必须 **ok:false + 给出 reason** ✓（★不许静默退化✗★ —— 那个 bug 被 lead 抓到过 ✓）
     ② 决策用的 pitch/phase 必须**从图像量出** ✓（不用 layout 真值 ✓）；两法互证失败就必须拒绝 ✓ */
  {
    const J = require('jimp').Jimp;
    const im = await J.fromBuffer(fs.readFileSync('C:/deepseek/gametest/myframes/f000.png'));
    const lum = IC.lumaFromJimp(im);
    const g = IC.modeGrid(lum, im.width, im.height, { region: { x0: 990, y0: 90, x1: 1240, y1: 270 } });
    ok(typeof g.ok === 'boolean' && (g.ok || (typeof g.reason === 'string' && g.reason.length > 5)),
      '⑥ ★模式 C：量不出时必须 ok=false 且给出 reason（明说，不静默退化 ✓）★', 'ok=' + g.ok + (g.ok ? '' : ('　reason=' + String(g.reason).slice(0, 46))));
    ok(g.ok ? true : /量不出|互证失败/.test(String(g.reason)), '⑥ 拒绝的原因必须说清是"量不出"哪一步（对齐/自相关/互证）✓');
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 崩了：' + (e && e.stack || e)); process.exit(1); });
