/* 视觉增强三件套 —— 针对 2026-10-10 那场事故（职业列认错）做的
 *
 * 【事故回顾（决定了这三个工具长什么样）】
 *   她要确认"右侧竖排那一列里哪个是近卫"：
 *     · ★四次★问视觉模型 → 拿到★四种不同的顺序★ ✗（她最后说"我不信它了" ✓）
 *     · ★我★去查，把那一列裁出来放大看 → ★也数错了★ ✗
 *       （按"间距 60px、起点 y≈170"裁 ✓，而**那两个数是估的** ✗ → 逐格漂移 ✓）
 *     · 又试**像素亮度扫描** → 只扫出 3 段 ✗（深色细线压深色背景 + 立绘遮挡 ✓）
 *   ★ 三个失败暴露的是**三种不同的缺** ✗，所以这里有三个工具 ✓：
 *     ① 单次视觉判断会抖 → `icon_pick`（同一格问 N 次、★取多数★ ✓）
 *     ② 一次问一整列会自相矛盾 → `grid_scan`（程序切格、★逐格★问 ✓）
 *     ③ 靠估的间距去裁会漂移 → `find_grid`（★从像素里测出真实位置和间距★ ✓）
 *
 * 【边界（诚实说 ✗）】
 *   ★ 这三个工具都**不能**告诉你"那个图案是哪个职业" ✗ ——
 *     那是**外部知识**（图标含义是玩家社区的约定 ✓），必须写在技能里 ✓。
 *   它们只解决"**把问题问准、把位置量准**" ✓。
 */
'use strict';

/* Set-of-Marks 的**纯逻辑**在 som.js（合并候选/去重编号/拼提示词/解析编号/画框，全部可单测 ✓）。
   这一层只做 I/O：抓帧 → 收候选 → 画编号 → 问模型 → 把编号翻回坐标 ✓。
   ★职责这样分是故意的✗★：纯逻辑留在 som.js 就能被 test-som.js 覆盖 ✓；
   碰到 electron 的东西（nativeImage / 子进程 OCR / UIA）放在这里，由探针注入假依赖来测 ✓。 */
const SOM = require('./som');

let deps = null;

/* 由 assistant.js 注入：{ capture, vision, config, space }，
   som_look 另外要 { ocrJson, uiaList, extraCandidates }（见下面 somLook 的注释）。
   ★合并而不是整体替换★：这些工具是**分批**接进来的 ✓ —— icon_pick 那批只注入 4 个依赖 ✓，
   后一次 install 若整体替换，会把 som_look 要用的 ocrJson/uiaList 抹掉 ✗ →
   som_look 静默退化成"一个候选都没有"✗（正是那种不报错、只变哑的坑 ✗）。 */
function install(d) { deps = Object.assign({}, deps || {}, d || {}); }

function normArg(arg) {
  /* 参数统一用 | 分隔 ✓ */
  return String(arg == null ? '' : arg).split('|').map((s) => s.trim());
}

function parseBox(s) {
  const p = String(s || '').split(',').map((x) => Number(String(x).trim()));
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

/* 从整帧里裁一块，并放大到合适大小 → dataUrl ✓
 * 放大是为了让模型看清 ✓（实测：整屏送进去再压一次，小图标会糊 ✓） */
function cropZoom(capDataUrl, box, maxW) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(capDataUrl);
  const sz = img.getSize();
  const x = Math.max(0, Math.min(sz.width - 8, Math.round(box.x)));
  const y = Math.max(0, Math.min(sz.height - 8, Math.round(box.y)));
  const w = Math.max(8, Math.min(sz.width - x, Math.round(box.w)));
  const h = Math.max(8, Math.min(sz.height - y, Math.round(box.h)));
  const crop = img.crop({ x, y, width: w, height: h });
  const target = Math.max(240, Math.min(maxW || 1200, w * 6));
  const k = target / w;
  const big = crop.resize({ width: Math.round(w * k), quality: 'best' });
  return { dataUrl: big.toDataURL(), x, y, w, h, k, outW: Math.round(w * k), outH: Math.round(h * k) };
}

/* ═══════════════════════════════════════════════════════════════════
 * ① icon_pick —— 同一格问 N 次，取多数
 *    用法: icon_pick|<候选1,候选2,...>|<x,y,w,h>|<问几次，默认3>
 *    返回: 多数答案 + 票数分布 + 归一化坐标（格中心 ✓）
 * ═══════════════════════════════════════════════════════════════════ */
async function iconPick(arg) {
  const a = normArg(arg);
  const opts = String(a[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return '❌ icon_pick 需要至少 2 个候选项，格式：icon_pick|甲,乙,丙|x,y,w,h|次数';
  const box = parseBox(a[1]);
  if (!box) return '❌ icon_pick 的区域格式应为 x,y,w,h（例：1840,140,60,60）';
  const times = Math.max(1, Math.min(5, Number(a[2]) || 3));

  const cap = await deps.capture();
  const z = cropZoom(cap.dataUrl, box, 900);
  /* ★ 问「选项里的哪个」，而不是「描述你看到的图案」✗→✓
     实测：让它描述图案 → 它答"双剑"✗，而她需要"近卫"✗ → 逼她做翻译 → 反复问 ✓
     让它从 9 个选项里选一个 → 它答得稳 ✓ */
  const q = '这一小格里是下面的哪一个？' + opts.join(' / ')
    + ' ★只回答其中一个词，不要解释、不要描述图案、不要给坐标★';
  const cfg = deps.config.load();
  const votes = {};
  const raw = [];
  for (let i = 0; i < times; i++) {
    let t = '';
    try { t = String(await deps.vision.describe(cfg, z.dataUrl, q, cfg.visionDetail || 'high') || ''); }
    catch (e) { t = 'ERR ' + (e && e.message); }
    raw.push(t.replace(/\s+/g, ' ').slice(0, 60));
    /* 从回答里挑出命中的候选项 ✓（模型有时会多话 ✓） */
    let hit = null;
    for (const o of opts) { if (t.indexOf(o) >= 0) { if (hit === null || o.length > hit.length) hit = o; } }
    if (hit) votes[hit] = (votes[hit] || 0) + 1;
  }
  const ent = Object.entries(votes).sort((x, y) => y[1] - x[1]);
  const cx = z.x + Math.round(z.w / 2), cy = z.y + Math.round(z.h / 2);
  const nx = (cx / deps.space().w).toFixed(3), ny = (cy / deps.space().h).toFixed(3);

  if (!ent.length) {
    return '⚠️ icon_pick：' + times + ' 次都没有答出候选项里的任何一个 ✗\n'
      + '  候选项：' + opts.join(' / ') + '\n'
      + '  原始回答：' + raw.map((r) => '"' + r + '"').join(' / ') + '\n'
      + '  → ★说明这格里可能不是这些选项之一 ✗，或者这张图太糊 ✓\n'
      + '     建议：① 把区域裁得更准一点（别把旁边的立绘框进来 ✓）'
      + ' ② 或者用 screen_look 先看一眼这格到底是什么 ✓';
  }
  const top = ent[0][1];
  const tie = ent.filter(([, v]) => v === top).length > 1;
  return (tie ? '⚠️ 分歧（并列，结论不可靠 ✗）' : '✅ 多数答案：' + ent[0][0])
    + '\n  票数：' + ent.map(([k, v]) => k + '=' + v).join(' / ') + '（共问 ' + times + ' 次）'
    + '\n  格中心：(' + cx + ',' + cy + ')　归一化：' + nx + ',' + ny
    + '\n  原始回答：' + raw.map((r) => '"' + r + '"').join(' / ')
    + (tie ? '\n  ★并列说明模型在这格上不稳 ✗ —— 别用它下结论 ✓，改问法或换区域 ✓' : '');
}

/* ═══════════════════════════════════════════════════════════════════
 * ② grid_scan —— 把一块区域按格子切开，逐格问
 *    用法: grid_scan|<候选1,候选2,...>|<x,y,w,h>|<格子大小，默认60>|<每格问几次，默认2>|<方向 v|h>
 *    为什么要有它：★一次问一整列，实测会得到自相矛盾的答案 ✗★（她拿到四种顺序 ✓）
 * ═══════════════════════════════════════════════════════════════════ */
async function gridScan(arg) {
  const a = normArg(arg);
  const opts = String(a[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return '❌ grid_scan 需要至少 2 个候选项';
  const box = parseBox(a[1]);
  if (!box) return '❌ grid_scan 的区域格式应为 x,y,w,h';
  const cell = Math.max(16, Math.min(400, Number(a[2]) || 60));
  const times = Math.max(1, Math.min(4, Number(a[3]) || 2));
  const dir = String(a[4] || 'v').toLowerCase().startsWith('h') ? 'h' : 'v';

  const n = dir === 'v' ? Math.floor(box.h / cell) : Math.floor(box.w / cell);
  if (n < 1) return '❌ 区域太小，按 ' + cell + 'px 切不出格子（区域 ' + box.w + 'x' + box.h + '）';
  const cap = await deps.capture();
  const cfg = deps.config.load();
  const lines = [];
  const picks = [];
  for (let i = 0; i < n; i++) {
    const b = dir === 'v'
      ? { x: box.x, y: box.y + i * cell, w: box.w, h: cell }
      : { x: box.x + i * cell, y: box.y, w: cell, h: box.h };
    const z = cropZoom(cap.dataUrl, b, 800);
    const q = '这一小格里是下面的哪一个？' + opts.join(' / ')
      + ' ★只回答其中一个词，不要解释、不要描述图案、不要给坐标★';
    const votes = {};
    for (let t = 0; t < times; t++) {
      let s = '';
      try { s = String(await deps.vision.describe(cfg, z.dataUrl, q, cfg.visionDetail || 'high') || ''); } catch (e) { s = ''; }
      let hit = null;
      for (const o of opts) { if (s.indexOf(o) >= 0) { if (hit === null || o.length > hit.length) hit = o; } }
      if (hit) votes[hit] = (votes[hit] || 0) + 1;
    }
    const ent = Object.entries(votes).sort((x, y) => y[1] - x[1]);
    const top = ent.length ? ent[0][0] : null;
    const tie = ent.length > 1 && ent[0][1] === ent[1][1];
    const ccx = b.x + Math.round(b.w / 2), ccy = b.y + Math.round(b.h / 2);
    const nx = (ccx / deps.space().w).toFixed(3), ny = (ccy / deps.space().h).toFixed(3);
    picks.push({ i: i + 1, top, tie, cx: ccx, cy: ccy, nx, ny, votes, b });
    lines.push('  ' + String(i + 1).padStart(2) + '. '
      + (top ? (tie ? '⚠️' + top + '(并列)' : '★' + top + '★') : '❓未识别')
      + '  中心 (' + ccx + ',' + ccy + ')  ★格中心是程序按格距算的 ✓；"这一格是什么"是模型判的 ✗★'
      + '  票 ' + (ent.length ? ent.map(([k, v]) => k + '=' + v).join('/') : '无'));
  }
  const bad = picks.filter((p) => !p.top || p.tie).length;
  return '🗂 grid_scan：' + dir + ' 方向切成 ' + n + ' 格（每格 ' + cell + 'px，每格问 ' + times + ' 次）'
    + '\n' + lines.join('\n')
    + '\n  ★可疑格：' + bad + ' 个' + (bad ? '（标了 ⚠️/❓ 的那些 ✗ —— 别拿它们下结论 ✓）' : ' ✓')
    + '\n  ⚠️ 这里给的是**位置**；"这个词是什么含义"要**查技能/知识** ✗ —— 那是外部知识 ✓';
}

/* ═══════════════════════════════════════════════════════════════════
 * ③ find_grid —— 从像素里测出"等距排列"的真实位置和间距
 *    用法: find_grid|<x,y,w,h>|<方向 v|h>|<最小段高，默认6>
 *    ★为什么需要它★：今天翻车的直接原因就是**拿估的间距去裁** ✗ →
 *      逐格漂移 → 把第 3、4 格认成第 1、2 格 ✓
 *    ★它只做几何 ★：不判断"那是什么" ✗ —— 只告诉你"东西在哪、间距多少" ✓
 * ═══════════════════════════════════════════════════════════════════ */
async function findGrid(arg) {
  const a = normArg(arg);
  const box = parseBox(a[0]);
  if (!box) return '❌ find_grid 的区域格式应为 x,y,w,h';
  const dir = String(a[1] || 'v').toLowerCase().startsWith('h') ? 'h' : 'v';
  const minLen = Math.max(4, Math.min(60, Number(a[2]) || 6));

  const cap = await deps.capture();
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(cap.dataUrl);
  const sz = img.getSize();
  const x0 = Math.max(0, Math.min(sz.width - 8, Math.round(box.x)));
  const y0 = Math.max(0, Math.min(sz.height - 8, Math.round(box.y)));
  const w = Math.max(8, Math.min(sz.width - x0, Math.round(box.w)));
  const h = Math.max(8, Math.min(sz.height - y0, Math.round(box.h)));
  const sub = img.crop({ x: x0, y: y0, width: w, height: h });
  const bmp = sub.toBitmap();          // BGRA ✓
  const W = w, H = h;

  /* 逐行（或逐列）算平均亮度 ✓ */
  const n = dir === 'v' ? H : W;
  const prof = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    if (dir === 'v') {
      for (let j = 0; j < W; j++) { const p = (i * W + j) * 4; sum += (bmp[p] + bmp[p + 1] + bmp[p + 2]) / 3; cnt++; }
    } else {
      for (let j = 0; j < H; j++) { const p = (j * W + i) * 4; sum += (bmp[p] + bmp[p + 1] + bmp[p + 2]) / 3; cnt++; }
    }
    prof.push(sum / cnt);
  }
  const mx = Math.max(...prof), mn = Math.min(...prof);
  const rng = mx - mn;
  if (rng < 8) {
    return '⚠️ find_grid：这一块的亮度范围只有 ' + Math.round(rng)
      + '（' + Math.round(mn) + '~' + Math.round(mx) + '）✗ —— 几乎是纯色 ✓\n'
      + '  → ★里面大概没有可分辨的东西 ✗，或者区域选错了 ✓\n'
      + '     建议：先用 screen_look 整屏看一眼，确认这块到底有没有内容 ✓';
  }
  const thr = mn + rng * 0.35;
  const bands = [];
  let cur = null;
  prof.forEach((v, i) => {
    if (v >= thr) { if (!cur) cur = { a: i, b: i, peak: v }; else { cur.b = i; cur.peak = Math.max(cur.peak, v); } }
    else if (cur) { if (cur.b - cur.a + 1 >= minLen) bands.push(cur); cur = null; }
  });
  if (cur && cur.b - cur.a + 1 >= minLen) bands.push(cur);

  if (!bands.length) {
    return '⚠️ find_grid：亮度范围有 ' + Math.round(rng) + '，但按阈值 ' + Math.round(thr)
      + ' 切不出任何一段 ✗\n  → 可能是**细线/低对比**的图案 ✓（实测：深色细线压在深色背景上就会这样 ✗）\n'
      + '     ★这种情况**别硬用它** ✗ —— 改用 grid_scan 逐格问 ✓，或者让主人给一次正确答案 ✓';
  }
  const cs = bands.map((b) => Math.round((b.a + b.b) / 2));
  const gaps = [];
  for (let i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1]);
  const avg = gaps.length ? Math.round(gaps.reduce((p, q) => p + q, 0) / gaps.length) : 0;
  const dev = gaps.length ? Math.round(Math.sqrt(gaps.reduce((p, q) => p + Math.pow(q - avg, 2), 0) / gaps.length)) : 0;
  const even = gaps.length > 1 && dev <= Math.max(3, avg * 0.12);

  const lines = bands.map((b, i) => {
    if (dir === 'v') {
      const cy = y0 + cs[i];
      return '  ' + String(i + 1).padStart(2) + '. y ' + (y0 + b.a) + '~' + (y0 + b.b)
        + '  中心 (' + (x0 + Math.round(w / 2)) + ',' + cy + ')'
        + '  归一化 ' + ((x0 + Math.round(w / 2)) / sz.width).toFixed(3) + ',' + (cy / sz.height).toFixed(3)
        + '（★像素测出来的，确定性来源 ✓★）';
    }
    const cx = x0 + cs[i];
    return '  ' + String(i + 1).padStart(2) + '. x ' + (x0 + b.a) + '~' + (x0 + b.b)
      + '  中心 (' + cx + ',' + (y0 + Math.round(h / 2)) + ')'
      + '  归一化 ' + (cx / sz.width).toFixed(3) + ',' + ((y0 + Math.round(h / 2)) / sz.height).toFixed(3)
      + '（★像素测出来的，确定性来源 ✓★）';
  });

  return '📐 find_grid：' + dir + ' 方向，区域 (' + x0 + ',' + y0 + ') ' + w + 'x' + h
    + '\n  亮度 ' + Math.round(mn) + '~' + Math.round(mx) + '，阈值 ' + Math.round(thr)
    + '\n  ★测出 ' + bands.length + ' 段★' + (even ? '（间距均匀 ✓）' : '')
    + '\n' + lines.join('\n')
    + (gaps.length ? '\n  间距：' + gaps.join(', ') + '　平均 ' + avg + 'px　波动 ±' + dev + 'px'
      + (even ? '\n  ★★ 间距均匀 → 可以用「平均间距 + 第一个中心」推算所有格 ✗→✓★' : '\n  ⚠️ 间距不均匀 ✗ —— 别用推算，逐格测 ✓') : '')
    + '\n  ⚠️ ★这只是**几何**✗ —— "那是什么"要查技能/知识 ✓（图标含义是外部知识 ✓）'
    + '\n  ⚠️ 段数不等于"有多少个目标" ✗ —— 立绘/文字也会被算进去 ✓，要配合 screen_look 判断 ✓';
}


/* ═══════════════════════════════════════════════════════════════════
 * ④ tile_read —— 重叠切块读图（治「小字看不清」）
 *   ★为什么需要它✗★：grid_scan 是**按格子硬切**的 ✓ ——
 *     格子边界正好落在文字中间时，两边各看到半个字 ✗ → 模型读不全 ✓。
 *   ★做法★：每块**多留重叠**（默认 20% ✗→✓），逐块放大后再问 ✓，
 *     并把每块在整屏的坐标标出来 ✓（坐标是程序按裁剪区域算的 ✓，可拿去配 find_grid / UIA 复核 ✓）。
 *   ★和 icon_pick 的分工✗★：这里求「读全、别切断」✓（每块只问 1 次 ✓）；
 *     要「抗单次抖动」用 icon_pick ✓。
 *   用法：tile_read|<问题>|<x,y,w,h>|<格子边长,默认512>|<重叠比例,默认0.2>
 * ═══════════════════════════════════════════════════════════════════ */
async function tileRead(arg) {
  const a = normArg(arg);
  const q = String(a[0] || '').trim();
  if (!q) return '❌ tile_read 用法：tile_read|<问题>|<x,y,w,h>|<格子边长,默认512>|<重叠比例,默认0.2>';
  const box = parseBox(a[1]);
  if (!box) return '❌ tile_read 的区域格式应为 x,y,w,h（例：560,300,900,600）';
  const cell = Math.max(120, Math.min(1024, Number(a[2]) || 512));
  let ov = Number(a[3]); if (!Number.isFinite(ov)) ov = 0.2;
  ov = Math.max(0, Math.min(0.5, ov));
  const step = Math.max(40, Math.round(cell * (1 - ov)));
  const cols = Math.max(1, Math.floor((box.w - 1) / step) + 1);
  const rows = Math.max(1, Math.floor((box.h - 1) / step) + 1);
  const total = cols * rows;
  if (total > 12) {
    return '⚠️ tile_read：区域 ' + box.w + 'x' + box.h + ' 按 ' + cell + 'px、重叠 '
      + Math.round(ov * 100) + '% 会切成 ' + total + ' 块 ✗（上限 12 块 ✓，免得又慢又贵 ✓）'
      + '\n  → 请把区域缩小 ✓，或者把格子边长调大 ✓';
  }
  const cap = await deps.capture();
  const cfg = deps.config.load();
  const lines = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(box.x + c * step, box.x + box.w - cell);
      const y = Math.min(box.y + r * step, box.y + box.h - cell);
      const b = { x: Math.max(0, x), y: Math.max(0, y),
        w: Math.min(cell, box.x + box.w - Math.max(0, x)),
        h: Math.min(cell, box.y + box.h - Math.max(0, y)) };
      const z = cropZoom(cap.dataUrl, b, 1400);
      let t = '';
      try { t = String(await deps.vision.describe(cfg, z.dataUrl, q, cfg.visionDetail || 'high') || ''); }
      catch (e) { t = 'ERR ' + (e && e.message); }
      idx++;
      const first = t.replace(/\s+/g, ' ').trim().slice(0, 200);
      lines.push('  ' + idx + '. 区域(' + b.x + ',' + b.y + ' ' + b.w + 'x' + b.h + ') → ' + (first || '（空回答）'));
    }
  }
  return '🧩 tile_read：切成 ' + total + ' 块（' + cols + 'x' + rows + '，每块 ' + cell + 'px，'
    + '★重叠 ' + Math.round(ov * 100) + '%✗→✓ 这样才不会把字切断★）'
    + '\n  问题：' + q.slice(0, 120)
    + '\n' + lines.join('\n')
    + '\n  ⚠️ 每块只问 1 次 ✗ —— 要抗单次抖动请用 icon_pick ✓；这里只求「读全、别切断」✓';
}
/* ═══════════════════════════════════════════════════════════════════
 * ⑤ som_look —— Set-of-Marks：★把「猜坐标」换成「选编号」★
 *   用法：som_look|<问题>                 整屏
 *         som_look|<问题>||<x,y,w,h>      只在这块区域里选（坐标是全屏 1920x1080 空间 ✓）
 *
 *   ★为什么要有它（和上面三个工具的区别）★
 *     上面三个是"把问题问准"✓；这一个换的是**回答的协议**✓：
 *       ✗ 旧协议：给模型一张图 + 一句问题 → 让它吐像素坐标
 *       ✓ 新协议：程序先把候选元素框出来编号 ✓ → 模型只回答**编号** ✓ → 程序按编号取坐标
 *     业界都是这一条（OmniParser v2 的结构化元素表 ✓、Set-of-Marks ✓、
 *     Playwright MCP 的 ref ✓、UIA 控件树 ✓）—— 共同点是★让模型选元素，不让它估坐标★。
 *     调研数据（为什么会有效）：同一批模型直接要坐标 ScreenSpot 16.2% ✗ →
 *     改成"在编号框里选" 70.5% ✓ → ★框里再写上"框内是什么字" 93.8%★ ✓。
 *     第三步我们**白拿**✓：候选本来就是 OCR 行文本 / UIA 控件名 ✓（这就是 som.js 文件头说的局部语义）。
 *
 *   ★和 screen_look 的分工★
 *     screen_look：开放式问"屏幕上有什么"✓（返回一段描述 ✓），或者放大看细节 ✓。
 *     som_look：**要"点哪一个"的时候用**✓ —— 它返回的是"编号 → 身份 → 可点的坐标"✓。
 *     实测她四次问同一列图标拿到四种顺序 ✗，就是因为开放式提问没有**候选集合**去锚定 ✓。
 *
 *   ★诚实边界（缺什么就说清 ✗）★
 *     候选只有两路：★OCR 读到的文字行★ + ★UIA 控件★ ✓。
 *     ★没有图标检测器✗★ —— OmniParser 那一步是它自己训的检测模型 ✓，本机没有 ✗，
 *     所以**纯图形、不带文字的图标（游戏职业图标）不会成为候选** ✗。
 *     补法接口已经留好了：把检测结果塞进 collectCandidates 的 extra 源 ✓（见下面 extraCandidates 依赖 ✓）。
 *     无名 UIA 控件也不进候选 ✗（没有局部语义 → 模型只能在几个空框里瞎猜 ✗，反而害它 ✓）。
 * ═══════════════════════════════════════════════════════════════════ */
const SOM_MAX = 60;              // ★候选上限★：再多图上的编号就糊成一团、模型也挑不准 ✗
const SOM_ZOOM_MAX_W = 1400;     // 区域模式放大到的目标宽度（小图标/小字要看得到 ✓）

/* 候选中心是否落在区域里（用中心而不是相交，避免"擦一点边就算进来"✗） */
function somInBox(c, r) {
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

async function somLook(arg) {
  const a = normArg(arg);
  const q = String(a[0] || '').trim();
  if (!q) {
    return '❌ som_look 用法：som_look|<问题>  或  som_look|<问题>||<x,y,w,h>\n'
      + '  例：som_look|这一列里哪个是「近卫」\n'
      + '  例：som_look|哪个按钮能取消||1840,140,60,400';
  }
  /* ★区域参数的解析必须"从开头匹配、容忍尾巴"✗→✓（对接层挖出来的坑）★
     根因：只要 ACTION 里有 `||`，llm.js 的 findActionMultiline 就会**一直取到回复文末**
     （它本来是给 write_file / proj_write 那种多行内容设计的 ✓）——
     于是她写的
         ACTION: som_look|哪个是取消||1500,900,420,180
         以上，我看不准。
     到这里 arg 就是 `哪个是取消||1500,900,420,180\n以上，我看不准。` ✗。
     如果这里要求"整段就是 x,y,w,h"（旧写法 ✓），**区域会被静默忽略** ✗ →
     退回整屏 → 多半直接撞上限 60 ✗，而回执只会说"候选太多" ✗，看不出根因 ✓。
     所以：段首匹配到 4 个数字就算区域 ✓，尾巴（模型顺手写的正文）明确写进回执 ✓ 不静默丢 ✓。 */
  let region = null, regionJunk = '';
  for (let i = 1; i < a.length; i++) {
    const mm = a[i].match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (mm) {
      region = { x: +mm[1], y: +mm[2], w: +mm[3], h: +mm[4] };
      if (mm[0].length < a[i].length) regionJunk = a[i].slice(mm[0].length).trim();
      break;
    }
  }
  if (region && (region.w <= 0 || region.h <= 0)) {
    return '❌ som_look 的区域应为 x,y,w,h 且 w/h 大于 0（例：560,300,900,600）';
  }

  const cap = await deps.capture();
  const cfg = deps.config.load();
  const sp = (typeof deps.space === 'function' ? deps.space() : null) || null;
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(cap.dataUrl);
  const sz = img.getSize();

  /* ── 源 ①：OCR 文字行 ─────────────────────────────────────────────
     ★为什么按「行」而不是按「词」✗★：实测这台机器一屏 OCR 出 ★436 个词 / 51 行★ ✓ ——
     按词当候选会立刻超上限 ✗，而且"一个字一个框"对模型毫无语义 ✓；
     Windows OCR 本来就把它们**按行分好组**了 ✓，直接用行框 + 行文本 = 现成的局部语义 ✓。
     ★同一次抓帧同时喂 OCR★（cap.path）—— 这样候选坐标和送模型的图**必定同一坐标空间** ✓，
     分开抓两次就会出现"框画在图上的别处"✗（抓帧尺寸/DPI 变了就整体错位 ✓）。 */
  const src = { words: [], uiaRects: [], extra: [] };
  const notes = [];
  if (typeof deps.ocrJson === 'function' && cap.path) {
    let j = null, err = '';
    try { j = await deps.ocrJson(cap.path); } catch (e) { err = (e && e.message) || String(e); }
    const lines = (j && j.lines) || [];
    for (const ln of lines) {
      const ws = (ln.words || []).filter((w) => w && w.w > 0 && w.h > 0);
      if (!ws.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const w of ws) {
        x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
        x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h);
      }
      const text = String(ln.text || ws.map((w) => w.t).join('')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      src.words.push({ t: text, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    if (!lines.length) {
      const why = err || (typeof deps.lastOcrError === 'function' && deps.lastOcrError()) || '没读到任何文字';
      notes.push('OCR：没有候选文字行（' + String(why).slice(0, 120) + '）');
    } else {
      notes.push('OCR：' + lines.length + ' 行 → ' + src.words.length + ' 个候选');
    }
  } else {
    notes.push('OCR：未接（没有 ocrJson 依赖或这次抓帧没有落盘路径）');
  }

  /* ── 源 ②：UIA 控件（前台窗口）────────────────────────────────────
     ★必须按【前台 hwnd】取树，不能按空标题✗★：实测 listElements('') 挑中的是
     ★桌宠自己那个 475x232 的小窗★（里面只有 2 个 Pane）✗ —— 因为它的策略是
     "第一个扫出元素的顶层窗口" ✓。按 hwnd 取才是主人正在看的那个窗口 ✓。
     实测前台浏览器窗口：1133 个后代、80 个进了清单、★66 个有名有姓带矩形★ ✓
     （例如 [Button]「关闭」1649,5,59,49 ✓）—— 这正是 SoM 要的"元素身份 + 框"✓。
     ⚠️ 游戏里这棵树通常是空的 ✓（那时只剩 OCR 候选 ✓，会写在下面的来源行里 ✓）。 */
  let uiaTotal = 0, uiaDropped = 0;
  if (typeof deps.uiaList === 'function') {
    try {
      const r = await deps.uiaList();
      const els = (r && r.elements) || [];
      uiaTotal = els.length;
      for (const e of els) {
        if (!e || !(e.w > 0) || !(e.h > 0)) continue;
        const nm = String(e.name || '').trim();
        /* ★没名字的控件不进候选★：它在图上就只是一个空框 ✗，模型没有依据可选 ✓
           （要的就是"框内是什么"这份局部语义 —— 缺了它 SoM 的收益从 93.8% 掉回 70.5% ✓） */
        if (!nm) { uiaDropped++; continue; }
        const id = String(e.automationId || '').trim();
        const ct = String(e.controlType || '').trim();
        src.uiaRects.push({ name: nm + (ct || id ? ' [' + [ct, id].filter(Boolean).join(' ') + ']' : ''), x: e.x, y: e.y, w: e.w, h: e.h });
      }
      const wtitle = (r && r.window && r.window.title) ? r.window.title : '前台窗口';
      notes.push('UIA：' + wtitle + ' 给出 ' + uiaTotal + ' 个控件，有名 ' + src.uiaRects.length
        + ' 个进候选' + (uiaDropped ? '，无名 ' + uiaDropped + ' 个没进（没有局部语义 ✗）' : '')
        + (r && r.ok === false ? '（★这个窗口没给出控件 —— 游戏里正常，非游戏应用才有效 ✓）' : '')
        + (r && r.note ? ' ' + r.note : ''));
    } catch (e) {
      notes.push('UIA：查询失败（' + ((e && e.message) || String(e)).slice(0, 100) + '）');
    }
  } else {
    notes.push('UIA：未接（没有 uiaList 依赖）');
  }

  /* ── 源 ③：extra（留给以后的图标检测器 ✓ 接口现在就是通的 ✓）── */
  if (typeof deps.extraCandidates === 'function') {
    try {
      const ex = await deps.extraCandidates();
      if (Array.isArray(ex)) {
        for (const e of ex) src.extra.push(e);
        notes.push('extra：' + ex.length + ' 个');
      }
    } catch (e) {
      notes.push('extra：取候选失败（' + ((e && e.message) || String(e)).slice(0, 80) + '）');
    }
  }

  const raw = SOM.collectCandidates(src);
  if (!raw.length) {
    return '⚠️ som_look：一共收到 0 个候选 ✗ —— 没有候选就无从"选编号"✓，所以这里**不会**给你任何坐标 ✓\n'
      + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n') + '\n'
      + '  → 建议：先 screen_look 看这一屏到底有什么 ✓；'
      + '游戏里的纯图标（没有文字）★本工具认不出来✗★（没有图标检测器 ✓），请改用 icon_pick / grid_scan ✓';
  }
  const pool = region ? raw.filter((c) => somInBox(c, region)) : raw;
  const cands = SOM.dedupe(pool);
  if (!cands.length) {
    return '⚠️ som_look：区域 ' + region.x + ',' + region.y + ',' + region.w + ',' + region.h
      + ' 里一个候选都没有 ✗（区域外的候选不算 ✓）\n'
      + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n') + '\n'
      + '  → 区域写错了吗？先用 screen_look 确认那块在哪 ✓';
  }
  if (cands.length > SOM_MAX) {
    const kinds = {};
    for (const c of cands) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    return '⚠️ som_look：候选 ' + cands.length + ' 个，★超过上限 ' + SOM_MAX + '★ ✗ —— 不硬画 ✓\n'
      + '  （原因：编号太多，图上的红框编号会糊成一团，模型反而挑不准 ✗）\n'
      + '  来源：' + Object.keys(kinds).map((k) => k + ' ' + kinds[k]).join(' · ')
      + '（未去重 ' + raw.length + ' 个）\n'
      + '  ★请缩小区域再问★：som_look|<问题>||<x,y,w,h>　例如 som_look|哪个是取消||1500,900,420,180\n'
      + '  （区域坐标是全屏 ' + sz.width + 'x' + sz.height + ' 空间，和 screen_look 的放大区域同一种写法 ✓）';
  }

  /* ── 画编号框 ─────────────────────────────────────────────────────
     ★区域模式要把图裁出来放大★：小图标/小字在整屏图上只有几十个像素 ✗，
     放大后模型才看得清"框里是什么"✓（这也是 SoM 那 93.8% 的关键一步 ✓）。
     放大后所有候选坐标按同一个 k 变换 ✓，返回给她的仍是**全屏坐标** ✓。 */
  let bmp, W, H, kx = 1, ky = 1, offX = 0, offY = 0, zoomNote = '';
  if (region) {
    const x0 = Math.max(0, Math.min(sz.width - 8, Math.round(region.x)));
    const y0 = Math.max(0, Math.min(sz.height - 8, Math.round(region.y)));
    const rw = Math.max(8, Math.min(sz.width - x0, Math.round(region.w)));
    const rh = Math.max(8, Math.min(sz.height - y0, Math.round(region.h)));
    const crop = img.crop({ x: x0, y: y0, width: rw, height: rh });
    const k = Math.max(1, Math.min(3, SOM_ZOOM_MAX_W / rw));
    const big = k > 1 ? crop.resize({ width: Math.round(rw * k), quality: 'best' }) : crop;
    const bs = big.getSize();
    bmp = big.toBitmap();
    W = bs.width; H = bs.height;
    /* ★k 用"实际像素/原区域"反算✗→✓★：resize 只给宽度，高度是它自己按比例算出来的 ✓，
       直接拿请求的 k 去乘 y 会有舍入偏差 ✓（vision2 里 cropZoom 那套就是按 k 算 outH 的 ✓） */
    kx = W / rw; ky = H / rh;
    offX = x0; offY = y0;
    zoomNote = '，区域 (' + x0 + ',' + y0 + ') ' + rw + 'x' + rh + ' 放大 ' + kx.toFixed(2) + ' 倍后送模型';
  } else {
    bmp = img.toBitmap();
    W = sz.width; H = sz.height;
  }
  const marks = cands.map((c) => ({
    id: c.id,
    x: Math.round((c.x - offX) * kx), y: Math.round((c.y - offY) * ky),
    w: Math.max(2, Math.round(c.w * kx)), h: Math.max(2, Math.round(c.h * ky)),
  }));
  SOM.drawMarks(bmp, W, H, marks);
  const markedUrl = nativeImage.createFromBitmap(bmp, { width: W, height: H }).toDataURL();

  /* ── 问模型：★只回答编号，永不回答坐标★ ── */
  const prompt = SOM.buildPrompt(cands, q, { withKind: true });
  let answer = '', verr = '';
  const t0 = Date.now();
  try { answer = String(await deps.vision.describe(cfg, markedUrl, prompt, cfg.visionDetail || 'high') || ''); }
  catch (e) { verr = (e && e.message) || String(e); }
  const ms = Date.now() - t0;
  const parsed = SOM.parseAnswer(answer);
  const head = '🎯 som_look：候选 ' + cands.length + ' 个' + (region ? '（指定区域 ✓）' : '（整屏 ✓）')
    + '，已把候选画成红框 + 编号送视觉模型' + zoomNote + '（' + ms + 'ms）\n'
    + '  问题：「' + q.slice(0, 80) + '」\n'
    + (regionJunk ? '  ⚠️ 区域后面还跟着文字：「' + regionJunk.replace(/\s+/g, ' ').slice(0, 40)
      + '」—— 已按"区域在前、尾巴忽略"处理 ✓（★ACTION 行要写在回复的最后一行★）\n' : '');

  if (verr) {
    return head + '❌ 视觉模型调用失败：' + String(verr).slice(0, 200) + '\n'
      + '  （候选和编号图都做好了 ✓ —— 但还是拿不到编号 ✗，所以不给坐标 ✓）\n'
      + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n');
  }
  if (!parsed.ok) {
    return head + '⚠️ 模型没给出可用编号 ✗（' + (parsed.reason || '解析失败') + '）\n'
      + '  它的原始回答：「' + String(answer).replace(/\s+/g, ' ').slice(0, 200) + '」\n'
      + '  → ★没有编号就不给坐标✓★（硬报一个坐标等于又回到"猜" ✗）\n'
      + '     建议：换个问法（更具体的词）再问一次 ✓，或者缩小区域 ✓\n'
      + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n');
  }
  const c = cands.find((x) => x.id === parsed.id);
  if (!c) {
    return head + '⚠️ 模型答的编号 ' + parsed.id + ' 不在候选范围（1~' + cands.length + '）✗ —— 按没有选中处理 ✓\n'
      + '  原始回答：「' + String(answer).replace(/\s+/g, ' ').slice(0, 200) + '」\n'
      + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n');
  }

  const cx = Math.round(c.x + c.w / 2), cy = Math.round(c.y + c.h / 2);
  const sw = (sp && sp.w) || sz.width, sh = (sp && sp.h) || sz.height;
  const nx = (Math.max(0, Math.min(sw, cx)) / sw).toFixed(3);
  const ny = (Math.max(0, Math.min(sh, cy)) / sh).toFixed(3);
  const list = cands.map((x) => '    ' + String(x.id).padStart(2) + '. [' + x.kind + '] '
    + (x.text ? '「' + String(x.text).slice(0, 24) + '」' : '(无文字)')).join('\n');
  /* ★★ 2026-10-10：把"怎么真的去点它"指到【确定性来源】上 ★★
     原来这一行写的是「→ move_norm|nx,ny　或 click|cx,cy」✗ ——
     那等于教她"拿模型选中的东西 + 直接按坐标点"，而 move_norm 已经废除、
     且"按坐标点"一旦坐标不可靠就会变成假成功 ✗。
     ✓ 现在按候选**本来的来源**分流：UIA→uia_invoke（零坐标触发）、OCR→find_text、模板→find_template。
     ★这就是"让模型选元素、不让模型给坐标"的最后一步✓★：模型只回编号，动作走确定性通道 ✓。 */
  const routeTip = c.kind === 'uia'
    ? '★这是 UIA 控件候选 → 点击请直接 uia_invoke|<窗口标题片段>|<控件名>（零坐标、不碰鼠标、不怕遮挡）★'
    : (c.kind === 'ocr'
      ? '★这是 OCR 文字行 → 点击请用 find_text|' + String(c.text || '').slice(0, 20) + '（程序自己定位+复核）★'
      : (c.kind === 'template'
        ? '★这是模板命中候选 → 点击请用 find_template|<模板名>（程序自己再定位一次）★'
        : '★这是附加候选（无文字/无控件来源）→ 它的框是程序量的 ✓；要点击前先确认窗口没被挡，点完用 screen_diff 确认有反应 ✓'));

  return head
    + '  ★模型选的是编号：#' + parsed.id + '★（置信度 ' + parsed.confidence + '）—— ★它是靠编号选的，不是估坐标★\n'
    + '  身份：' + (c.text ? '「' + c.text + '」' : '(无文字)') + '　来源类型：' + c.kind + '\n'
    + '  框：(' + Math.round(c.x) + ',' + Math.round(c.y) + ') ' + Math.round(c.w) + 'x' + Math.round(c.h)
    + '　中心 (' + cx + ',' + cy + ')\n'
    + '  中心 (' + cx + ',' + cy + ')　归一化：' + nx + ',' + ny + '\n'
    + '  ' + routeTip + '\n'
    + '  ★这个框是候选**本来就带的**（OCR 行框 / UIA 自报矩形）✓ —— 模型只回了一个编号 ✗→✓，全程没有"估"✓\n'
    + '  原始回答：「' + String(answer).replace(/\s+/g, ' ').slice(0, 120) + '」\n'
    + '  候选清单（编号 = 按阅读顺序上到下、左到右 ✓ —— ★同一屏两次调用编号一致★，可以直接说"点 7 号"）\n'
    + list + '\n'
    + '  来源：\n' + notes.map((n) => '   · ' + n).join('\n')
    + (uiaTotal === 0 && !region ? '\n  ⚠️ 这次没有 UIA 控件候选（游戏里正常 ✓）—— 纯图标目标请改用 icon_pick / grid_scan ✓' : '');
}

/* ═══════════════════════════════════════════════════════════════════
 * ⑥ strip_read —— ★细长区域：整条裁成**一张**图 → 独立控制放大倍数 → 一次问完★
 *   用法：strip_read|<问题>|<x,y,w,h>|<放大倍数，默认自动>|<最长边上限，默认2000>
 *
 *   ★为什么需要它（它补的是上面五个都没覆盖的那一格 ✗）★
 *     · screen_look 的放大是★固定 3 倍、而且只按**宽度**表达★
 *       （resize({ width: Math.min(1920, rw*3) }) ✓ —— 已核对源码 ✓）→
 *       一条 100x1030 的竖条会变成 300x3090 ✓：★倍数不可调✗★（要更清楚一点都做不到 ✓）、
 *       ★高度随长度线性爆掉✗★（1030 高 → 3090 高，且**没有像素上限** ✗），
 *       宽/高也不能**分别**给预算 ✗。
 *     · tile_read ★会把区域切成多块分别问★ ✓ → ★丢掉「整条一起看」的视野✗★；
 *       而看**一列图标 / 一列文字 / 一条列表**时，整条一起看恰恰是关键 ✓
 *       （只有整条在一个上下文里，模型才排得准「谁在谁上面」✓）。
 *       ★而且它每块上限 1024px、还带重叠 ✓★ —— 超过 1024 高的竖条**不可能**一次看完 ✗。
 *     · find_grid 只测几何（位置 / 间距 ✓），**不回答「那是什么」** ✗。
 *   ★做法★：整个 x,y,w,h 当作**一张图**裁 ✓（★不切块✗★）+ 宽高分别算倍数但保持比例 ✓
 *     + 只问**一次** ✓。（推荐自己写裁剪而**不动** cropZoom ✓ —— 改它的行为会连带影响
 *     前面四个工具 ✓，那正是"顺手改一下"最容易出事的地方 ✗。）
 *
 *   ★边界（诚实说，别把两件事混起来 ✗）★
 *     整条一起看 → 同一列 / 同一行的**相对顺序**是可信的 ✓；
 *     ★但**像素级坐标**不可信✗★ —— 要说"第 3 个在 y=某处"必须靠 find_grid / 模板 / UIA 控件树 ✓。
 *     ★读得清 ≠ 坐标准✗★：这一段话必须跟着返回值一起给她，否则她很可能拿模型的
 *     "第 3 个大约在中间"去点击 ✓（那正是今天偏半格的根因 ✗）。
 *
 *   ★上限保护✗★：放大后总像素超过 STRIP_MAX_PIXELS 就**降倍数**并在返回里说明 ✓
 *     —— 一张 2000x6000 的图送进视觉模型会超时 ✗，宁可小一点也要问得回来 ✓。
 * ═══════════════════════════════════════════════════════════════════ */
const STRIP_MAX_W = 1000;           // 默认宽度上限 ✓（细长条的"窄边"方向 ✓）
const STRIP_MAX_H = 2000;           // 默认高度上限 ✓（细长条的"长边"方向 ✓）
const STRIP_MAX_PIXELS = 12000000;  // ★放大后总像素上限★：超了降倍数 ✗，免得请求超时 ✓

async function stripRead(arg) {
  const a = normArg(arg);
  const q = String(a[0] || '').trim();
  if (!q) {
    return '❌ strip_read 用法：strip_read|<问题>|<x,y,w,h>|<放大倍数，默认自动>|<最长边上限，默认2000>\n'
      + '  例：strip_read|这一条里从上到下有什么|1800,60,120,1030';
  }
  const box = parseBox(a[1]);
  if (!box) return '❌ strip_read 的区域格式应为 x,y,w,h（例：1800,60,120,1030）';

  /* 长边上限（a[3]）：默认 2000 ✓。它比默认细长条的"窄边上限"1000 大 ✓ ——
     这正是关键✗→✓：如果宽高共用一个上限，竖条要么拉不高 ✓、要么被压回 1000 宽 ✓。 */
  const capRaw = Number(a[3]);
  const longCap = Number.isFinite(capRaw) && capRaw > 0
    ? Math.max(200, Math.min(4000, Math.round(capRaw))) : STRIP_MAX_H;
  const maxW = Math.max(200, Math.min(STRIP_MAX_W, longCap));
  const maxH = longCap;
  const kRaw = Number(a[2]);
  const hasK = Number.isFinite(kRaw) && kRaw > 0;

  const cap = await deps.capture();
  const cfg = deps.config.load();
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(cap.dataUrl);
  const sz = img.getSize();
  /* 裁剪参数与 cropZoom 保持一致 ✓（贴边时留 8px 余量 ✓，避免 crop 越界报错 ✓） */
  const x = Math.max(0, Math.min(sz.width - 8, Math.round(box.x)));
  const y = Math.max(0, Math.min(sz.height - 8, Math.round(box.y)));
  const w = Math.max(8, Math.min(sz.width - x, Math.round(box.w)));
  const h = Math.max(8, Math.min(sz.height - y, Math.round(box.h)));
  const crop = img.crop({ x, y, width: w, height: h });

  /* ★★ 宽高分别算倍数、但保持比例 ✗→✓ ★★
     先算 k = min(maxW/w, maxH/h) ✓，再 outW = round(w*k)、outH = round(h*k) ✓ ——
     这样**同一张图的两个方向用的是同一个 k**✓（比例不变 ✓），但 k 是根据**两个**上限一起定的 ✓。
     只按宽度算（cropZoom 那套 target = max(240, min(maxW, w*6)) ✗，已核对源码 ✓）会怎样 ✗：
     一条 60x1000 的竖条算成 k = min(1000, 360)/60 = 6 → ★输出 360x6000✗★ ——
     高度**没人管** ✓、像素数也没上限 ✓（6 倍插值出来的 6000 高图又慢又糊 ✗，
     真送进模型还容易超时 ✗）✓ */
  let k = hasK ? kRaw : Math.min(maxW / w, maxH / h);
  const notes = [];
  if (!hasK && k < 1) {
    /* 区域本来就比上限大：★不缩小✗★ —— 缩小只会丢信息 ✓，原样 1x 送过去最安全 ✓ */
    k = 1;
    notes.push('区域自身已超过上限 → ★不缩小✗★（缩小只会丢信息 ✓），按 1x 原样送 ✓');
  }
  let outW = Math.max(1, Math.round(w * k));
  let outH = Math.max(1, Math.round(h * k));
  let capped = false;                 // ★是否被像素上限下调过✗★：返回里要如实说 ✓（别写成"你给的倍数"✗）
  /* ★像素上限保护✗★：降倍数而不是截断 ✓ —— 截断会把内容切掉 ✗，降倍数只是看得小一点 ✓ */
  if (outW * outH > STRIP_MAX_PIXELS) {
    capped = true;
    const kWant = k;
    /* ★先按面积比例直接算出目标倍数✓★（只靠循环乘 0.85 在倍数很大时要十几轮才收敛 ✗），
       再留一个 0.98 的小循环收掉四舍五入的尾巴 ✓ */
    k = k * Math.sqrt(STRIP_MAX_PIXELS / (outW * outH));
    outW = Math.max(1, Math.round(w * k));
    outH = Math.max(1, Math.round(h * k));
    let guard = 0;
    while (outW * outH > STRIP_MAX_PIXELS && guard < 8) {
      k *= 0.98; guard++;
      outW = Math.max(1, Math.round(w * k));
      outH = Math.max(1, Math.round(h * k));
    }
    notes.push('放大后 ' + Math.round(w * kWant) + 'x' + Math.round(h * kWant)
      + ' = ' + Math.round(w * kWant * h * kWant) + ' 像素 > 上限 ' + STRIP_MAX_PIXELS
      + ' → ★倍数降到 ' + (Math.round(k * 100) / 100) + 'x✓★（不然请求会超时 ✗）');
  }

  const big = crop.resize({ width: outW, height: outH, quality: 'best' });
  const dataUrl = big.toDataURL();
  const gsz = big.getSize();

  /* ★只问一次✗★（这是它和 icon_pick / grid_scan 的分工 ✓：
     那两个是"抗抖/逐格"，这一个是"一次看全条"✓） */
  let t = '';
  let err = '';
  try { t = String(await deps.vision.describe(cfg, dataUrl, q, cfg.visionDetail || 'high') || ''); }
  catch (e) { err = String((e && e.message) || e); }
  const ans = t.replace(/\s+/g, ' ').trim();
  const LIMIT = 1500;
  const cut = ans.length > LIMIT;

  return '📏 strip_read：区域 (' + x + ',' + y + ') 真实 ' + w + 'x' + h
    + '　放大 ' + (Math.round(k * 100) / 100) + 'x → 输出 ' + gsz.width + 'x' + gsz.height
    + '（' + (capped ? '★你给的倍数已按像素上限下调✗→✓★'
      : (hasK ? '你给的倍数' : '自动算的倍数')) + '；上限 宽' + maxW + ' 高' + maxH + ' ✓）'
    + '\n  问题：' + q.slice(0, 120)
    + '\n  ★整条一起看★ ' + (err ? '⚠️ 视觉模型报错：' + err : (ans || '（空回答）'))
    + (cut ? '\n  …★已截断到 ' + LIMIT + ' 字✗★（原文 ' + ans.length + ' 字✓，要全看就缩小区域再问 ✓）' : '')
    + '\n  ★这是**整条一起**看的 ✓，所以同一列 / 同一行的**相对顺序**是可信的 ✓；'
    + '★但**像素级坐标**仍然要靠 find_grid / 模板 / UIA 控件树 ✓✗★ —— ★读得清 ≠ 坐标准✗★，别拿这里的描述去点击 ✓'
    + (notes.length ? '\n  ⚠️ ' + notes.join('\n  ⚠️ ') : '');
}

/* ── 入口 ✓ ── */
const TOOLS = ['icon_pick', 'grid_scan', 'find_grid', 'tile_read', 'som_look', 'strip_read'];

async function run(tool, arg) {
  if (!deps) return '❌ vision2 未初始化（内部错误）';
  if (tool === 'icon_pick') return await iconPick(arg);
  if (tool === 'grid_scan') return await gridScan(arg);
  if (tool === 'find_grid') return await findGrid(arg);
  if (tool === 'tile_read') return await tileRead(arg);
  if (tool === 'som_look') return await somLook(arg);
  if (tool === 'strip_read') return await stripRead(arg);
  return '❌ 未知视觉增强操作：' + tool;
}

module.exports = { install, run, TOOLS };
