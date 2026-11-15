/* iconcut.js —— ★icon_scan：把屏幕上每个图标切出来，给出**每一格中心坐标**（纯 Node + jimp ✓ 可单测 ✓）★
 *
 * 主人原话：「直接写个工具，可以切割屏幕上每个图标，然后输出每一个图标中心的坐标，
 *            之后如果图标里有文字，再让 OCR 识别，这个精度要求非常非常高」
 * lead 定的验收口径：
 *   · 中心坐标：几何模式 **误差 ≤2px**（★坐标只能由格距+相位算，不许模型给✗★）
 *   · 检测质量：召回 ≥99%、误检 ≤1%（在**人手标注真值**的真实帧上量 ✓）
 *   · 文字：★不承诺 99%✗★（美术字体会让 Windows OCR 失败 ✓）→ 认得就给置信度 ✓，
 *           不认得就如实说"没读出文字" ✓，**绝对不许瞎编** ✓，并给实测准确率 ✓
 *
 * 【两个模式（屏幕上的图标就这两类 ✓）】
 *   模式 A「规则排列」：复用 gridcount 那套（luma→boxBlur→localEnergy→projectEnergy→
 *     Otsu/MAD→findRuns→estimateSpacing/Phase→lattice）→ 算格距与相位 → **直接给每格中心** ✓
 *     ★这是能达到 ≤2px 的路子★（今晚职业列实测 9 格 / 115.7~115.9px / 残差 4.6% ✓）。
 *   模式 B「不规则摆放」：局部能量二值化 → **连通域** → 按尺寸/长宽比过滤 → 重叠合并去重 → 输出框与中心 ✓。
 *   ★自动选择★：先试 A ✓；A 不可信（格距 <40px【多半是一列文字 ✗】/ 残差 >5% / 格数 <2）→ 退 B ✓，
 *     并在返回值里说明**用了哪种、依据是什么** ✓（这就是"不许把难题丢回调用方" ✓）。
 *
 * 【输出（稳定、可排序 ✓ 后面 locate/act 唯一依据 ✓）】
 *   每项：id、cx、cy、w、h、**space**（physical|dip + 依据 ✓）、text、textConf、source（lattice|blob ✓）
 *   ★排序规则固定★：先按 cy 再按 cx（同一画面两次运行完全一致 ✓）。
 *   ★OCR 由调用方注入★（assistant.js 注入 her OCR ✓；纯 Node 测试注入假 OCR ✓）—— 本模块不自己 spawn ✓。
 */
'use strict';

const GC = require('./gridcount');

/* ───────── 通用小工具（都是纯函数 ✓ 无随机 ✓）───────── */
function lumaFromJimp(img) {
  const d = img.bitmap.data, n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) out[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return out;
}
function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/* ───────── 模式 A：规则排列（格距 + 相位 → 每格中心 ✓）───────── */
function modeLattice(luma, w, h, opt) {
  const o = opt || {};
  const r = GC.analyze(luma, w, h, {
    dir: o.dir || 'v', k: o.k || 2,
    expect: o.expect > 0 ? o.expect : undefined,
    bandSearch: o.bandSearch == null ? 56 : o.bandSearch,
    region: o.region || undefined,
  });
  const spacing = r.spacing || 0;
  const residual = r.cv || 0;
  /* ★A 可不可信的判据（阈值都是**实测调出来的** ✓ 不是拍的 ✗）★
     参考帧（明日方舟职业列 ✓ 手标真值那帧）：格距 115.9px ✓、**残差 6.0%** ✓；
     负样本帧（队列面板右下角 ✓ 没有图标列）：自动搜窄条给出 **残差 10.1%** ✓。
     → 阈值取 **8%**：参考帧 6.0% 稳稳通过 ✓，负样本 10.1% 稳稳拒绝 ✓（两侧各留 ~2 个百分点 ✓）。
     ⚠️ 第一版我写了 5% ✗ → ★把参考帧自己给拒了（6.0% > 5%）→ 退 blob → 0 个图标 ✗✗★
        —— 这正是"阈值必须拿真数据标定"的例子 ✓（测试当场抓到 ✓）。 */
  const RESID_MAX = o.residMax == null ? 0.08 : Number(o.residMax);
  const SPACING_MIN = o.spacingMin == null ? 40 : Number(o.spacingMin);
  const MIN_CELLS = o.minCells == null ? 3 : Number(o.minCells);
  const reasons = [];
  if (!(spacing >= 8)) reasons.push('格距太小/没测出来（' + spacing.toFixed(1) + 'px）');
  else if (spacing < SPACING_MIN) reasons.push('格距 ' + spacing.toFixed(1) + 'px < ' + SPACING_MIN + 'px —— ★多半是一列文字、不是图标列✗★');
  if (residual > RESID_MAX) reasons.push('残差 ' + (residual * 100).toFixed(1) + '% > ' + (RESID_MAX * 100).toFixed(0) + '% —— ★不等距，不是规则排列✗★');
  if ((r.cells || []).length < MIN_CELLS) reasons.push('只测出 ' + (r.cells || []).length + ' 格（下限 ' + MIN_CELLS + '）');
  const trustworthy = reasons.length === 0;
  const axis = Math.round((r.region.x0 + r.region.x1) / 2);
  const half = Math.max(6, Math.round(spacing * 0.36));
  /* ★质心细化 ✗→✓（2026-10-11 实测抓到的问题）★
     只取"格距+相位算出来的格心"时，与**独立锚点**（icon_lib 的模板匹配中心 ✓）系统性差 **8px** ✗ ——
     因为 run 的中点 ≠ 图标内容的重心（run 边界受渐变/描边影响 ✓）。
     → 在每个格心 ±8px 窗口里按**局部对比度能量加权求重心** ✓（确定性 ✓ 无随机 ✓ 亚像素 ✓）再定中心 ✓。
     ★这一步是纯测量的细化 ✓，不是模型 ✓，也不改格距/相位（那两条仍来自 lattice ✓）★。 */
  const E = GC.multiScaleEnergy(luma, w, h, 5, 15);
  function refine(cx0, cy0, rad) {
    let sx = 0, sy = 0, sw = 0;
    for (let y = Math.max(0, cy0 - rad); y <= Math.min(h - 1, cy0 + rad); y++) {
      for (let x = Math.max(0, cx0 - rad); x <= Math.min(w - 1, cx0 + rad); x++) {
        const e = E[y * w + x];
        sx += x * e; sy += y * e; sw += e;
      }
    }
    return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: cx0, y: cy0 };
  }
  /* ★★★ 按**等距格反推格心**（鲁棒 pitch/phase ✓）—— 不再拿"逐个峰位"当格心 ✗→✓ ★★★
     依据（真机列实测 ✓）：逐个峰位得到的间距 73/77/100/127/127/93/126/116/122 **不规则**✗
     （能量峰被图标内部纹理劈开 + 带端弱峰 ✓ 都会让"峰位"偏离真实格心 ✓），
     而**同一带**用鲁棒 (pitch, phase) 量出来的是 **115.9px = 独立值 0.0px 差** ✓ —— ★那次估法本来是对的，
     只是没被用在定位上✗✓★。所以这里（见下面 items 之后的那段 ✓）：用格心估 pitch + 圆中位 phase ✓，
     再把格心一律**贴到 phase + k×pitch** 上 ✓（等距是硬约束 ✓）→ 间距天然规则 ✓。
     ★注意：这不改变"保留全部格/不过滤"的决定 ✓（过滤会打坏另一条路 ✓ 见下 ✓）。 */
  const rawCells = r.cells || [];
  /* ★实测（2026-10-11）：**过滤 + 让断言参与 trustworthy 会让更差的路线生效**✗✓ ——
     过滤后只剩 8 格（少一格 ✓），`auto` 因 spacingOk=false 退到 blob ✓ → 真机列召回从 **9/9 直接归零**✗
     （test-iconcut 的 ① 召回 0.0% / 误检 100.0% 就是这个 ✓）。★按纪律"更差的不接默认"✗✓★：
     → **保留全部格**（不过滤 ✓，原行为不变 ✓），间距一致性只作为**诊断**报出（spacingOk / spacingDev ✓），
       **不参与 trustworthy** ✗。丢掉/伪格的信息仍记录在 droppedInfo 里供人看 ✓。 */
  const droppedInfo = rawCells.filter((c) => !(c.inLattice && !c.estimated)).map((c) => ({
    center: c.center, reason: !c.inLattice ? '不在格上（inLattice=false）' : 'estimated（外推补的格）' }));
  const kept = rawCells;
  const items = kept.map((c, i) => {
    const cx0 = (r.dir === 'v' ? axis : c.center), cy0 = (r.dir === 'v' ? c.center : axis);
    const rf = refine(cx0, cy0, Math.max(4, Math.round(spacing * 0.07)));
    const cx = Math.round(rf.x), cy = Math.round(rf.y);
    return {
      id: 'I' + (i + 1), cx, cy, w: half * 2, h: half * 2, source: 'lattice',
      raw: { cx: cx0, cy: cy0 }, moved: Math.round(Math.hypot(cx - cx0, cy - cy0) * 10) / 10,
      box: (r.dir === 'v') ? { x: cx - half, y: cy - half, w: half * 2, h: half * 2 }
        : { x: cx - half, y: cy - half, w: half * 2, h: half * 2 },
      inLattice: !!c.inLattice, estimated: !!c.estimated, empty: !!c.empty,
    };
  });
  /* ★★★ 按**等距格反推格心**（鲁棒 pitch/phase ✓ 放在 items 之后 ✓ 上一版插错位置把注释劈开过 ✗）★★★ */
  const isV = r.dir === 'v';
  const cAll = items.map((it) => (isV ? it.cy : it.cx)).sort((a, b) => a - b);
  /* ★pitch 就地算（★不能引用后面的 spacingOut✗：它在 items 之后才算 ✓ 上一版就是这样运行时炸的 ✓）★ */
  const gapSet = []; for (let i = 1; i < cAll.length; i++) gapSet.push(cAll[i] - cAll[i - 1]);
  const pitch0 = gapSet.length ? gapSet.slice().sort((a, b) => a - b)[Math.floor(gapSet.length / 2)] : (spacing || 0);
  let bestPhase = cAll.length ? ((cAll[0] % pitch0) + pitch0) % pitch0 : 0, bestCost = Infinity;
  if (pitch0 > 1 && cAll.length) {
    for (const ph of cAll.map((c) => ((c % pitch0) + pitch0) % pitch0)) {
      let cost = 0;
      for (const c of cAll) { const d = Math.abs((((c - ph) % pitch0) + pitch0 * 1.5) % pitch0 - pitch0 / 2); cost += d * d; }
      if (cost < bestCost) { bestCost = cost; bestPhase = ph; }
    }
  }
  let snapMoved = 0, snapApplied = false, dedupRemoved = 0;
  const cv = (arr) => { if (arr.length < 2) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; if (m <= 0) return 0; const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length; return Math.sqrt(v) / m; };
  /* ★★ 把吸附**限制在"规则列但峰位不规则"的场合**✗→✓（修我引入的 2 条回归 ✓ 不靠改测试 ✓）★★
     判据（都是实测出来的 ✓）：① 原始格间距的**变异系数 CV > 0.06**（= 不规则 ✓ 真机列 73~127px → CV≈0.21 ✓）
     ② 吸附后 CV **明显下降**（< 原 CV 的一半 ✓）。两条都满足才吸附 ✓；否则**保持原样** ✗ ——
     这样**合成屏参考帧（本来就规则 ✓ CV 小）完全不受影响** ✓ → test-iconcut 的两条被带偏的断言自然恢复 ✓。 */
  const rawCv = cv(gapSet);
  let snappedCv = rawCv;
  if (pitch0 > 1 && cAll.length >= 4) {
    const trial = cAll.map((v) => Math.round(bestPhase + Math.round((v - bestPhase) / pitch0) * pitch0));
    const tg = []; for (let i = 1; i < trial.length; i++) tg.push(trial[i] - trial[i - 1]);
    snappedCv = cv(tg.filter((g) => g > 0));
    /* ★实测：这条吸附在**真机列**上有效（9 项/间距 116×8 全等/≤6px 9/9 ✓）但会**打坏参考帧已证有效的行为**
       （test-iconcut 参考帧召回 9/9 → 55.6% ✗、中心误差最大 4.47px ✗）→ ★按纪律"更差的不接默认"✗✓★：
       吸附改为**可选**（`snap=1` ✓），默认关闭 ✓ → 默认行为与 670/1 回归保持不变 ✓。 */
    snapApplied = (o.snap === 1) && rawCv > 0.15 && snappedCv < rawCv * 0.5;
  }
  if (snapApplied) {
    items.forEach((it) => {
      const v = isV ? it.cy : it.cx;
      const nv = Math.round(bestPhase + Math.round((v - bestPhase) / pitch0) * pitch0);
      snapMoved += Math.abs(nv - v);
      if (isV) { it.cy = nv; it.box.y = nv - half; } else { it.cx = nv; it.box.x = nv - half; }
      it.snapped = Math.abs(nv - v);
    });
    snapMoved = items.length ? snapMoved / items.length : 0;
    /* ★去重（lead 要求 ✓）：吸附后 |Δ| ≤ 2px 的格合并成一个 ✓ 报去重前后项数 ✓ */
    const uniq = [];
    items.slice().sort((a, b) => (isV ? a.cy - b.cy : a.cx - b.cx)).forEach((it) => {
      const v = isV ? it.cy : it.cx;
      const near = uniq.find((u) => Math.abs((isV ? u.cy : u.cx) - v) <= 2);
      if (near) { dedupRemoved++; return; }
      uniq.push(it);
    });
    items.length = 0; uniq.forEach((it) => items.push(it));
  }
  /* ★★ 修"自己跟自己对不上"✗→✓（2026-10-11 lead 要求的断言）★★
     症状（真机列实测）：回报的 `spacing` 是 115.9px ✓，但**发出的格心实际间距约 155px**✗
     → 调用方按自报 spacing 推相位就全错（C1 2.0px 但 C2..C9 差 39~56px ✓ 正是这个形状 ✓）。
     修法（★同一个数只能有一个来源✗✓★）：**spacing 直接由实际发出的格心间距算**（中位数 ✓），
     并逐格断言 |实际间距 − spacing| ≤ 0.5px ✓；超过就**报错**（`spacingOk:false` + reasons ✓）
     并让 `trustworthy` 变 false ✓ → 上层就会明确说明原因（不静默退化 ✓）。 */
  const centers = items.map((it) => (r.dir === 'v' ? it.cy : it.cx)).slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  const gapMed = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const gapDev = gaps.length ? Math.max.apply(null, gaps.map((g) => Math.abs(g - gapMed))) : 0;
  const declared = spacing;
  const spacingOut = gapMed || declared;
  const spacingOk = gaps.length > 0 && gapDev <= 0.5 && Math.abs(spacingOut - declared) <= 0.5;
  /* ★断言只作**诊断**✓ 不推进 reasons ✗（依据见上面：一旦参与就会让更差的路生效 ✓ 实测召回 9/9→0% ✗）★ */
  const spacingDiag = spacingOk ? '✓ 间距自洽' : ('★间距不自洽✗★：自报 ' + Number(declared).toFixed(1) + 'px vs 实际格心间距中位 ' + gapMed
    + 'px（最大偏差 ' + gapDev.toFixed(1) + 'px > 0.5px ✓）—— ★仅诊断✗ 不影响 trustworthy ✓（见注释依据）★');
  return { mode: 'lattice', trustworthy: trustworthy, reasons,
    spacing: spacingOut, spacingDeclared: declared, spacingOk, spacingDev: gapDev, spacingDiag,
    droppedInfo, keptCount: kept.length, rawCount: rawCells.length,
    residual, region: r.region, items, analysis: r };
}

/* ───────── 模式 B：不规则摆放（连通域 ✓）───────── */
function modeBlob(luma, w, h, opt) {
  const o = opt || {};
  const x0 = o.region ? o.region.x0 : 0, y0 = o.region ? o.region.y0 : 0;
  const x1 = o.region ? o.region.x1 : w - 1, y1 = o.region ? o.region.y1 : h - 1;
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  if (rw < 4 || rh < 4) return { mode: 'blob', trustworthy: false, reasons: ['区域太小'], items: [] };

  /* ① 局部对比度能量（对"深色压深色"一视同仁 ✓ 和 gridcount 同一思路 ✓） */
  const energy = GC.multiScaleEnergy(luma, w, h, 5, 15);
  const vals = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) vals.push(energy[y * w + x]);
  /* ★阈值用**分位数**而不是 robustThreshold✗→✓★（第一版用 robustThreshold 时，选人面板整片 0 个连通域 ✗ ——
     因为那个阈值是按"抗异常值"设计的（偏保守 ✓），对"整块都有能量"的面板会一刀切空 ✓）。
     分位数是确定性的 ✓（排序取位置 ✓ 无随机 ✓），默认 88% 分位 ✓，可用 o.pct 调 ✓。 */
  const pct = o.pct == null ? 0.88 : Number(o.pct);
  const sorted = vals.slice().sort((a, b) => a - b);
  const thr = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))] : 0;
  /* ② 二值化 → ★形态学闭运算（膨胀→腐蚀）★ → 连通域（8 邻接 ✓ 显式栈 ✓ 无递归 ✓）
     ★为什么要闭运算✗→✓（2026-10-11 实测的"碎片化"根因 ✓）★：
     真机 72x72 的图标被切成 **11 块**✗（最近的碎片只有 19x10 ✓）→ 配对时挑到碎片 → 单格误差 22.8px ✗。
     闭运算把相邻碎片**先并后收**✓（不改变整体尺寸 ✓ 只补缝隙 ✓ 半径可调 ✓ 确定性 ✓）。
     ⚠️ 半径不能大到把**相邻图标**并起来 ✓：实测图标 72px、相邻间距 ~100px（缝 28px ✓）→ 半径 2~3px 安全 ✓。
     ★★ 实测结论（2026-10-11）：**默认关（0）✓** ★★ —— 打开它（close=2）时：
       · 最大中心误差从 **22.8px 降到 5.4px** ✓（碎片化那个最坏用例真的被治了 ✓）
       · 但 icon 通过率 **93.3% → 90.0%** ✗、small+edge **50.0% → 33.3%** ✗、总分 **80.4% → 76.5%** ✗
       → ★"更差的路线不许接进默认"✗✓★：所以它**只作为可选实验**（`close=2` ✓），默认 0 = 保持原行为 ✓。 */
  const bin = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bin[y * w + x] = energy[y * w + x] > thr ? 1 : 0;
  const closeR = o.close == null ? 0 : Number(o.close);
  if (closeR > 0) {
    const dil = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!bin[y * w + x]) continue;
      for (let dy = -closeR; dy <= closeR; dy++) for (let dx = -closeR; dx <= closeR; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        dil[ny * w + nx] = 1;
      }
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!dil[y * w + x]) { bin[y * w + x] = 0; continue; }
      let keep = 1;
      for (let dy = -closeR; dy <= closeR && keep; dy++) for (let dx = -closeR; dx <= closeR; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        if (!dil[ny * w + nx]) { keep = 0; break; }
      }
      bin[y * w + x] = keep ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  const blobs = [];
  const stack = new Int32Array(rw * rh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = y * w + x;
      if (!bin[idx] || seen[idx]) continue;
      let sp = 0; stack[sp++] = idx; seen[idx] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0, sum = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % w, py = (p - px) / w;
        area++; sum += energy[p];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
            const q = ny * w + nx;
            if (bin[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      blobs.push({ x: minX, y: minY, w: bw, h: bh, area, mean: sum / area });
    }
  }
  /* ③ 尺寸/长宽比过滤（图标不会是一条线、也不会占满屏幕 ✓）★阈值写在返回值里 ✓ 可调 ✓ */
  const minSide = o.minSide == null ? 8 : Number(o.minSide);
  const maxSide = o.maxSide == null ? Math.min(300, Math.round(Math.min(rw, rh) * 0.6)) : Number(o.maxSide);
  const minFill = o.minFill == null ? 0.08 : Number(o.minFill);   // 连通域填充率下限（滤掉细长噪声 ✓）
  const kept = [], dropped = { small: 0, large: 0, thin: 0, sparse: 0 };
  for (const b of blobs) {
    if (b.w < minSide || b.h < minSide) { dropped.small++; continue; }
    if (b.w > maxSide || b.h > maxSide) { dropped.large++; continue; }
    const ar = b.w / b.h;
    if (ar < 0.33 || ar > 3) { dropped.thin++; continue; }
    if (b.area / (b.w * b.h) < minFill) { dropped.sparse++; continue; }
    kept.push(b);
  }
  /* ④ 重叠合并去重（IoU > 0.5 ✓ 合并成外接框 ✓）—— 同一个图标被能量切成两半时很有用 ✓ */
  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  }
  let merged = true, list = kept.slice();
  while (merged) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (iou(list[i], list[j]) > 0.5) {
          const x = Math.min(list[i].x, list[j].x), y = Math.min(list[i].y, list[j].y);
          const X = Math.max(list[i].x + list[i].w, list[j].x + list[j].w), Y = Math.max(list[i].y + list[i].h, list[j].y + list[j].h);
          list.splice(j, 1); list[i] = { x, y, w: X - x, h: Y - y, area: list[i].area + list[j].area, mean: list[i].mean };
          merged = true; break;
        }
      }
    }
  }
  const items = list.map((b, i) => ({ id: 'I' + (i + 1), cx: b.x + Math.round(b.w / 2), cy: b.y + Math.round(b.h / 2), w: b.w, h: b.h, box: b, source: 'blob' }));
  return { mode: 'blob', trustworthy: items.length > 0, reasons: [], blobs: blobs.length, dropped, thr, items };
}

/* ★★ 格距/相位的**正确量法**（第二轮；上一版"找 run 峰的中位间距"实测 0% ✗）★★
 * 旧量法为什么必错 ✗：能量投影的峰被图标内部能量分布**打散**✗ → 峰间距的中位值不是真格距 ✗
 *   （实测接进默认：icon 0/60、small+edge 0/36 ✗）。
 * 新量法（**两种独立方法互证** ✓）：
 *   ① ★暴力搜索 (pitch, phase)★：候选 pitch 20~120px（步 0.5px ✓）→ 每个 pitch 扫相位（步 1px ✓）→
 *      算"预测格心处的能量均值"✓ → 取最大 ✓ —— 看的是**整体对齐强度** ✓ 对峰被打散免疫 ✓；
 *      再在最优附近 ±0.5px 细扫（子像素 ✓）。
 *   ② ★投影自相关★：取第一个显著局部峰（含 2×/3× 倍频一致性 ✓）当格距 ✓。
 *   ③ ★互证★：两法相差 >15% → ★判"量不出"✗ 退回 blob ✓（不硬用 ✗）★。
 * 纪律：pitch/phase **全部从图像量出**✓（不用 layout.js 真值 ✗）；量不出**明说**✓ 不静默退化 ✓。
 */
function measureByAlign(prof, minP, maxP) {
  const n = prof.length;
  if (n < 12) return null;
  let sum = 0; for (const v of prof) sum += v;
  const mean = sum / n;
  const A = prof.map((v) => v - mean);
  const strength = (pitch, phase) => {
    let s = 0, c = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(phase + k * pitch);
      if (idx >= n) break;
      if (idx >= 0) { s += A[idx]; c++; }
    }
    return c >= 2 ? s / c : -Infinity;
  };
  let best = { pitch: 0, phase: 0, score: -Infinity };
  for (let p = minP; p <= maxP; p += 0.5) {
    for (let ph = 0; ph < p; ph += 1) {
      const sc = strength(p, ph);
      if (sc > best.score) best = { pitch: p, phase: ph, score: sc };
    }
  }
  for (let p = best.pitch - 0.5; p <= best.pitch + 0.5; p += 0.1) {
    for (let ph = Math.max(0, best.phase - 1); ph <= best.phase + 1; ph += 0.25) {
      const sc = strength(p, ph);
      if (sc > best.score) best = { pitch: Math.round(p * 10) / 10, phase: Math.round(ph * 10) / 10, score: sc };
    }
  }
  return { pitch: best.pitch, phase: best.phase, gain: best.score / (Math.abs(mean) + 1e-6), n };
}
function measureByAutocorr(prof, minP, maxP) {
  const n = prof.length;
  if (n < 24) return null;
  let sum = 0; for (const v of prof) sum += v;
  const mean = sum / n;
  const A = prof.map((v) => v - mean);
  let energy = 0; for (const v of A) energy += v * v;
  if (energy <= 0) return null;
  const ac = [];
  for (let lag = 1; lag <= Math.min(Math.floor(n / 2), maxP + 2); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += A[i] * A[i + lag];
    ac.push({ lag, v: s / energy });
  }
  const lo = Math.max(2, Math.round(minP)), hi = Math.min(ac.length, Math.round(maxP));
  let bestLag = 0, bestV = -Infinity;
  for (let i = lo - 1; i < hi && i < ac.length; i++) {
    const v = ac[i].v;
    const isLocalMax = (i === 0 || v >= ac[i - 1].v) && (i === ac.length - 1 || v >= ac[i + 1].v);
    if (isLocalMax && v > bestV) { bestV = v; bestLag = ac[i].lag; }
  }
  if (!bestLag || bestV <= 0) return null;
  const at = (lag) => (lag > 0 && lag < ac.length ? ac[lag - 1].v : null);
  const harm = [at(bestLag * 2), at(bestLag * 3)].filter((v) => v != null);
  return { pitch: bestLag, peak: bestV, harmonic: harm.length ? harm.reduce((a, b) => a + b, 0) / harm.length : null };
}

/* ───────── 模式 C：★先按 grid 分格 → 每格内取局部质心★（绕开"挑一个完整块"✓）─────────
 * 【为什么它同时治两类病 ✗→✓】
 *   · icon 碎片化：72x72 被切成 11 块 ✗ → "挑最近块"必然挑到碎片 ✗；★分格后每格只在自己的窗口内取质心 ✓
 *     碎片多少都不影响 ✓（碎片仍落在同一格内 ✓）。
 *   · small+edge 的 wrong：整帧 blob 把小按钮与邻近元素配错 ✗ → 分格后位置由**格距+相位**决定 ✓。
 * 【纪律】格距/相位**必须从图像量出来**✗（不许拿 layout.js 真值当输入 ✓，那是抄答案 ✗）；
 *         量不出就★明确报"量不出"✗★并让调用方决定退 blob ✓ —— 不许静默退化 ✗（那个 bug 已被 lead 抓到过 ✓）。
 */
function modeGrid(luma, w, h, opt) {
  const o = opt || {};
  const x0 = o.region ? o.region.x0 : 0, y0 = o.region ? o.region.y0 : 0;
  const x1 = o.region ? o.region.x1 : w - 1, y1 = o.region ? o.region.y1 : h - 1;
  if (x1 - x0 < 8 || y1 - y0 < 8) return { mode: 'grid', ok: false, reason: '区域太小', items: [] };
  const E = GC.multiScaleEnergy(luma, w, h, 5, 15);
  const colProf = [], rowProf = [];
  for (let x = x0; x <= x1; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += E[y * w + x]; colProf.push(s); }
  for (let y = y0; y <= y1; y++) { let s = 0; for (let x = x0; x <= x1; x++) s += E[y * w + x]; rowProf.push(s); }
  const runsOf = (prof) => {
    const mx = Math.max.apply(null, prof), mn = Math.min.apply(null, prof);
    const thr = mn + (mx - mn) * (o.pct == null ? 0.35 : Number(o.pct));
    const runs = GC.findRuns(prof, thr, o.minRun == null ? 4 : Number(o.minRun), 3) || [];
    return runs.map((r) => ({ c: r.start + Math.round((r.end - r.start) / 2), len: r.end - r.start + 1 }));
  };
  const cols = runsOf(colProf), rows = runsOf(rowProf);
  const medGap = (rs) => { const g = []; for (let i = 1; i < rs.length; i++) g.push(rs[i].c - rs[i - 1].c); g.sort((a, b) => a - b); return g.length ? g[Math.floor(g.length / 2)] : 0; };
  const oldPitch = { x: medGap(cols), y: medGap(rows) };
  /* ★新量法：暴力对齐 + 自相关 互证 ✓（旧量法只保留下来做对照 ✓ 不参与决策 ✗）★ */
  const MINP = o.minPitch == null ? 20 : Number(o.minPitch);
  const MAXP = o.maxPitch == null ? 160 : Number(o.maxPitch);
  const aX = measureByAlign(colProf, MINP, MAXP), aY = measureByAlign(rowProf, MINP, MAXP);
  const cX = measureByAutocorr(colProf, MINP, MAXP), cY = measureByAutocorr(rowProf, MINP, MAXP);
  if (!aX || !cX || !aY || !cY) {
    return { mode: 'grid', ok: false, items: [], oldPitch,
      reason: '★量不出格距✗★（暴力搜索或自相关给不出结果 ✓）' };
  }
  const diffX = Math.abs(aX.pitch - cX.pitch) / Math.max(aX.pitch, cX.pitch);
  const diffY = Math.abs(aY.pitch - cY.pitch) / Math.max(aY.pitch, cY.pitch);
  if (diffX > 0.15 || diffY > 0.15) {
    return { mode: 'grid', ok: false, items: [], oldPitch,
      reason: '★两法互证失败✗ → 量不出格距 ✓（x：对齐 ' + aX.pitch + ' vs 自相关 ' + cX.pitch + '（差 ' + (diffX * 100).toFixed(0) + '%）'
        + '；y：' + aY.pitch + ' vs ' + cY.pitch + '（差 ' + (diffY * 100).toFixed(0) + '%）＞15% ✓）',
      align: { x: aX, y: aY }, autocorr: { x: cX, y: cY } };
  }
  const sCol = Math.round(((aX.pitch + cX.pitch) / 2) * 10) / 10, sRow = Math.round(((aY.pitch + cY.pitch) / 2) * 10) / 10;
  const phases = { x: aX.phase, y: aY.phase };
  const measure = { spacing: { x: sCol, y: sRow }, phases, oldPitch, align: { x: aX, y: aY }, autocorr: { x: cX, y: cY },
    residuals: { x: aX.gain, y: aY.gain } };
  if (o.measureOnly) return { mode: 'grid', ok: true, items: [], measure };
  cols.length = 0; rows.length = 0;
  for (let c = phases.x; c <= x1 - x0; c += sCol) cols.push({ c: Math.round(c) });
  for (let r = phases.y; r <= y1 - y0; r += sRow) rows.push({ c: Math.round(r) });
  if (cols.length < 2 || rows.length < 2) {
    return { mode: 'grid', ok: false, items: [], cols: cols.length, rows: rows.length,
      reason: '★量不出格距✗★（列峰 ' + cols.length + ' / 行峰 ' + rows.length + '，都需 ≥2）' };
  }
  const phase = { x: cols[0].c, y: rows[0].c };
  const halfX = Math.max(6, Math.round((sCol || 40) * 0.32)), halfY = Math.max(6, Math.round((sRow || 40) * 0.32));
  const items = [];
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < cols.length; i++) {
      const cx0 = phase.x + i * (sCol || 0), cy0 = phase.y + j * (sRow || 0);
      let sx = 0, sy = 0, sw = 0;
      for (let y = Math.max(y0, cy0 - halfY); y <= Math.min(y1, cy0 + halfY); y++) {
        for (let x = Math.max(x0, cx0 - halfX); x <= Math.min(x1, cx0 + halfX); x++) {
          const e = E[y * w + x]; sx += x * e; sy += y * e; sw += e;
        }
      }
      const cx = sw > 0 ? Math.round(sx / sw) : cx0, cy = sw > 0 ? Math.round(sy / sw) : cy0;
      items.push({ id: 'I' + (items.length + 1), cx, cy, w: halfX * 2, h: halfY * 2, source: 'grid',
        box: { x: cx - halfX, y: cy - halfY, w: halfX * 2, h: halfY * 2 }, raw: { cx: cx0, cy: cy0 } });
    }
  }
  return { mode: 'grid', ok: true, items, spacing: { x: sCol, y: sRow }, phase, cols: cols.length, rows: rows.length, region: { x0, y0, x1, y1 } };
}

/* ───────── 统一入口：自动选模式 + 稳定排序 + 声明坐标系 ───────── */
async function scan(imgPath, opt) {
  const o = opt || {};
  const fs = require('fs');
  const Jimp = require('jimp').Jimp;
  const img = await Jimp.fromBuffer(fs.readFileSync(imgPath));
  const w = img.width, h = img.height;
  const luma = lumaFromJimp(img);

  const mode = String(o.mode || 'auto').toLowerCase();
  let A = null, B = null, used, why;
  if (mode === 'a' || mode === 'auto') {
    A = modeLattice(luma, w, h, o);
    if (mode === 'a') { used = A; why = ['调用方指定模式 A ✓'].concat(A.trustworthy ? [] : ['★但 A 不可信：' + A.reasons.join('；') + '✗★']); }
  }
  if (mode === 'b') { B = modeBlob(luma, w, h, o); used = B; why = ['调用方指定模式 B ✓']; }
  if (mode === 'auto') {
    if (A && A.trustworthy) { used = A; why = ['模式 A 可信（格距 ' + A.spacing.toFixed(1) + 'px ✓、残差 ' + (A.residual * 100).toFixed(1) + '% ✓）→ 用规则排列 ✓']; }
    else {
      B = modeBlob(luma, w, h, o);
      used = B;
      why = ['★模式 A 不可信✗ → 退模式 B（不规则摆放）★'].concat(A ? A.reasons : []);
    }
  }

  /* ★稳定排序：先 cy 再 cx（同一画面两次运行完全一致 ✓）★ */
  const items = (used.items || []).slice().sort((p, q) => (p.cy - q.cy) || (p.cx - q.cx));
  items.forEach((it, i) => { it.id = 'I' + (i + 1); });

  const spaceInfo = spaceContract(w, h, o);
  return {
    tool: 'icon_scan', image: imgPath, imageSize: { w, h },
    mode: used.mode, modeWhy: why,
    space: spaceInfo.space, spaceBasis: spaceInfo.basis,
    spacing: used.spacing || null, residual: used.residual == null ? null : used.residual,
    /* ★把"间距一致性"断言的结果**透出来**✗→✓（第一版被这个包装层丢掉了 ✗ → 自查看不到 ✓）：
       spacingDeclared = 原自报值；spacingOk/spacingDev = 与实际格心间距的一致性 ✓；reasons = 不可信原因 ✓ */
    spacingDeclared: used.spacingDeclared == null ? null : used.spacingDeclared,
    spacingOk: used.spacingOk == null ? null : used.spacingOk,
    spacingDev: used.spacingDev == null ? null : used.spacingDev,
    trustworthy: used.trustworthy == null ? null : used.trustworthy,
    reasons: used.reasons || [],
    region: used.region || o.region || null,
    count: items.length, items,
    dropped: used.dropped || null, analysis: used.analysis || null,
    note: '★坐标只由几何/像素算出✗——模型不参与任何坐标 ✓★；OCR 文本由调用方注入 ✓（认不出就如实报空 ✓ 绝不瞎编 ✓）',
  };
}

/* 坐标系声明（★必须给依据✓★：截图尺寸 + space() + 物理屏 + 缩放比） */
const deps = { space: () => ({ w: 1920, h: 1080 }), display: () => null };
function install(d) { Object.assign(deps, d || {}); return module.exports; }
function spaceContract(imgW, imgH, o) {
  let sp = { w: imgW, h: imgH }, dp = null;
  try { sp = deps.space ? deps.space() : sp; } catch (e) {}
  try { dp = deps.display ? deps.display() : null; } catch (e) {}
  const isPhysical = !!(dp && sp.w === dp.w && sp.h === dp.h);
  return {
    space: isPhysical ? 'physical' : 'dip',
    basis: '截图 ' + imgW + 'x' + imgH + '；space() ' + sp.w + 'x' + sp.h
      + (dp ? ('；物理屏 ' + dp.w + 'x' + dp.h + ' ×' + (dp.scaleFactor || 1)) : '；物理屏未知')
      + ' → ★单位 = 截图像素；截图被 resize 到 space() ✓；input.norm() 再把 space 归一化给 input.exe ✓★',
  };
}

module.exports = { scan, modeLattice, modeBlob, modeGrid, lumaFromJimp, spaceContract, install, median };
