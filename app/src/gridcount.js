/* gridcount.js —— ★「数格子」：从像素里确定性地测出一列/一行等距格子的中心★
 *
 * 【为什么又要一个（find_grid 不是已经有吗 ✗）】
 *   2026-10-10 真机实测：`find_grid` 在**明日方舟右侧职业图标列**上**测不出来** ✗ ——
 *   只测到 1 段（它自己的回执也承认「细线/低对比图案测不出来 ✓」）。
 *   根因是它的算法本身 ✗（不是参数没调好）：
 *     · 它逐行算**平均亮度** ✓，再用**全局阈值** `mn + (mx-mn)*0.35` 切 ✗
 *       → 「深色图标压在深色背景上」时，整列的平均亮度几乎没有起伏 ✗；
 *         而同一块里只要有一处高光（立绘、按钮亮边 ✓），`mx` 就被拉高 ✗
 *         → 阈值被顶到图标之上 → 一段都切不出来 ✗。
 *     · 「图标」是**局部纹理**（边缘、明暗交替 ✓），不是「一行整体更亮」✗ ——
 *       用平均亮度去找图标，等于用「房间平均温度」去找房间里的蜡烛 ✗。
 *
 * 【本模块的四个关键改进（每一条都对应一次真机失败 ✓）】
 *   ① ★局部对比度能量★（不是绝对亮度）✗→✓：
 *      `|亮度 − 该像素邻域均值|`（box blur 用积分图 O(n) 算 ✓）。
 *      这个量对「深色压深色」和「亮色压亮色」**一视同仁** ✓ ——
 *      图标边缘、纹理、文字都会跳出来 ✓，纯色背景接近 0 ✓。
 *      ★真机实测★：这一条的阈值扫描在职业列上直接切出 9~10 段 ✓（find_grid 是 1 段 ✗）。
 *   ② ★抗异常值的阈值★（不是 min/max 线性插值）✗→✓：
 *      `中位数 + k × 1.4826×MAD`（robust z-score ✓）。一块高光不会把阈值顶飞 ✓。
 *   ③ ★谐波投票估格距★（不是"相邻间距取中位数"）✗→✓：
 *      一个图标可能被切成两段（内部有暗缝 ✓）→ 相邻间距里混进"半格"✗；
 *      而"ALL"与第一个职业之间的间距本来就和图标间距不同 ✗。
 *      改成：对所有两两间距 g 投票，谁最像它们的公约数谁赢 ✓（权重 1/round(g/d) ✓），
 *      再最小二乘细化 ✓。
 *   ④ ★格位由拟合决定，段只当锚点★✗→✓：
 *      段质心是**不对称**的（图标上半亮下半暗 ✓，实测偏 20~30px ✗）；
 *      而"格子中心"本来就该由格距决定 ✓（图标是等距贴上去的 ✓）。
 *      → 输出的是 phase + k×d 的格位 ✓，段只用来判断"这一格有东西 / 空着"✓。
 *
 * 【边界（诚实说 ✗）】
 *   · 它只回答「几何上有几个格子、各自中心在哪」✓ —— ★"第几格是哪个职业"是外部知识✗★，
 *     写在技能里（顺序由主人给定 ✓：ALL→先锋→近卫→重装→狙击→术师→医疗→辅助→特种 ✓）。
 *   · 段数≠格子数 ✗：立绘/文字/分隔线也会产生能量 ✓ → 离任何格位都远的段进 `leftover` ✓，
 *     如实列出来 ✓，不假装它们是格子 ✗。
 *   · 调用方给 `expect`（期望个数）时会**扫描阈值**找能得到该个数的参数 ✓；
 *     扫不到就明说扫不到 ✗（绝不假装 ✓）。
 *   · ★实测限制✗★：`autoBand`（自动找窄条）会被**窗口亮边框**骗到 ✗
 *     （一条通高亮边能量最大 ✓）→ 默认**关**✓，窄条由调用方显式给 ✓。
 *   · 它是**纯计算** ✓ → 纯 Node 可测（app/scripts/test-gridcount.js 用合成图断言 ✓）。
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════
 * 1. 亮度 / 局部对比度能量
 * ═══════════════════════════════════════════════════════════════ */

/* RGBA(BGRA) → 亮度一维数组。为什么不用 ColorMode 转换：这里要的是"能测"，
   不是"好看" ✓，而且调用方（UIA/抓帧）给的是 BGRA 位图 ✓。 */
function lumaFromBitmap(bmp, w, h, isBGRA) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = bmp[p], g = bmp[p + 1], b = bmp[p + 2];
    out[i] = isBGRA === false ? (0.299 * r + 0.587 * g + 0.114 * b) : (0.299 * b + 0.587 * g + 0.114 * r);
  }
  return out;
}

/* 积分图 → 任意半径的邻域均值（O(1)/点 ✓） */
function boxBlur(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const sum = I[(y1 + 1) * (w + 1) + (x1 + 1)] - I[y0 * (w + 1) + (x1 + 1)]
        - I[(y1 + 1) * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

/* ★核心量★：每个像素的「局部对比度能量」= |L − 邻域均值|
 * radius 默认 12：比图标（~40px）小、比文字笔画（2~3px）大 ✓ ——
 * 太小会只剩笔画边缘（细碎 ✓），太大会把整列当成"一块平色"✗。 */
function localEnergy(luma, w, h, radius) {
  const blur = boxBlur(luma, w, h, radius == null ? 12 : radius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.abs(luma[i] - blur[i]);
  return out;
}

/* 横向/纵向梯度再补一道：细线描边很强的图标，在局部对比下可能偏弱，梯度能抬起来 ✓。取最大值 ✓ */
function gradientEnergy(luma, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x + 1 < w ? Math.abs(luma[i + 1] - luma[i]) : 0;
      const dy = y + 1 < h ? Math.abs(luma[i + w] - luma[i]) : 0;
      out[i] = Math.max(dx, dy);
    }
  }
  return out;
}

/* ★三个尺度的能量取最大值★（每一条都对应一种"测不到"✗→✓）：
 *   ① 小尺度局部对比（radius 12）→ 图标内部的纹理/笔画 ✓（真机职业列就是靠这一条 ✓）
 *   ② 梯度                        → 细线描边 ✓
 *   ③ ★大尺度对比（radius 48）★   → ★一整块**纯色**的格子（没有任何内部结构 ✗）★
 *      为什么必须有③✗：合成图单测抓出来的真洞 ✓ —— 一个 40×40 的**纯色**方块，
 *      在小尺度局部对比下**内部能量≈0** ✗（方块里到处都是同色 ✓），
 *      于是"按行平均"之后只剩两条边 ✓ → 一整行/一列纯色按钮会数不出来 ✗。
 *      大尺度（半径比格子还大 ✓）下它相对背景就"高出来"了 ✓。
 *      ⚠️ 系数 0.6 是**故意的**：大尺度会把"整片亮度渐变"也算成能量 ✗，
 *        压低它的权重、并且只在它明显更大时才起作用 ✓（取 max 的时候它得赢过前两条 ✓）。 */
function multiScaleEnergy(luma, w, h, r1, r2) {
  const e1 = localEnergy(luma, w, h, r1 == null ? 12 : r1);
  const e2 = localEnergy(luma, w, h, r2 == null ? 48 : r2);
  const g = gradientEnergy(luma, w, h);
  const out = new Float32Array(e1.length);
  for (let i = 0; i < out.length; i++) {
    const big = e2[i] * 0.6;
    out[i] = Math.max(e1[i], g[i], big);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════
 * 2. 一维投影 / 平滑 / 抗异常值阈值 / 找段
 * ═══════════════════════════════════════════════════════════════ */

/* 把 2D 能量沿 dir 投影成一维：'v' → 每行的平均能量（横跨 x0..x1）✓ */
function projectEnergy(E, w, h, dir, x0, x1, y0, y1) {
  const xs = Math.max(0, Math.round(x0 == null ? 0 : x0));
  const xe = Math.min(w - 1, Math.round(x1 == null ? w - 1 : x1));
  const ys = Math.max(0, Math.round(y0 == null ? 0 : y0));
  const ye = Math.min(h - 1, Math.round(y1 == null ? h - 1 : y1));
  const p = [];
  if (dir === 'h') {
    for (let x = xs; x <= xe; x++) {
      let s = 0, n = 0;
      for (let y = ys; y <= ye; y++) { s += E[y * w + x]; n++; }
      p.push(n ? s / n : 0);
    }
  } else {
    for (let y = ys; y <= ye; y++) {
      let s = 0, n = 0;
      for (let x = xs; x <= xe; x++) { s += E[y * w + x]; n++; }
      p.push(n ? s / n : 0);
    }
  }
  return { prof: p, offset: dir === 'h' ? xs : ys, x0: xs, x1: xe, y0: ys, y1: ye };
}

function movingAverage(a, k) {
  const n = a.length, out = new Array(n);
  const r = Math.max(0, Math.floor((k || 3) / 2));
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += a[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

/* ★抗异常值阈值★：中位数 + k × 1.4826×MAD（= 稳健标准差 ✓） */
function robustThreshold(a, k) {
  const s = Array.from(a).sort((x, y) => x - y);
  const n = s.length;
  if (!n) return { thr: 0, med: 0, mad: 0, sd: 0 };
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const dev = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y);
  const mad = n % 2 ? dev[(n - 1) / 2] : (dev[n / 2 - 1] + dev[n / 2]) / 2;
  const sd = 1.4826 * mad;
  const thr = med + (k == null ? 2.5 : k) * (sd > 1e-6 ? sd : 1e-6);
  return { thr, med, mad, sd };
}

/* ★Otsu 阈值（大津法）★ —— 一维剖面的**双峰**切分，比"中位数+MAD"更稳 ✓
 * 为什么需要它✗→✓：合成图单测抓出来的第二个洞 ✓ —— 当"有内容"的位置占比不小
 * （例如一列纯色按钮 ✓ 或大尺度能量会**渗到邻居列**✓）时，
 * ★MAD 会被这些值撑大 ✗★ → `中位数 + k×MAD` 的阈值高到把真内容也切掉 ✗
 * （实测：图标带 4.07、背景带 1.05，而阈值被顶到 4.99 ✗ → 一段都切不出来 ✗）。
 * Otsu 直接找"让类间方差最大"的那个分界 ✓，对双峰剖面就是正确答案 ✓。
 * ⚠️ ★但它不能无条件用✗★：纯色剖面（什么内容都没有 ✓）也会被它切出一个"分界"✗ →
 *   所以下面有两道否决（分离度 eta ✓ + 两类均值差 ✓），过不了就退回 MAD 阈值 ✓
 *   （那条路在纯色上会给出"切不出任何段"✓，正是我们要的诚实结果 ✓）。 */
function otsuThreshold(prof) {
  const n = prof.length;
  if (n < 8) return null;
  let mn = Infinity, mx = -Infinity;
  for (const v of prof) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = mx - mn;
  if (!(span > 1e-6)) return null;
  const BINS = 64;
  const hist = new Float64Array(BINS);
  for (const v of prof) {
    let b = Math.floor((v - mn) / span * BINS);
    if (b >= BINS) b = BINS - 1;
    if (b < 0) b = 0;
    hist[b]++;
  }
  let total = n, sum = 0;
  for (let b = 0; b < BINS; b++) sum += b * hist[b];
  let w0 = 0, sum0 = 0, best = -1, bestEta = 0, bestM0 = 0, bestM1 = 0, bestW0 = 0, bestW1 = 0;
  for (let b = 0; b < BINS; b++) {
    w0 += hist[b];
    if (w0 === 0) continue;
    const w1 = total - w0;
    if (w1 === 0) break;
    sum0 += b * hist[b];
    const m0 = sum0 / w0, m1 = (sum - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best) { best = between; bestM0 = m0; bestM1 = m1; bestW0 = w0; bestW1 = w1; }
  }
  if (best < 0) return null;
  /* 总方差（用于 eta 归一化） */
  let mean = 0;
  for (let b = 0; b < BINS; b++) mean += b * hist[b];
  mean /= total;
  let varTot = 0;
  for (let b = 0; b < BINS; b++) varTot += hist[b] * (b - mean) * (b - mean);
  const eta = varTot > 1e-9 ? best / varTot : 0;
  const m0v = mn + bestM0 / BINS * span, m1v = mn + bestM1 / BINS * span;
  /* ★两道否决（过不了就退回 MAD）★ */
  if (!(eta >= 0.55 && bestW0 >= total * 0.15 && bestW1 >= total * 0.03)) return null;
  if (!((m1v - m0v) >= 0.35 * span)) return null;
  /* 分界取两类均值的中点（比直方图 bin 边界稳 ✓） */
  return { thr: (m0v + m1v) / 2, m0: m0v, m1: m1v, eta, how: 'otsu' };
}

/* 连续段：高于阈值 → 段；段间小空隙（<= mergeGap）合并（一个图标内部会有暗缝 ✓） */
function findRuns(prof, thr, minLen, mergeGap) {
  const raw = [];
  let cur = null;
  for (let i = 0; i < prof.length; i++) {
    if (prof[i] > thr) { if (!cur) cur = { a: i, b: i }; else cur.b = i; }
    else if (cur) { raw.push(cur); cur = null; }
  }
  if (cur) raw.push(cur);
  const mg = mergeGap == null ? 4 : mergeGap;
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b - 1 <= mg) last.b = r.b;
    else merged.push({ a: r.a, b: r.b });
  }
  const min = Math.max(1, minLen == null ? 6 : minLen);
  return merged
    .filter((r) => r.b - r.a + 1 >= min)
    .map((r) => {
      /* 加权质心（用能量加权 ✓ 比几何中点稳 ✓）＋ 几何中点（对称性未知时更保守 ✓） */
      let ws = 0, ss = 0, peak = 0, ink = 0;
      for (let i = r.a; i <= r.b; i++) { const v = prof[i]; ws += v; ss += v * i; ink += v; if (v > peak) peak = v; }
      return { a: r.a, b: r.b, len: r.b - r.a + 1, center: ws > 0 ? ss / ws : (r.a + r.b) / 2, mid: (r.a + r.b) / 2, peak, ink };
    });
}

/* ═══════════════════════════════════════════════════════════════
 * 3. ★成格★：谐波投票估格距 → 投票估相位 → 格位由拟合决定
 * ═══════════════════════════════════════════════════════════════ */
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/* ★格距估计★：候选中心两两间距里，找出「最大公约数式」的那个 d ✓
 * ⚠️ 真机踩过的坑（第一版）✗：容差如果按 d 成比例放大（0.28×d ✓），
 *    d 越大能"接住"的间距越多 → 谐波投票会**偏爱大的伪格距** ✗
 *    （实测：真格距 113px 的列，被投成了 283px，格子数从 9 掉到 4 ✗）。
 *    → 投票容差取 `min(0.28×d, 14px)` ✓：14px 是"图标贴歪/切段质心偏"的合理上界 ✓。 */
function estimateSpacing(centers, tol) {
  const cs = centers.slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const g = cs[j] - cs[i];
      if (g >= 6 && g <= 600) gaps.push(g);
    }
  }
  if (!gaps.length) return 0;
  const cands = Array.from(new Set(gaps)).filter((g) => g >= 8);
  let best = 0, bestScore = 0;
  for (const d of cands) {
    if (!(d > 3)) continue;
    const et = Math.min(tol * d, 14);            // ★绝对上限，防"大格距占便宜"✗→✓★
    let score = 0;
    for (const g of gaps) {
      const k = Math.round(g / d);
      if (k < 1) continue;
      if (Math.abs(g - k * d) <= et) score += 1 / k;   // 整数倍越小，证据越硬 ✓
    }
    const bonus = d >= 20 && d <= 400 ? 1.05 : 1;      // 偏爱"图标高度量级"的格距 ✓
    if (score * bonus > bestScore) { bestScore = score * bonus; best = d; }
  }
  /* 最小二乘细化：d 让 g ≈ k*d 拟合最好 ✓ */
  let num = 0, den = 0;
  for (const g of gaps) {
    const k = Math.round(g / best);
    if (k < 1) continue;
    if (Math.abs(g - k * best) > Math.min(tol * best, 14)) continue;
    num += g * k; den += k * k;
  }
  return den > 0 ? num / den : best;
}

/* ★相位★：把所有候选中心投影到 [0,d)，取"能盖住最多候选"的那个相 ✓（容差同样封顶 15px ✓） */
function estimatePhase(centers, d, tol) {
  const et = Math.min(tol * d, 15);
  let bestP = 0, bestN = -1;
  for (const c of centers) {
    const p = ((c % d) + d) % d;
    let n = 0;
    for (const c2 of centers) {
      let r = (((c2 - p) % d) + d) % d;
      if (r > d / 2) r -= d;
      if (Math.abs(r) <= et) n++;
    }
    if (n > bestN) { bestN = n; bestP = p; }
  }
  return { phase: bestP, anchored: bestN };
}

/* 段 → ★格子清单★。★这里的设计经过一次真机纠正✗→✓★：
 *   第一版把格子中心取成"拟合出来的格位"（phase + k×d）✗ —— 在职业列上翻车了 ✓：
 *     真实的 9 个东西是 **ALL（文字按钮） + 8 个职业图标** ✓，
 *     而 ALL 与第一个图标之间只有 75px、其余之间是 115px ✗ ——
 *     强行套一个等距格位，就会**凭空在 ALL 上方多造一个空格、把 ALL 贬成"未成格"** ✗。
 *   ★纠正后的规矩★：
 *     ① **格子 = 测到的段**（在哪儿有东西，就是哪儿 ✓ 确定性 ✓），一个都不少 ✓；
 *     ② 另外用拟合出来的格距 d / 相位，给每格打一个 `inLattice` 标记 ✓
 *        —— "它是不是按主格距等距排列的" ✓（ALL 会 faithfully 标成 false ✓）；
 *     ③ 两个同格链的段之间若相距 ≈ k×d（k≥2 ✓，中间真的缺了东西 ✓）→ **补 k−1 个估计格** ✓
 *        并标 `estimated:true`（★我说清楚这是"推出来的"✗ 不是"看到的"✓★）；
 *     ④ 输出 spacing / cv / consistent 只统计**同格链上**的间距 ✓
 *        （把 ALL 的 75px 混进去算 CV 会得出"间距不一致"✗ —— 那是在算两件不同的东西 ✗）。 */
function lattice(runs, opts) {
  const o = opts || {};
  const tol = o.tol == null ? 0.28 : o.tol;
  if (!runs.length) {
    return { cells: [], spacing: 0, cv: 0, consistent: false, offLattice: [], all: [], anchors: 0, phase: 0 };
  }
  const sorted = runs.slice().sort((a, b) => a.center - b.center);
  const centers = sorted.map((r) => r.center);
  const d = o.spacing && o.spacing > 3 ? o.spacing : estimateSpacing(centers, tol);
  if (!(d > 3)) {
    /* 段都挤在一起（没有周期性 ✓）→ 不硬凑格：如实报"没有格距" ✓ */
    return {
      cells: sorted.map((r) => ({ center: Math.round(r.center), run: r, empty: false, estimated: false, inLattice: false, ink: r.ink })),
      spacing: 0, cv: 0, consistent: false, offLattice: [], all: sorted, anchors: 0, phase: 0,
    };
  }
  const et = Math.min(tol * d, 15);
  const { phase } = estimatePhase(centers, d, tol);
  const onLattice = (c) => {
    let r = (((c - phase) % d) + d) % d;
    if (r > d / 2) r -= d;
    return Math.abs(r) <= et;
  };
  const cells = sorted.map((r) => ({
    center: Math.round(r.center), run: r, empty: false, estimated: false,
    inLattice: onLattice(r.center), ink: r.ink, a: r.a, b: r.b, len: r.len,
  }));
  /* 缺失的格子：同格链上相邻两段相距 k×d（k≥2）→ 补 k−1 个估计格 ✓ */
  const chain = cells.filter((c) => c.inLattice);
  for (let i = 1; i < chain.length; i++) {
    const g = chain[i].center - chain[i - 1].center;
    const k = Math.round(g / d);
    if (k >= 2 && Math.abs(g - k * d) <= et) {
      for (let j = 1; j < k; j++) {
        cells.push({ center: Math.round(chain[i - 1].center + j * d), run: null, empty: true, estimated: true, inLattice: true, ink: 0 });
      }
    }
  }
  cells.sort((a, b) => a.center - b.center);
  const offLattice = cells.filter((c) => !c.inLattice && !c.estimated);
  const cs = chain.map((c) => c.center);
  const gs = [];
  for (let i = 1; i < cs.length; i++) gs.push(cs[i] - cs[i - 1]);
  const mean = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : d;
  const sd = gs.length ? Math.sqrt(gs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / gs.length) : 0;
  const gapCv = mean > 0 ? sd / mean : 0;
  /* ★成格的判据用"残差"而不是"相邻间距的 CV"✗→✓★
     为什么：段质心本身带噪声（图标上下不对称 ✓ 实测偏 20~30px ✗），
     "相邻间距 CV" 会把这个噪声放大成 5~12% ✗，看起来像"间距不一致"✗ ——
     但那不是"格子不等距"，是"我量的中心有噪声" ✓，两件事不能混 ✗。
     残差 = 每个段离最近格位的距离 ✓（格距由全体投票拟合 ✓）：它直接回答
     "这些段是不是等距排的" ✓，实测职业列 ≈ 2~4% ✓（阈值 12% ✓）。 */
  const res = chain.map((c) => {
    let r = (((c.center - phase) % d) + d) % d;
    if (r > d / 2) r -= d;
    return r;
  });
  const rMean = res.length ? res.reduce((a, b) => a + b, 0) / res.length : 0;
  const resCv = d > 0 && res.length
    ? Math.sqrt(res.reduce((a, b) => a + Math.pow(b - rMean, 2), 0) / res.length) / d
    : 0;
  /* ★成格的可信度★：同格链要够长（≥3 ✓ 且占候选 ≥60% ✓），残差要小 ✓ */
  const consistent = chain.length >= 3 && chain.length >= sorted.length * 0.6 && resCv <= (o.cvMax == null ? 0.12 : o.cvMax);
  /* ★可信度分级（诚实标注 ✓）★：成格 ≠ 结果可用 ✗。
     实测反例（真机 ✓）：在整屏上搜窄条时挑到"某列表的密排小字"✗ ——
       它确实等距（spacing 23.6px、40 格 ✓），但那是**文字行**不是图标列 ✗，
       而且 40 格里 23 格是"估"出来的 ✓。
     判据：① 成的格要占大头（fill ≥ 0.55 ✓）② 格距要在"图标/行高"量级（≥ 16px ✓）。 */
  const estimated = cells.filter((c) => c.estimated).length;
  const fill = cells.length ? chain.length / cells.length : 0;
  const plausible = chain.length >= 3 && fill >= 0.55 && d >= 16 && cells.length <= 80;
  return {
    cells, spacing: d, cv: resCv, gapCv, consistent, plausible, fill, estimated,
    offLattice, all: sorted, anchors: chain.length, phase,
  };
}

/* ═══════════════════════════════════════════════════════════════
 * 4. 一次完整分析（含"扫阈值凑期望个数"）
 * ═══════════════════════════════════════════════════════════════ */
/* 自动找**窄条**：找"沿着格子方向**交替**得最厉害"的那一条带 ✓。
 * ★为什么不是"能量最大的那条带"✗★（真机实测的坑✓）：
 *   窗口有一条**通高的亮边框** —— 它每一行都亮 ✓，总能量巨大 ✓，
 *   于是"按总能量挑"永远挑到它 ✗（实测挑出 1727~1810 那条窗口边 ✓）。
 * ★判别方法★：**逐列**算能量沿 y 的**标准差** ✓ ——
 *   图标列：有的行有图标、有的行没有 → 标准差大 ✓；
 *   亮边框：每一行都一样亮 → 标准差 ≈ 0 ✓。这一条把两者干净地分开了 ✓。 */
function autoBand(E, w, h, dir, region, minBand) {
  const r = region || {};
  const x0 = r.x0 == null ? 0 : r.x0, x1 = r.x1 == null ? w - 1 : r.x1;
  const y0 = r.y0 == null ? 0 : r.y0, y1 = r.y1 == null ? h - 1 : r.y1;
  const cross = [];
  if (dir === 'h') {
    for (let y = y0; y <= y1; y++) {
      let s = 0, ss = 0, n = 0;
      for (let x = x0; x <= x1; x++) { const v = E[y * w + x]; s += v; ss += v * v; n++; }
      const m = n ? s / n : 0;
      cross.push({ at: y, v: Math.sqrt(Math.max(0, (n ? ss / n : 0) - m * m)) });
    }
  } else {
    for (let x = x0; x <= x1; x++) {
      let s = 0, ss = 0, n = 0;
      for (let y = y0; y <= y1; y++) { const v = E[y * w + x]; s += v; ss += v * v; n++; }
      const m = n ? s / n : 0;
      cross.push({ at: x, v: Math.sqrt(Math.max(0, (n ? ss / n : 0) - m * m)) });
    }
  }
  const vals = cross.map((b) => b.v);
  const minB = minBand == null ? 12 : minBand;
  const { med, sd } = robustThreshold(vals, 1.0);
  const thr = med + Math.max(sd, 1);
  const runs = findRuns(vals, thr, minB, 6);
  if (!runs.length) return null;
  const best = runs.reduce((a, b) => (b.ink > a.ink ? b : a), runs[0]);
  if (dir === 'h') return { x0: x0, x1: x1, y0: y0 + best.a, y1: y0 + best.b, bands: runs.length };
  return { x0: x0 + best.a, x1: x0 + best.b, y0: y0, y1: y1, bands: runs.length };
}

/* analyze：纯计算入口（luma 是 w*h 的 Float32Array ✓）
 * opts: { dir:'v'|'h', region:{x0,y0,x1,y1}, k:阈值倍数, minLen:最短段, radius:局部对比半径,
 *         expect:期望格子数, autoBand:是否自动找窄条（默认 false ✗ 见文件头）, tol, cvMax } */
function analyze(luma, w, h, opts) {
  const o = opts || {};
  const dir = String(o.dir || 'v').toLowerCase().startsWith('h') ? 'h' : 'v';
  const radius = o.radius == null ? 12 : o.radius;
  const minLen = o.minLen == null ? 8 : o.minLen;
  const k = o.k == null ? 2.5 : o.k;
  const reg = o.region || {};
  const energy = multiScaleEnergy(luma, w, h, radius, o.radius2);
  let region = {
    x0: reg.x0 == null ? 0 : Math.max(0, Math.round(reg.x0)),
    y0: reg.y0 == null ? 0 : Math.max(0, Math.round(reg.y0)),
    x1: reg.x1 == null ? w - 1 : Math.min(w - 1, Math.round(reg.x1)),
    y1: reg.y1 == null ? h - 1 : Math.min(h - 1, Math.round(reg.y1)),
  };
  if (region.x1 <= region.x0 || region.y1 <= region.y0) throw new Error('区域不合法：' + JSON.stringify(region));
  let bandInfo = null;
  if (o.autoBand === true) {
    const band = autoBand(energy, w, h, dir, region, o.minBand);
    if (band) { bandInfo = band; region = { x0: band.x0, y0: band.y0, x1: band.x1, y1: band.y1 }; }
  }
  const runOnce = (kk) => {
    const { prof, offset } = projectEnergy(energy, w, h, dir, region.x0, region.x1, region.y0, region.y1);
    const sm = movingAverage(prof, o.smooth == null ? 3 : o.smooth);
    const T = otsuThreshold(sm) || (() => { const r0 = robustThreshold(sm, kk); r0.how = 'mad'; return r0; })();
    const runs = findRuns(sm, T.thr, minLen, o.mergeGap == null ? 5 : o.mergeGap);
    const runsAbs = runs.map((r) => Object.assign({}, r, { a: r.a + offset, b: r.b + offset, center: r.center + offset, mid: r.mid + offset }));
    const lat = lattice(runsAbs, {
      tol: o.tol, cvMax: o.cvMax, spacing: o.spacing,
      lo: dir === 'v' ? region.y0 : region.x0,
      hi: dir === 'v' ? region.y1 : region.x1,
    });
    return { thr: T, runs: runsAbs, lat };
  };
  /* ★窄条搜索★（真机教训的补救 ✓）：主人/模型给的很可能是**一整列区域**（含背景/立绘 ✓），
     直接把整块投影会把图标能量摊薄 ✗（实测：120px 宽的一整条上阈值后只剩 1 段 ✗）。
     所以当区域比一个"格子的宽度量级"大得多时，主动扫一批**窄条** ✓，
     取"成格链最长"的那一条 ✓（确定性搜索，不是猜 ✗）。 */
  let bandSearch = null;
  if (o.bandSearch) {
    const cross = dir === 'v' ? region.x1 - region.x0 : region.y1 - region.y0;
    const bw = Math.max(24, Math.min(o.bandSearch, 96));
    if (cross > bw) {
      const step = Math.max(6, Math.round(bw / 4));
      let best = null;
      let tried = 0;
      for (let s = 0; s + bw <= cross + step; s += step) {
        const sub = dir === 'v'
          ? { x0: region.x0 + s, x1: Math.min(region.x1, region.x0 + s + bw), y0: region.y0, y1: region.y1 }
          : { x0: region.x0, x1: region.x1, y0: region.y0 + s, y1: Math.min(region.y1, region.y0 + s + bw) };
        if (sub.x1 - sub.x0 < 16 || sub.y1 - sub.y0 < 16) continue;
        const keep = region;
        region = sub;
        let r2 = null;
        try { r2 = runOnce(k); } catch (e) { r2 = null; }
        region = keep;
        tried++;
        if (!r2) continue;
        const sc = r2.lat.anchors * 10 + (r2.lat.consistent ? 200 : 0)
          + (r2.lat.spacing >= 40 && r2.lat.spacing <= 400 ? 25 : 0)      // ★粗格距（图标/行）优先 ✓
          - (r2.lat.cells.length - r2.lat.anchors) * 12;                  // ★"估"出来的格要罚 ✗
        if (!best || sc > best.score) best = { score: sc, sub, anchors: r2.lat.anchors, consistent: r2.lat.consistent, spacing: r2.lat.spacing, cells: r2.lat.cells.length };
      }
      if (best && best.anchors >= 2) {
        bandSearch = { tried, band: best.sub, anchors: best.anchors, consistent: best.consistent, spacing: Math.round(best.spacing), cells: best.cells };
        region = best.sub;
      } else {
        bandSearch = { tried, band: null, best: best || null };
      }
    }
  }
  let res = runOnce(k);
  /* ★期望个数★：扫阈值找一个能得到 expect 格的参数 ✓（扫不到就如实说 ✓） */
  let sweep = null;
  if (o.expect > 0) {
    const hits = [];
    for (let kk = 1.0; kk <= 9.01; kk += 0.25) {
      const r2 = runOnce(Math.round(kk * 100) / 100);
      if (r2.lat.cells.length === o.expect && r2.lat.consistent) hits.push(Math.round(kk * 100) / 100);
    }
    sweep = { expect: o.expect, hitKs: hits, found: hits.length > 0 };
    if (hits.length && !(res.lat.cells.length === o.expect && res.lat.consistent)) {
      const mid = hits[Math.floor(hits.length / 2)];
      res = runOnce(mid);
      res.pickedK = mid;
    }
  }
  /* ★质量结论（如实说 ✗）★：用户/模型只看结论，所以结论里必须带"靠不靠得住" ✓ */
  const reasons = [];
  if (!res.lat.cells.length) reasons.push('一条带里没测出任何段');
  else {
    if (!(res.lat.anchors >= 3)) reasons.push('成格的段太少（' + res.lat.anchors + '）');
    if (res.lat.fill < 0.55) reasons.push('多数格是推算出来的（如实测 ' + res.lat.anchors + ' 段 / 共 ' + res.lat.cells.length + ' 格）');
    if (!(res.lat.spacing >= 16)) reasons.push('格距只有 ' + res.lat.spacing.toFixed(1) + 'px（更像文字行，不是图标格）');
    if (res.lat.cv > (o.cvMax == null ? 0.12 : o.cvMax)) reasons.push('残差偏大（' + (res.lat.cv * 100).toFixed(1) + '%）');
  }
  return {
    dir, region, bandInfo, bandSearch, k: res.pickedK || k,
    threshold: res.thr, runs: res.runs, cells: res.lat.cells,
    spacing: res.lat.spacing, cv: res.lat.cv, gapCv: res.lat.gapCv,
    consistent: res.lat.consistent, plausible: res.lat.plausible, fill: res.lat.fill,
    estimated: res.lat.estimated, anchors: res.lat.anchors, phase: res.lat.phase,
    offLattice: res.lat.offLattice, sweep,
    quality: { verdict: (res.lat.plausible && res.lat.consistent) ? 'ok' : 'weak', reasons },
    width: w, height: h, radius, minLen,
  };
}

module.exports = {
  lumaFromBitmap, boxBlur, localEnergy, gradientEnergy, multiScaleEnergy,
  projectEnergy, movingAverage, robustThreshold, findRuns,
  median, estimateSpacing, estimatePhase, lattice, autoBand, analyze,
};
