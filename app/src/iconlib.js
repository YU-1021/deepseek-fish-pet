/* iconlib.js —— ★图标模板库：把"格子几何"和"图标名字"接起来★（纯 Node + jimp ✓ 可单测 ✓）
 *
 * 【它解决的是什么✗→✓】
 *   明日方舟右侧那列职业图标是**纯图形、没有文字、不在控件树里**✗ ——
 *   OCR（find_text）和 UIA 都看不见它们 ✓；grid_count 只能给出"格子在哪"（实测 9 格 / 115.7px / 残差 4.6% ✓），
 *   ★说不出"这一格是哪个职业"✗★。
 *   本模块补上那一半 ✓：
 *     ★位置（几何）由 grid_count 给 ✓；名字（含义）由**模板库**给 ✓；全程不需要模型报坐标 ✗★。
 *   一句话流程：★切格 → 每格和模板库比 → 得到名字 + 分数 ✓★。
 *
 * 【★为什么名字里必须带位置序号✗→✓★】
 *   今天真出过事：一个**名字写着「狙击」的模板其实是近卫那一格**✗ —— 因为模板是"手工截一下、随便起个名"来的 ✓。
 *   本模块的对策（两条一起）：
 *     ① ★文件名的前缀就是它在那一列里的序号★（`t03_狙击.png` ✓）——
 *        序号是**几何给的**（grid_count 测出来的顺序 ✓），名字是人/模型给的 ✓，两者**分开存** ✓，
 *        以后一眼就能看出"这个模板是哪一格" ✓；
 *     ② 库里同时存**这一格当时的几何**（中心/格距/区域 ✓）→ 下次对不上时能看出来是不是选错了列 ✓。
 *
 * 【匹配算法（每一条都对应一种"分数一掉就找不到"✗）】
 *   ① ★灰度 + 统一尺寸 + z-score 归一化★（减均值、除标准差 ✓）——
 *      对**整体亮度/对比度变化**不敏感 ✓（截屏时窗口亮一点暗一点、JPEG 噪声 ✓）；
 *   ② ★多尺度★（模板按 0.85/0.92/1.00/1.08/1.15 缩放后再比 ✓）——
 *      游戏缩放/分辨率变化会让图标大小差几个像素 ✓，单尺度必掉分 ✗；
 *   ③ ★NCC（归一化互相关）★打分 ✓（-1~1 ✓，1 = 完全一致 ✓）——
 *      比"绝对差"抗亮度和噪声 ✓；
 *   ④ ★dHash 粗筛★（64 位感知哈希 ✓ + 汉明距离 ✓）——
 *      候选多时先筛掉明显不像的 ✓（纯 Node、零依赖 ✓）；
 *   ⑤ ★匹配不到就如实说"没匹配上"✗★（低于阈值绝不硬凑 ✓）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const GC = require('./gridcount');

const PATCH = 48;          // 统一到的模板边长（像素 ✓）—— 48 够小（快 ✓）也够大（认得出 ✓）
/* ★★ 三个阈值：真机实测调出来的（2026-10-10 真实抓帧 ✓）★★
 *   MATCH_MIN  = 0.92 —— ★"就是它"★的门槛：
 *       同一张图实测 9/9 都是 **1.000** ✓；而"别的格"最高只到 0.744（次名通常 0.12~0.74 ✓）
 *       → 0.92 落在"真空档"里（两侧各留 0.18 余量 ✓）。旧值 0.62 太松 ✗
 *       （0.62 会把"次名 0.744"这种也放进来 ✓ —— 那正是"名字写着狙击其实是近卫"的温床 ✗）。
 *   MARGIN_MIN = 0.06 —— ★最优与次优的最小差距★：
 *       实测 9 格里**最小**的领先量是 1.000-0.744 = **0.256** ✓ → 0.06 是很保守的下限 ✓；
 *       差距小于它 = 两个模板长得太像 → ★必须报"不确定"✗ 不许硬选一个 ✓★。
 *   CAND_MIN   = 0.62 —— 低过它就连"有点像"都算不上 → ★报"没找到"✓ 不硬凑 ✓★。
 * ★取舍（③ 的精神）：宁可低召回高精度 ✗→✓ —— 认不出时报"不确定/没找到" ✓，绝不硬选 ✓。 */
const MATCH_MIN = 0.92;
const MARGIN_MIN = 0.06;
const CAND_MIN = 0.62;
const DEFAULT_MIN = MATCH_MIN;   // 兼容旧调用（matchLibrary 的 min 默认值 ✓）
const SCALES = [0.85, 0.92, 1.0, 1.08, 1.15];   // ★多尺度★（②）

/* 三分判定：match（就是它 ✓）/ uncertain（像，但不敢认 ✓）/ none（没找到 ✓） */
function verdictOf(score, margin, opt) {
  const o = opt || {};
  const mMin = o.matchMin == null ? MATCH_MIN : Number(o.matchMin);
  const gMin = o.marginMin == null ? MARGIN_MIN : Number(o.marginMin);
  const cMin = o.candMin == null ? CAND_MIN : Number(o.candMin);
  if (!(score >= cMin)) return 'none';
  if (score >= mMin && margin != null && margin >= gMin) return 'match';
  return 'uncertain';
}

function dbg(m) { try { require('./debug').log('[iconlib] ' + m); } catch (e) {} }
function safe(s) { return String(s == null ? '' : s).replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 40) || 'default'; }

/* ── 存/取库 ───────────────────────────────────────────── */
function rootDir(baseDir, libName) { return path.join(baseDir, 'iconlib', safe(libName)); }
function indexPath(baseDir, libName) { return path.join(rootDir(baseDir, libName), 'index.json'); }
function loadIndex(baseDir, libName) {
  try { return JSON.parse(fs.readFileSync(indexPath(baseDir, libName), 'utf8')); } catch (e) { return null; }
}
function saveIndex(baseDir, libName, obj) {
  const dir = rootDir(baseDir, libName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath(baseDir, libName), JSON.stringify(obj, null, 2), 'utf8');
  return indexPath(baseDir, libName);
}

/* ── 图像 → 灰度数组（jimp ✓）──────────────────────────── */
async function lumaOf(Jimp, bufOrPath) {
  const img = (typeof bufOrPath === 'string') ? await Jimp.fromBuffer(fs.readFileSync(bufOrPath)) : await Jimp.fromBuffer(bufOrPath);
  const w = img.width, h = img.height;
  const luma = GC.lumaFromBitmap(img.bitmap.data, w, h, false);
  return { img, w, h, luma };
}

/* 把一块矩形裁出来、缩放成 PATCH×PATCH、再做 z-score 归一化 ✓
 * z-score = (灰度 - 均值) / 标准差 → ★对"整体变亮/变暗/对比度变化"免疫 ✓★ */
function normPatch(img, x, y, w, h) {
  const Jimp = require('jimp').Jimp;
  const cw = Math.max(4, Math.min(x + w, img.width) - Math.max(0, x));
  const ch = Math.max(4, Math.min(y + h, img.height) - Math.max(0, y));
  const crop = img.clone().crop({ x: Math.max(0, x), y: Math.max(0, y), w: cw, h: ch });
  crop.resize({ w: PATCH, h: PATCH });
  const vec = new Float32Array(PATCH * PATCH);
  const d = crop.bitmap.data;
  let sum = 0;
  for (let i = 0, p = 0; i < vec.length; i++, p += 4) {
    const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    vec[i] = l; sum += l;
  }
  const mean = sum / vec.length;
  let v2 = 0;
  for (let i = 0; i < vec.length; i++) { const t = vec[i] - mean; v2 += t * t; }
  const sd = Math.sqrt(v2 / vec.length) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] - mean) / sd;
  return vec;
}

/* ★NCC★：两个 z-score 向量的内积 / 长度（都归一化过 → 内积均值即相似度 ✓） */
function ncc(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s / n;
}

/* ★dHash★（64 位：9x9 灰度 → 相邻比较 → 64 bit ✓）—— 粗筛用 ✓ */
function dhash(vec, w, h) {
  const n = 8;
  const cells = [];
  for (let j = 0; j < n + 1; j++) {
    for (let i = 0; i < n + 1; i++) {
      const x = Math.min(w - 1, Math.round(i * (w - 1) / n));
      const y = Math.min(h - 1, Math.round(j * (h - 1) / n));
      cells.push(vec[y * w + x]);
    }
  }
  const bits = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) bits.push(cells[j * (n + 1) + i] > cells[j * (n + 1) + i + 1] ? 1 : 0);
  }
  let hex = '';
  for (let k = 0; k < bits.length; k += 4) hex += parseInt(String(bits[k]) + String(bits[k + 1]) + String(bits[k + 2]) + String(bits[k + 3]), 2).toString(16);
  return hex;
}
function hamming(hexA, hexB) {
  let d = 0;
  for (let i = 0; i < Math.min(hexA.length, hexB.length); i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/* ── 格子 → 每格的像素窗口 ─────────────────────────────── */
/* 用 gridcount 的确定性几何 ✓：给"一列/一排"的区域，返回每格中心的窗口矩形 ✓ */
function cellsFor(luma, w, h, opt) {
  const o = opt || {};
  const r = GC.analyze(luma, w, h, {
    dir: o.dir || 'v', k: 2, expect: o.expect > 0 ? o.expect : undefined,
    bandSearch: o.bandSearch == null ? 56 : o.bandSearch,
    region: o.region || undefined,
  });
  const half = o.half == null ? Math.max(10, Math.round((r.spacing || 100) * 0.36)) : o.half;
  const cx = Math.round((r.region.x0 + r.region.x1) / 2);
  const cells = (r.cells || []).map((c, i) => {
    const cy = c.center;
    return {
      index: i + 1, center: c.center,
      inLattice: !!c.inLattice, estimated: !!c.estimated, empty: !!c.empty,
      box: (o.dir === 'h')
        ? { x: Math.round(c.center - half), y: r.region.y0, w: half * 2, h: r.region.y1 - r.region.y0 }
        : { x: Math.round(cx - half), y: Math.round(cy - half), w: half * 2, h: half * 2 },
      cx, cy,
    };
  });
  return { analysis: r, cells, half, dir: o.dir || 'v' };
}

/* ── ★存库：截一次、切 N 格、每格一个模板★ ──────────────── */
/* names 可以给人给的名字（按顺序 ✓）；不给就用 `#序号` ✓
 * ★文件名的前缀永远是序号★（t01_ / t02_ ... ✓）—— 见文件头"为什么必须带序号" ✓ */
async function buildLibrary(opts) {
  const o = opts || {};
  const Jimp = require('jimp').Jimp;
  const src = await lumaOf(Jimp, o.image || o.path);
  const g = cellsFor(src.luma, src.w, src.h, o);
  const dir = rootDir(o.baseDir, o.libName);
  fs.mkdirSync(dir, { recursive: true });
  const names = Array.isArray(o.names) ? o.names : [];
  const entries = [];
  for (const c of g.cells) {
    const vec = normPatch(src.img, c.box.x, c.box.y, c.box.w, c.box.h);
    const given = String(names[c.index - 1] || '').trim();
    const label = given || ('#' + c.index);
    /* ★文件名 = 序号 + 名字★（序号在前 ✓ 一眼看出是哪一格 ✓） */
    const file = 't' + String(c.index).padStart(2, '0') + '_' + safe(label) + '.png';
    const abs = path.join(dir, file);
    try {
      const crop = src.img.clone().crop({
        x: Math.max(0, c.box.x), y: Math.max(0, c.box.y),
        w: Math.max(4, Math.min(c.box.w, src.w - Math.max(0, c.box.x))),
        h: Math.max(4, Math.min(c.box.h, src.h - Math.max(0, c.box.y))),
      });
      crop.resize({ w: PATCH, h: PATCH });
      fs.writeFileSync(abs, await crop.getBuffer('image/png'));
    } catch (e) { dbg('写模板失败 ' + file + '：' + e.message); }
    entries.push({
      index: c.index, name: label, given: !!given, file,
      hash: dhash(vec, PATCH, PATCH),
      vec: Array.from(vec, (v) => Math.round(v * 1000) / 1000),   // 直接存归一化向量 ✓（不依赖再读图 ✓）
      box: c.box, center: c.center, geometry: { spacing: g.analysis.spacing, region: g.analysis.region, dir: g.dir },
    });
  }
  const index = {
    lib: o.libName, at: Date.now(), source: o.image || o.path || '(进程截图)',
    dir: g.dir, spacing: g.analysis.spacing, residual: g.analysis.cv, region: g.analysis.region,
    imageW: src.w, imageH: src.h, half: g.half,
    axis: Math.round((g.analysis.region.x0 + g.analysis.region.x1) / 2),
    centers: g.cells.map((c) => c.center),
    cells: entries.length, entries,
  };
  const p = saveIndex(o.baseDir, o.libName, index);
  return { dir, indexFile: p, index, cells: g.cells, analysis: g.analysis };
}

/* ── ★认库：逐格报告"匹配到哪个模板 + 分数"★ ────────────── */
/* 返回 rows: [{index, name, score, scale, matched, second, all}] ✓
 * ★matched=false = 没匹配上（诚实说 ✓ 不硬凑 ✗）★ */
async function matchLibrary(opts) {
  const o = opts || {};
  const Jimp = require('jimp').Jimp;
  const index = loadIndex(o.baseDir, o.libName);
  if (!index) throw new Error('没有这个图标库：' + o.libName + '（先用 icon_lib|save 建一个 ✓）');
  const src = await lumaOf(Jimp, o.image || o.path);
  const g0 = cellsFor(src.luma, src.w, src.h, o);
  const min = o.min == null ? MATCH_MIN : Number(o.min);
  /* ★★ 几何先验（库记着"上次这一列在哪、格距多少"✓）—— 修"格子放歪"✗→✓ ★★
     真机实测的第三个坑：只靠**现场重新搜窄条**时，输入一变（整体缩到 0.9 / JPEG q60 噪点 ✓），
     搜出来的格子和真实图标错开好几像素 ✗ → 分数从 1.000 掉到 0.2~0.4 ✗，
     看起来像"认不出来" ✓（其实是**格子没框住图标** ✗）。
     → 对策（**自适应第二遍** ✓，不是无条件用）：
        第一遍按现场搜出的几何认 ✓；★只有当场最高分很低（< 0.80 ✓）才试第二遍：用库的几何放格✓★
        （中心的 y 序列 + 格距 + 半宽都按图像宽度比 k 缩放 ✓）→ 两遍取**分数更高**的那一遍 ✓。
     ★两条安全阀（都很重要 ✗→✓）★：
        ① 库的几何**必须落在调用者给的区域内** ✓ —— x 方向也要落在里面 ✓
           （★第一版漏了 x 检查 → 拿"左边不含图标的区域"去认时，先验把格子摆到了右边职业列上 →
             假命中 1.000 ✗✗ —— 这正是"假命中测试"要抓的 ✓，被自己的探针抓到了 ✓）；
        ② 只有"当真靠不住"时才用它 ✓（最高分 < 0.80 ✓），不是默认覆盖 ✓。
     ★仍然是"位置由几何给"✓，不是让模型猜 ✗★。 */
  let geomFrom = 'search';
  const k = (index.imageW && src.w) ? (src.w / index.imageW) : 1;
  const region0 = o.region || { x0: 0, y0: 0, x1: src.w - 1, y1: src.h - 1 };
  let gHint = null;
  if (o.useLibGeometry !== false && index.centers && index.centers.length && k > 0.6 && k < 1.6) {
    const hintSpacing = (index.spacing || 0) * k;
    const half = Math.max(8, Math.round((index.half || hintSpacing * 0.36) * k));
    const axis = Math.round((index.axis || 0) * k);
    /* ★安全阀①：库那一列的 x 必须在给定区域内（±半宽 ✓）★ */
    const xOk = index.dir === 'h' || (axis >= region0.x0 - half && axis <= region0.x1 + half);
    if (xOk && hintSpacing > 4) {
      const cells = index.centers.map((c) => Math.round(c * k))
        .filter((cy) => cy >= region0.y0 - 2 && cy <= region0.y1 + 2)
        .map((cy, i) => ({
          index: i + 1, center: cy, inLattice: true, estimated: false, empty: false,
          box: (index.dir === 'h')
            ? { x: Math.round(cy - half), y: region0.y0, w: half * 2, h: region0.y1 - region0.y0 }
            : { x: Math.round(axis - half), y: cy - half, w: half * 2, h: half * 2 },
          cx: axis, cy,
        }));
      if (cells.length >= 2) {
        gHint = {
          analysis: Object.assign({}, g0.analysis, { spacing: hintSpacing, region: { x0: axis - half, x1: axis + half, y0: region0.y0, y1: region0.y1 } }),
          cells, half, dir: index.dir || 'v',
        };
      }
    }
  }
  const tmpl = index.entries.map((e) => ({ name: e.name, index: e.index, vec: new Float32Array(e.vec), hash: e.hash, file: e.file }));
  /* ★模板的多尺度向量**一次性算好**✓（下面要在很多偏移上反复用 ✓，别每次重算 ✗）★ */
  const scales = o.scales || SCALES;
  const tmplScaled = tmpl.map((t) => ({ t, vers: scales.map((sc) => ({ sc, vec: sc === 1.0 ? t.vec : rescaleVec(t.vec, PATCH, sc) })) }));
  /* ★★ 局部偏移搜索 ✗→✓（2026-10-10 真机实测的第二个坑）★★
     第一版：每格只取**几何中心那一块**✗ —— 只要格子偏 2~6px（缩放/区域小位移/
     grid_count 的格距取整误差 ✓），分数就从 1.000 掉到 0.2~0.3 ✗（真机实测：
     区域平移 6px 时 9 格只剩 1 格能认 ✓、整体 ×0.9 时 0 格 ✗）。
     → 现在：在 ±SEARCH 像素内**逐偏移试一遍**✓，取最好的那个 ✓（经典模板匹配的搜索窗 ✓）。
     ★这一步是"精度"与"召回"的分水岭★：不加它，分数一掉就"找不到"✗；
       加了它，**同格 1.000 不变 ✓**，而偏几像素的仍然认得出 ✓（探针里有实测分数 ✓）。 */
  const SEARCH = o.search == null ? 8 : Number(o.search);
  const STEP = o.searchStep == null ? 2 : Number(o.searchStep);

  function rowsFor(cells) {
    const out = [];
    for (const c of cells) {
      const patchAt = (dx, dy) => normPatch(src.img, c.box.x + dx, c.box.y + dy, c.box.w, c.box.h);
      const vec = patchAt(0, 0);            // 几何中心那块（也是"偏移 0"✓）
      /* 第一遍：找最佳偏移 + 最佳模板（只用每个模板的最高分 ✓） */
      let best = { s: -2, dx: 0, dy: 0, scale: null, name: null };
      for (let dy = -SEARCH; dy <= SEARCH; dy += STEP) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += STEP) {
          const v = (dx === 0 && dy === 0) ? vec : patchAt(dx, dy);
          for (const ts of tmplScaled) {
            for (const vv of ts.vers) {
              const s = ncc(v, vv.vec);
              if (s > best.s) best = { s, dx, dy, scale: vv.sc, name: ts.t.name };
            }
          }
        }
      }
      /* 第二遍：在**最佳偏移**上把所有模板都比一遍 ✓ → 才有可信的"次优"与差距 ✓
         （第一次把"偏移"和"模板"一起搜 ✓，次优若来自别的偏移就没有可比性 ✗） */
      const vBest = (best.dx === 0 && best.dy === 0) ? vec : patchAt(best.dx, best.dy);
      const scored = tmplScaled.map((ts) => {
        let bs = -2, bsc = null;
        for (const vv of ts.vers) { const s = ncc(vBest, vv.vec); if (s > bs) { bs = s; bsc = vv.sc; } }
        return { name: ts.t.name, index: ts.t.index, file: ts.t.file, score: bs, scale: bsc };
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0] || null;
      const second = scored[1] || null;
      const score = top ? top.score : 0;
      const margin = (top && second) ? (top.score - second.score) : null;
      /* ★三分判定✗→✓★：match（就是它）/ uncertain（像但差距太小）/ none（没找到 ✓）
         —— 判据见文件头 MATCH_MIN / MARGIN_MIN / CAND_MIN 的实测依据 ✓ */
      const verdict = verdictOf(score, margin, o);
      out.push({
        index: c.index, center: c.center, box: c.box,
        offset: { dx: best.dx, dy: best.dy },
        name: (verdict === 'match') ? top.name : null,
        score, verdict,
        second: second ? { name: second.name, score: second.score } : null,
        scale: top ? top.scale : null,
        matched: verdict === 'match',
        margin,
        all: scored.slice(0, 3),
      });
    }
    return out;
  }
  const maxOf = (rs) => (rs.length ? Math.max.apply(null, rs.map((r) => r.score)) : -9);

  let g = g0;
  let rows = rowsFor(g.cells);
  /* ★自适应第二遍：★只要第一遍**没能全部认出来**就用库的几何再认一遍 ✓，取"认出来的格数更多"的那遍 ✓★
     （为什么不是"最高分 < 0.80"✗：真机实测"整体 ×0.9"那一遍里**恰好有一格**碰巧得了 0.925 ✓ →
       最高分不低 ✗ → 第二遍被跳过 ✗ → 于是 8 格仍然认不出 ✓。
       判据改成"有没有没认出来的格子" ✓ 就不会漏 ✓ —— 这正是"缺一格也算缺"✓。） */
  if (gHint) {
    const miss1 = rows.filter((r) => r.verdict !== 'match').length;
    if (miss1 > 0) {
      const rows2 = rowsFor(gHint.cells);
      const miss2 = rows2.filter((r) => r.verdict !== 'match').length;
      const better = (miss2 < miss1) || (miss2 === miss1 && maxOf(rows2) > maxOf(rows));
      if (better) {
        g = gHint; rows = rows2;
        geomFrom = 'lib-hint(k=' + k.toFixed(3) + ')';
      }
    }
  }
  return { index, cells: g.cells, analysis: g.analysis, rows, min, geomFrom, matchMin: (o.matchMin == null ? MATCH_MIN : Number(o.matchMin)), marginMin: (o.marginMin == null ? MARGIN_MIN : Number(o.marginMin)), candMin: (o.candMin == null ? CAND_MIN : Number(o.candMin)) };
}

/* 把归一化向量当作小图做尺度缩放（最近邻 ✓ 够用 ✓ 纯 JS ✓） */
function rescaleVec(vec, n, scale) {
  const out = new Float32Array(n * n);
  const srcN = n, dstN = n;
  const inv = 1 / scale;
  for (let y = 0; y < dstN; y++) {
    for (let x = 0; x < dstN; x++) {
      const sx = Math.min(srcN - 1, Math.max(0, Math.round((x - dstN / 2) * inv + srcN / 2)));
      const sy = Math.min(srcN - 1, Math.max(0, Math.round((y - dstN / 2) * inv + srcN / 2)));
      out[y * dstN + x] = vec[sy * srcN + sx];
    }
  }
  /* 重新 z-score（缩放会改变均值/方差 ✓） */
  let s = 0;
  for (let i = 0; i < out.length; i++) s += out[i];
  const m = s / out.length;
  let v2 = 0;
  for (let i = 0; i < out.length; i++) { const t = out[i] - m; v2 += t * t; }
  const sd = Math.sqrt(v2 / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
}

module.exports = {
  PATCH, DEFAULT_MIN, MATCH_MIN, MARGIN_MIN, CAND_MIN, SCALES, verdictOf,
  rootDir, indexPath, loadIndex, saveIndex,
  lumaOf, normPatch, ncc, dhash, hamming, rescaleVec, cellsFor,
  buildLibrary, matchLibrary,
};
