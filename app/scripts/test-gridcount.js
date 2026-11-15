/* test-gridcount.js —— ★「数格子」算法的单元测试（纯 Node，合成图，不依赖屏幕★）
 *
 * 跑法：node app/scripts/test-gridcount.js
 *
 * 【为什么要合成图 ✗→✓】
 *   真机截图只证明"这一张能测"✓，证明不了"换个间距/缺一格/深色压深色还准不准"✗。
 *   合成图能**精确控制**：格子数、格距、对比度、缺格、偏离格距的第一个东西 ✓ ——
 *   于是每一条设计决策都能被钉死（改坏了立刻红 ✓）。
 *
 * 【★最关键的一条★】`find_grid` 翻车的场景在这儿被**专门复现** ✓：
 *   "深色图标压在深色背景上 + 一块高光" ✓ —— 平均亮度法必挂 ✗，局部对比度法必须过 ✓。
 */
'use strict';
const GC = require('../src/gridcount');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

/* 造一张灰度图：bg 背景 + 每格画一个"哑铃形"小图标（两侧亮、中间暗，
   故意做成**能量不对称**✓ —— 真机图标的质心就是这么偏的 ✓）。
   opts: { w,h, bg, ink, spacing, first, n, half, missing:[], highlight:bool } */
function synth(o) {
  const w = o.w || 200, h = o.h || 1100;   // ★1100：让 9 个格子（120…984）都**真的画进图里** ✓
                                           //   （第一版 h=900 ✗ → 第 9 个图标在 y=984 根本没画出来 ✗
                                           //    → 测试报"少一格"，而其实是**测试自己的图少画了** ✓
                                           //    这条也是"看到失败先怀疑测试"的例子 ✓）
  const bg = o.bg == null ? 18 : o.bg;        // 深色背景
  const ink = o.ink == null ? 26 : o.ink;     // ★深色图标（只比背景亮 8）→ 平均亮度法必挂 ✗
  const luma = new Float32Array(w * h).fill(bg);
  const spacing = o.spacing == null ? 108 : o.spacing;   // ★108：让 9 个格子都落在测试区域里 ✓（真机是 110~115 ✓）
  const first = o.first == null ? 120 : o.first;
  const n = o.n == null ? 9 : o.n;
  const half = o.half == null ? 22 : o.half;   // 图标半高（能量集中在上半 ✓ 不对称 ✓）
  const cx = Math.round(w / 2);
  const missing = o.missing || [];
  const centers = [];
  for (let i = 0; i < n; i++) {
    if (missing.indexOf(i) >= 0) { centers.push(null); continue; }
    const cy = Math.round(first + i * spacing);
    centers.push(cy);
    for (let y = cy - half; y <= cy + half; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = cx - 14; x <= cx + 14; x++) {
        const t = (y - (cy - half)) / (2 * half);          // 0=上 1=下
        const v = t < 0.5 ? ink : Math.max(0, ink - t * 6); // 上半更亮 → 质心偏上 ✓
        luma[y * w + x] = Math.max(bg, v);
      }
    }
  }
  /* ★"高光/立绘"那一条：做成**沿 y 变化**的亮条**（不是一根均匀的亮线 ✗）★ ——
     真机里那块是游戏立绘/面板的高光 ✓，它在 y 方向**亮度差很大** ✓
     → 老算法（平均亮度 + 全局阈值）的 mn~mx 被它撑到 ~200 ✓ → 阈值高于图标 ✓ → 切不出图标 ✓
     这就是 find_grid 在职业列上"只测到 1 段"的真实机制 ✓（均匀亮线反而撑不出这个范围 ✗）。 */
  if (o.highlight) {
    for (let y = 0; y < h; y++) {
      const v = 30 + Math.round(200 * Math.abs(Math.sin(y / 90)));
      for (let x = 0; x < 30; x++) luma[y * w + x] = v;
    }
  }
  return { luma, w, h, centers, spacing, first };
}

console.log('=== test-gridcount（数格子：合成图单元测试）===');

/* §1 ★深色压深色 + 高光块：平均亮度法会挂，局部对比度必须过★ */
{
  const g = synth({ highlight: true });
  const r = GC.analyze(g.luma, g.w, g.h, { dir: 'v', region: { x0: 70, x1: 140, y0: 40, y1: 1010 }, k: 2, expect: 9 });
  ok(r.cells.length === 9, '★§1 深色图标压深色背景 + 旁边一条通高亮边 → 仍测出 9 格★', 'cells=' + r.cells.length);
  ok(r.consistent === true, '§1 判定"等距"✓', 'spacing=' + r.spacing.toFixed(1) + ' 残差=' + (r.cv * 100).toFixed(1) + '%');
  ok(Math.abs(r.spacing - g.spacing) <= 3, '★§1 格距量准了（真值 ' + g.spacing + '）★', '测到 ' + r.spacing.toFixed(1));
  ok(r.quality.verdict === 'ok', '§1 可信度结论 = ok', JSON.stringify(r.quality.reasons));
}

/* §2 对照组：把"局部对比度"退化成"整行平均亮度"就该挂 —— 用 find_grid 的老办法验证一下这个测试有意义 */
{
  const g = synth({ highlight: true });
  const W = g.w, H = g.h;
  /* ★刻意用**宽区域**（0~199）做对照 ✗→✓：这正是主人的真实调用方式（"看那一片"✓）。
     图标只占 200px 里的 28px ✓ → 它对"整行平均亮度"的贡献被摊薄到 ~0.4 ✗；
     而高亮边把 mn~mx 撑到 18~235 ✓ → 老阈值 mn+35%×(mx-mn) = 94 ✗ → 什么都切不出来 ✓。
     真机实测也是这个形状：find_grid 在职业列上只测到 1 段 ✗。 */
  const prof = [];
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x <= 199; x++) s += g.luma[y * W + x]; prof.push(s / 200); }
  const mx = Math.max(...prof), mn = Math.min(...prof);
  const thr = mn + (mx - mn) * 0.35;
  const runs = GC.findRuns(prof, thr, 6, 5);   // ★find_grid 的老算法：平均亮度 + mn+35%★
  ok(runs.length !== 9, '★§2 对照：老算法（平均亮度 + 全局阈值）在宽区域上**测不出 9 段**★', 'runs=' + runs.length + '（真机 find_grid 也是 1 段 ✓）');
  /* ★同一张图、同一个宽区域，换成本模块（局部对比度 + 窄条搜索）→ 必须测出 9 格✓★ */
  const r2 = GC.analyze(g.luma, g.w, g.h, { dir: 'v', region: { x0: 0, x1: 199, y0: 40, y1: 1010 }, k: 2, bandSearch: 56, expect: 9 });
  ok(r2.cells.length === 9, '★★§2 同一张宽图：本模块**测出 9 格**（这就是这次修的东西 ✓）★★', 'cells=' + r2.cells.length + ' band=' + JSON.stringify(r2.region));
}

/* §3 缺一格 → 标成"估算"补上，并如实标 estimated ✓ */
{
  const g = synth({ n: 9, missing: [4] });
  const r = GC.analyze(g.luma, g.w, g.h, { dir: 'v', region: { x0: 70, x1: 140, y0: 40, y1: 1010 }, k: 2 });
  ok(r.cells.length === 9, '★§3 第 5 格是空的 → 仍然报 9 格（补位 ✓ 不是当没这回事 ✗）★', 'cells=' + r.cells.length);
  const est = r.cells.filter((c) => c.estimated);
  ok(est.length === 1, '★§3 补的那一格被标成 estimated ✓（"看到的"和"推出来的"不混 ✗）★', JSON.stringify(est.map((c) => c.center)));
}

/* §4 第一个东西不在格距上（职业列的 ALL 就是这种）→ 保留 + 标"格距外" ✓ */
{
  const g = synth({ n: 8, first: 200, spacing: 115 });
  /* 在 y=125 再加一个"文字块"（与第二格只差 75px ✓，与主格距 115 不符 ✓） */
  for (let y = 116; y <= 134; y++) for (let x = 86; x <= 114; x++) g.luma[y * g.w + x] = 60;
  const r = GC.analyze(g.luma, g.w, g.h, { dir: 'v', region: { x0: 70, x1: 140, y0: 60, y1: 1010 }, k: 2 });
  ok(r.cells.length === 9, '★§4 8 个等距格 + 1 个"格距外"的东西 = 9 格（一个都不丢 ✓）★', 'cells=' + r.cells.length);
  ok(r.offLattice.length === 1, '★§4 那一个被如实标成"格距外"✓（没被硬塞进格距 ✗、也没被假装不存在 ✗）★', JSON.stringify(r.offLattice.map((c) => c.center)));
  ok(r.consistent === true, '§4 成格链仍然判"等距"✓（格距外的那个不参与 CV 计算 ✓）');
}

/* §5 横向：一行等距图标（dir=h） */
{
  const w = 900, h = 120;
  const luma = new Float32Array(w * h).fill(20);
  const spacing = 100, first = 60, n = 8;
  for (let i = 0; i < n; i++) {
    const cx = first + i * spacing;
    for (let x = cx - 20; x <= cx + 20; x++) for (let y = 40; y <= 80; y++) if (x >= 0 && x < w) luma[y * w + x] = 30;
  }
  const r = GC.analyze(luma, w, h, { dir: 'h', region: { x0: 0, x1: w - 1, y0: 40, y1: 100 }, k: 2 });
  ok(r.cells.length === n, '§5 横排也数得出来', 'cells=' + r.cells.length);
  ok(Math.abs(r.spacing - spacing) <= 3, '§5 横排格距量准', r.spacing.toFixed(1));
}

/* §6 纯色块（什么格子都没有）→ 不硬凑 */
{
  const luma = new Float32Array(200 * 400).fill(30);
  const r = GC.analyze(luma, 200, 400, { dir: 'v', region: { x0: 0, x1: 199, y0: 0, y1: 399 }, k: 2 });
  ok(r.cells.length === 0, '★§6 纯色块 → 0 格（不编 ✗）★', 'cells=' + r.cells.length);
  ok(r.quality.verdict === 'weak' && r.quality.reasons.length > 0, '§6 并明确给出"不可信"的原因 ✓', JSON.stringify(r.quality.reasons));
}

/* §7 期望个数对不上时：如实报告"扫不到" ✓（不假装） */
{
  const g = synth({ n: 5, spacing: 120, first: 100 });
  const r = GC.analyze(g.luma, g.w, g.h, { dir: 'v', region: { x0: 70, x1: 140, y0: 40, y1: 1010 }, k: 2, expect: 9 });
  ok(r.sweep && r.sweep.found === false, '★§7 期望 9 格但图上只有 5 格 → sweep 如实报 found=false ✓★');
  ok(r.cells.length !== 9, '★§7 不会为了凑 9 而编格子 ✓（实测 ' + r.cells.length + '）★');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
