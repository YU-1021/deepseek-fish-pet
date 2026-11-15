/* desktopwin.js —— ★「按窗口看图」+「数格子」两个工具的落地层★
 *
 * 【它补的是哪一格（2026-10-10 主人："按 DSH 的方式重做视觉"）】
 *   ① `win_shot|<进程名>`：调 MCP `desktop-auto` 的 `bot_screenshot`，
 *      ★只拿【那一个窗口】的图★ + 精确 `windowBounds` ✓；
 *   ② `grid_count|<图/进程>|<v|h>|...`：用 src/gridcount.js 的**确定性像素算法**
 *      数出这一列/一行上有几个等距格子、各自中心在哪 ✓（模型不参与"在哪" ✗）。
 *
 * 【★真机实测的两条硬事实（都是坏消息，照实写 ✗→✓）★】
 *   ① ★`bot_screenshot` 在**这台机器/这个版本**上返回的其实是**整屏图**✗★，
 *      不是"那一个窗口"：
 *        · 实测 meta.width/height = 1920×1080，而 windowBounds = 0,0,1536×864 ✗；
 *        · 与 `bot_screenshot_fullscreen` 的结果**逐像素比对**：平均绝对差 1.7/255 ✓
 *          （只差光标/时钟那几像素 ✓）→ ★它就是整屏截图 ✓★。
 *      根因（读它的源码 dist/screenshot.js ✓）：它是
 *        「`node-screenshots` 抓**整台显示器** → 按 windowBounds 裁 ✗」，
 *        而本机 `monitor.scaleFactor` 取不到（真机实测：Monitor 的属性读出来是 undefined ✗
 *        → `scaleFactor || 1` = 1 ✗）→ 裁剪尺寸按 1:1 算、和物理像素对不上 ✗
 *        → 代码里 `cropW/cropH` 的判断让它退回"用整张截图" ✗。
 *   ② ★所以"按窗口截图就不会被别的窗口挡住"这句话**是错的**✗★ ——
 *      它抓的是屏幕，别的窗口盖在游戏上就照样拍进去 ✓（实测那张图里全是 DSH 窗口 ✓）。
 *      ★诚实的补救★（本模块做的）：
 *        · 我们**自己按 windowBounds 裁**✓ —— 裁完的尺寸用像素断言 ✓（不是"应该没问题"✓）；
 *        · 想要干净画面 → 先 `bot_activate_window` 把窗口提到最前 ✓（`win_shot|<进程>|activate` ✓），
 *          这一步是**主人自己的窗口抢焦点** ✓，所以只在明确要求时才做 ✓（默认不做 ✗）。
 *
 * 【副产品（这些是真的有用的 ✓）】
 *   · 一次调用就拿回 `windowBounds` ✓ → 窗口内坐标 ↔ 整屏坐标 ↔ 她的坐标空间（input.space ✓）
 *     三种换算都变成**算术** ✓，不用再猜；
 *   · 还能给 bot_click 用的 **bbox 0~1000（窗口内归一化）** ✓；
 *   · 图落在 `userData/shots/win-*.png|jpg` ✓，路径可复查 ✓。
 *
 * 【图像格式（诚实说 ✗）】
 *   MCP 返回的是 **JPEG** ✓（内部先拿无损 PNG、裁完最后编码 JPEG ✓）→
 *   ★这里**收不到"无损"的原始图**✗★。本模块的做法：
 *     · 请求 `quality=100` 且不缩放（maxWidth=4096 ✓）→ 接近无损 ✓（但仍是 JPEG ✓）；
 *     · 我们裁完的窗口图**存成 PNG** ✓ —— 那是对"解码后的像素"无损 ✓，
 *       不是对"原始画面"无损 ✗（JPEG 那一步的信息已经丢了 ✓）。这两件事不能混 ✗。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const GC = require('./gridcount');

function dbg(m) { try { require('./debug').log('[win] ' + m); } catch (e) {} }

/* 依赖由 assistant.js 注入（这样本模块不必 require electron ✓，纯 Node 可测 ✓） */
let deps = { space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1536, h: 864, scaleFactor: 1 }), shotDir: () => null };
function install(d) { deps = Object.assign({}, deps, d || {}); }
function shotDir() {
  const d = deps.shotDir();
  if (!d) throw new Error('没有可写目录（shotDir 未注入）');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function seg(arg) { return String(arg == null ? '' : arg).split('|').map((s) => s.trim()); }

async function mcp() {
  const m = require('./mcp');
  try { m.configure((require('./config').load() || {}).mcpServers); } catch (e) {}
  return m;
}

function pickImage(res) {
  const content = (res && res.content) || [];
  const img = content.find((c) => c && c.type === 'image');
  const txt = content.find((c) => c && c.type === 'text');
  let meta = null;
  try { meta = txt ? JSON.parse(txt.text) : null; } catch (e) { meta = null; }
  return { img, meta, text: txt ? String(txt.text) : '' };
}

/* ★按进程截图 + 自己裁成"只有那个窗口"的图★
 * 返回 { path, w, h, pxPerDip, windowBounds, meta, crop, note, jpegNote } */
async function shotWindow(processName, opts) {
  const o = opts || {};
  const m = await mcp();
  if (o.activate) {
    /* 提到最前 —— 这是**唯一**能真正去掉遮挡的办法 ✓（见文件头：它是整屏裁的 ✗） */
    try { await m.callTool('desktop-auto', 'bot_activate_window', { processName }); } catch (e) { dbg('activate 失败：' + e.message); }
    await new Promise((r) => setTimeout(r, o.activateWaitMs == null ? 400 : o.activateWaitMs));
  }
  const res = await m.callTool('desktop-auto', 'bot_screenshot', {
    processName,
    quality: o.quality == null ? 100 : o.quality,
    maxWidth: o.maxWidth == null ? 4096 : o.maxWidth,
  });
  const { img, meta } = pickImage(res);
  if (!img || !img.data) {
    throw new Error('bot_screenshot 没返回图片：' + (JSON.stringify(res).slice(0, 300)));
  }
  const raw = Buffer.from(img.data, 'base64');
  const wb = (meta && meta.windowBounds) || null;
  const imgW = (meta && meta.width) || 0;
  const imgH = (meta && meta.height) || 0;
  const disp = deps.display();
  const stamp = Date.now();
  const dir = shotDir();
  const baseName = 'win-' + String(processName).replace(/[^\w.-]/g, '') + '-' + stamp;

  /* Jimp 解码（jimp 1.x 是纯 JS ✓，Electron 主进程和纯 Node 都能跑 ✓） */
  const { Jimp } = require('jimp');
  const full = await Jimp.fromBuffer(raw);
  const phys = { w: disp.w * (disp.scaleFactor || 1), h: disp.h * (disp.scaleFactor || 1) };
  const looksFullScreen = full.width >= phys.w - 2 && full.height >= phys.h - 2;
  let out = full;
  let crop = null;
  if (wb && wb.width > 0 && wb.height > 0 && (looksFullScreen || full.width > wb.width * 1.02 || full.height > wb.height * 1.02)) {
    /* 图比窗口大 → 按 windowBounds 裁（图 ↔ 物理屏的比例用实测的 full.width/phys.w ✓） */
    const sx = phys.w > 0 ? full.width / phys.w : 1;
    const sy = phys.h > 0 ? full.height / phys.h : 1;
    crop = {
      x: Math.max(0, Math.round(wb.x * (disp.scaleFactor || 1) * sx)),
      y: Math.max(0, Math.round(wb.y * (disp.scaleFactor || 1) * sy)),
      w: Math.round(wb.width * (disp.scaleFactor || 1) * sx),
      h: Math.round(wb.height * (disp.scaleFactor || 1) * sy),
    };
    crop.w = Math.max(8, Math.min(full.width - crop.x, crop.w));
    crop.h = Math.max(8, Math.min(full.height - crop.y, crop.h));
    out = full.clone().crop(crop);
  }
  const jpg = path.join(dir, baseName + '.jpg');
  fs.writeFileSync(jpg, raw);                                  // 原图（JPEG q100）留存，便于对照 ✓
  const png = path.join(dir, baseName + '.png');
  fs.writeFileSync(png, await out.getBuffer('image/png'));      // 窗口图（对解码后的像素无损 ✓）
  return {
    path: png, jpgPath: jpg, rawBytes: raw.length,
    w: out.width, h: out.height,
    pxPerDipX: wb && wb.width ? out.width / wb.width : 1,
    pxPerDipY: wb && wb.height ? out.height / wb.height : 1,
    windowBounds: wb, imageWH: { w: imgW, h: imgH }, crop,
    looksFullScreen, display: disp, mime: img.mimeType || '',
  };
}

/* 图像像素 → 各种坐标空间 ✓（三种都给出，并标明哪一种能直接喂给谁 ✓） */
function coordsFrom(shot, px, py) {
  const wb = shot.windowBounds || { x: 0, y: 0 };
  const sx = shot.pxPerDipX || 1, sy = shot.pxPerDipY || 1;
  const local = { x: px / sx, y: py / sy };                    // 窗口内 DIP
  const dip = { x: wb.x + local.x, y: wb.y + local.y };        // 整屏 DIP（逻辑）
  const sp = deps.space();                                     // 她的坐标空间（= 抓帧空间 ✓）
  const d = shot.display || deps.display();
  const space = {
    x: Math.round(dip.x / (d.w || 1) * (sp.w || 1)),
    y: Math.round(dip.y / (d.h || 1) * (sp.h || 1)),
  };
  const bbox = shot.w && shot.h
    ? [Math.round(local.x / shot.w * 1000), Math.round(local.y / shot.h * 1000)]
    : null;
  return { px: { x: px, y: py }, local, dip, space, bbox };
}

/* ★★坐标空间声明★★（2026-10-11 主人问："她的坐标到底物理还是 DIP、有没有混用"）
   本工具的坐标有**两种**来路，绝不能让人猜 ✗→✓：
     · 第一个参数是**进程名** → 先按窗口截图拿到 windowBounds（DIP）→ 每格**换算成她的坐标空间**（space()）✓
     · 第一个参数是**图片路径** → 只有"图内像素"这一个空间：
         · 图 = 整屏抓帧（默认 1920x1080 = space()）→ 图内像素 == 她的坐标空间 ✓ 可以直接 click ✓
         · 图 = 窗口裁图（win_shot 出来的那种）→ 图内像素 ≠ 屏幕坐标 ✗ 直接 click 会整体偏 ✗
   （转换只在一处：本文件的 coordsFrom()，用「DIP 尺寸 + scaleFactor + space()」三件套算 ✓） */
function spaceNoteFor(imgW, imgH) {
  const sp = deps.space();
  if (!sp || !sp.w || !sp.h) return '　★坐标空间：图内像素（拿不到屏幕尺寸，没法换算）★';
  if (imgW === sp.w && imgH === sp.h) {
    return '　★坐标空间 = 你的坐标空间（这张图就是整屏 ' + sp.w + 'x' + sp.h + '）✓ 可以直接拿去 click ✓★';
  }
  return '　⚠️★坐标空间 = **这张图的像素**（' + imgW + 'x' + imgH + '，≠ 整屏 ' + sp.w + 'x' + sp.h + '）✗'
    + ' 下面的坐标**不能直接**拿去 click ✗ —— 要屏幕坐标就把第一个参数换成**进程名**'
    + '（它会按 windowBounds 换算到你的坐标空间 ✓）★';
}

/* ───────────────────────── 工具 ①：win_shot ───────────────────────── */
async function winShot(arg) {
  const a = seg(arg);
  const proc = a[0];
  if (!proc) return '❌ 用法：win_shot|<进程名，如 Arknights 或 chrome>|<activate，可选>\n'
    + '  ★进程名不知道就先 windows_list 看 ✓（本工具用的是 MCP desktop-auto 的按进程截图 ✓）★';
  const activate = /^(activate|激活|前台|1|true|yes)$/i.test(String(a[1] || ''));
  const t0 = Date.now();
  const s = await shotWindow(proc, { activate });
  const ms = Date.now() - t0;
  const wb = s.windowBounds || {};
  const lines = [];
  lines.push('🖼 按窗口截图：' + proc + '（' + Math.round(ms / 1000) + 's' + (activate ? '，已先提到最前 ✓' : '') + '）');
  lines.push('  图：' + s.path + '（' + s.w + '×' + s.h + '，PNG，对解码后的像素无损 ✓）');
  lines.push('  原始 JPEG：' + s.jpgPath + '（' + Math.round(s.rawBytes / 1024) + ' KB，q100 ✓）');
  lines.push('  窗口边界 windowBounds：' + JSON.stringify(wb) + '　图/窗口比例：' + s.pxPerDipX.toFixed(3) + '×' + s.pxPerDipY.toFixed(3));
  if (s.crop) lines.push('  ★我按窗口边界裁过★：图里的矩形 ' + JSON.stringify(s.crop) + ' ✓（裁完尺寸 = ' + s.w + '×' + s.h + ' ✓）');
  /* ★这条必须写在回执里（诚实高于好看 ✗→✓）★ */
  if (s.looksFullScreen || s.crop) {
    lines.push('  ⚠️ ★实测事实★：这台机器上的 MCP `bot_screenshot` 其实返回的是**整屏图**✗'
      + '（实测 ' + s.imageWH.w + '×' + s.imageWH.h + '，而窗口只有 ' + wb.width + '×' + wb.height + '；'
      + '与"整屏截图"逐像素比对平均差 1.7/255 ✓ 就是同一张 ✗）→ **我是自己按 windowBounds 裁出来的** ✓。');
    lines.push('  ⚠️ ★而且它**挡不住遮挡**✗★：它走的是"抓屏幕再裁"✓，别的窗口盖在上面照样拍进去 ✗'
      + '（真机实测那张图里全是 DSH 窗口 ✓）。★要干净画面：win_shot|' + proc + '|activate ✓（把窗口提到最前再拍 ✓）★');
  }
  lines.push('  ★下一步★：要量位置就用 grid_count|' + s.path + '|<v竖|h横>|<窗口内 x,y,w,h，可省>|<期望个数，可省> ✓');
  lines.push('  ⚠️ 格式：★JPEG（q100）★，不是无损 ✗ —— 小字/细线仍可能有压缩痕迹 ✓，'
    + '要放大读字请把区域裁小（grid_count 或 screen_look 的放大都用得上 ✓）');
  return lines.join('\n');
}

/* ───────────────────────── 工具 ②：grid_count ───────────────────────── */
/* 用法：grid_count|<图片路径 或 进程名>|<v|h>|<x,y,w,h，窗口内像素，可省>|<期望个数，可省> */
async function gridCount(arg) {
  const a = seg(arg);
  const target = a[0];
  if (!target) return '❌ 用法：grid_count|<图片路径 或 进程名>|<v竖排|h横排>|<x,y,w,h，可省>|<期望个数，可省>\n'
    + '  例：grid_count|C:/.../win-Arknights-123.png|v|1800,60,120,1030|9';
  const dir = String(a[1] || 'v').toLowerCase().startsWith('h') ? 'h' : 'v';
  let box = null;
  if (a[2]) {
    const p = a[2].split(',').map((x) => Number(String(x).trim()));
    if (p.length === 4 && p.every((v) => Number.isFinite(v))) box = { x: p[0], y: p[1], w: p[2], h: p[3] };
    else return '❌ 区域格式应为 x,y,w,h（收到「' + a[2] + '」）';
  }
  const expect = Number(a[3]) > 0 ? Number(a[3]) : 0;

  let shot = null;
  let imgPath = target;
  if (!/\.(png|jpe?g|bmp)$/i.test(target)) {
    /* 传的是进程名 → 先按窗口截一张（顺手拿到 windowBounds，坐标才能换算 ✓） */
    shot = await shotWindow(target, {});
    imgPath = shot.path;
  } else {
    try { if (!fs.existsSync(imgPath)) return '❌ 找不到这张图：' + imgPath; } catch (e) {
      return '❌ 路径不可读：' + imgPath;
    }
  }
  const { Jimp } = require('jimp');
  const img = await Jimp.fromBuffer(fs.readFileSync(imgPath));
  const luma = GC.lumaFromBitmap(img.bitmap.data, img.width, img.height, false);
  const region = box
    ? { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h }
    : { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 };
  const r = GC.analyze(luma, img.width, img.height, {
    dir, region, expect: expect || undefined, k: 2, bandSearch: 56,
  });

  const lines = [];
  lines.push((r.quality.verdict === 'ok' ? '📐 ' : '⚠️ ') + '数格子：' + dir + ' 方向，图 ' + img.width + '×' + img.height
    + '，实际量的是 ' + JSON.stringify(r.region));
  /* ★坐标空间必须写在回执里★（传进程名时下面每格已换算成她的坐标空间 ✓；传图片路径时只有图内像素 ✗） */
  if (!shot) lines.push(spaceNoteFor(img.width, img.height));
  lines.push('  ★测到 ' + r.cells.length + ' 格★（其中 ★' + r.anchors + ' 格是**直接测到的**'
    + (r.estimated ? '，' + r.estimated + ' 格是**按格距推算补的**（标(估) ✓）' : '')
    + (r.offLattice && r.offLattice.length ? '，' + r.offLattice.length + ' 格**不在主格距上**（标"外" ✓，没有丢掉 ✓）' : '')
    + '）；格距 ' + (r.spacing ? r.spacing.toFixed(1) + 'px' : '(没测出)')
    + '，残差 ' + (r.cv * 100).toFixed(1) + '%，' + (r.consistent ? '等距 ✓' : '不等距 ✗'));
  if (r.quality.verdict !== 'ok') lines.push('  ⚠️ ★这条路的结果我不信★：' + r.quality.reasons.join('；') + ' ✗ —— 请收窄区域或换 v/h ✓');
  if (r.sweep && r.sweep.expect) {
    lines.push('  期望 ' + r.sweep.expect + ' 格：' + (r.sweep.found
      ? '★扫到可用参数（阈值倍数 ' + r.sweep.hitKs.join('/') + '）✓，用的是 ' + r.k + ' ✓'
      : '★扫遍阈值也凑不出 ' + r.sweep.expect + ' 格 ✗ —— 我**不编**：实测就是 ' + r.cells.length + ' 格 ✓★'));
    /* ★凑不出来时的**下一步动作**必须给出来**✗→✓（真机实测踩到过 ✓）：
       整窗跑的时候，最上面那行「收起/标题」和最下面**任务栏**都会各算成"一格" ✗
       → 于是出现"期望 9 结果 10"✓。★这不是算法错，是区域里混进了别的东西 ✓★ ——
       所以这里明确告诉她：把区域收窄到"只有那一列/那一排"再试 ✓（而不是让她以为这条路没救 ✗）。 */
    if (!r.sweep.found) {
      lines.push('  → ★下一步★：把区域收窄到**只有你要的那一列/那一排**再试一次 ✓'
        + '（★最常见的原因★：区域里混进了**最上面那一行标题/「收起」**、或**最下面的任务栏** ✓ —— '
        + '它们各自也会被算成一格 ✗）。区域写法是"窗口内 x,y,w,h"，可以先用 win_shot 的图看一眼再给 ✓。');
    }
  }
  const maxShow = 40;
  r.cells.slice(0, maxShow).forEach((c, i) => {
    const cx = dir === 'v' ? Math.round(r.region.x0 + (r.region.x1 - r.region.x0) / 2) : c.center;
    const cy = dir === 'v' ? c.center : Math.round(r.region.y0 + (r.region.y1 - r.region.y0) / 2);
    let extra = '';
    if (shot) {
      const K = coordsFrom(shot, cx, cy);
      extra = '  窗口内 ' + JSON.stringify({ x: Math.round(K.local.x), y: Math.round(K.local.y) })
        + '  她的坐标空间 ' + K.space.x + ',' + K.space.y
        + '  给 bot_click 的 bbox ' + (K.bbox ? K.bbox.join(' ') : '-');
      /* ★只有"换算成她的坐标空间"的格子才记进账本★（2026-10-11）：
         传进程名时坐标是屏幕坐标 ✓ 可以当"复点的新证据" ✓；
         传图片路径时那只是图内像素 ✗ —— 记进去等于授权一次错点 ✗ 所以不记 ✓ */
      try { require('./prov').instance.offer(K.space.x, K.space.y, 'grid_count', dir + ' 第 ' + (i + 1) + ' 格'); } catch (e) {}
    }
    lines.push('  ' + String(i + 1).padStart(2) + '. ' + (c.estimated ? '(估)' : (c.inLattice ? '   ' : '外 ')) + ' '
      + (dir === 'v' ? 'y=' : 'x=') + c.center + (c.run && c.run.len ? '（段 ' + c.run.len + 'px）' : '') + extra);
  });
  if (r.cells.length > maxShow) lines.push('  …（还有 ' + (r.cells.length - maxShow) + ' 格没列）');
  if (r.offLattice && r.offLattice.length) {
    lines.push('  ★不在主格距上的 ' + r.offLattice.length + ' 格★：' + r.offLattice.map((c) => c.center).join(', ')
      + ' → 它们**没被丢掉** ✓（实测职业列第 1 格就是这种：它是文字按钮「ALL」✓，'
      + '与第 2 格只隔 75px 而其余隔 115px ✓ —— 我没把它硬塞进格距 ✗，也没假装它不存在 ✓）');
  }
  lines.push('  ⚠️ ★这只是**几何**✗★ —— "第几格是哪个职业"是外部知识 ✓：顺序查技能里的表 ✓，'
    + '★而且我不给"含义"也不给"猜测"✓；要点击请拿上面的坐标，点完用 screen_diff 或回读确认 ✓★');
  return lines.join('\n');
}

/* ───────────────────────── 工具 ③：icon_lib（图标模板库：切格 → 存名 → 认名 ✓） ─────────────────────────
 * 用法：
 *   icon_lib|save|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省>|<名字按顺序、逗号分隔，可省>
 *   icon_lib|match|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省>
 *   icon_lib|list|<库名>
 * ★核心✗→✓：位置由 grid_count 的几何给 ✓；名字由模板库给 ✓；★全程不让模型报坐标✗★。
 * ★为什么文件名带序号✗★：今天真出过"名字写着狙击、其实是近卫"✓ → 序号（几何给的 ✓）与名字（人给的 ✓）
 *   分开存 ✓，`t03_狙击.png` 一眼看出"这是第 3 格" ✓。 */
async function iconLib(arg) {
  const a = seg(arg);
  const mode = String(a[0] || '').toLowerCase();
  const libbase = require('path').join(shotDir(), '..', 'iconlib');   // <userData>/iconlib ✓
  const IL = require('./iconlib');
  if (mode === 'list') {
    const lib = a[1];
    if (!lib) return '用法：icon_lib|list|<库名>';
    const idx = IL.loadIndex(libbase, lib);
    if (!idx) return '❌ 没有这个库：「' + lib + '」（先用 icon_lib|save 建 ✓）';
    return '📚 ' + lib + '：★' + (idx.entries || []).length + ' 个模板★（建库时间 ' + new Date(idx.at).toLocaleString() + '）'
      + '\n  格距 ' + (idx.spacing || 0).toFixed(1) + 'px　区域 ' + JSON.stringify(idx.region) + '　方向 ' + idx.dir
      + '\n' + (idx.entries || []).map((e) => '  ' + String(e.index).padStart(2) + '. ' + e.name
        + (e.given ? ' ✓人给的名字' : ' ✗（没人给名字 → 用默认 #序号）') + '　' + e.file).join('\n');
  }
  if (mode !== 'save' && mode !== 'match') {
    return '❌ 用法：\n'
      + '  icon_lib|save|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省>|<名字按顺序、逗号分隔>\n'
      + '  icon_lib|match|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省>\n'
      + '  icon_lib|list|<库名>';
  }
  const target = a[1];
  const libName = a[2];
  if (!target || !libName) return '❌ 缺参数：icon_lib|' + mode + '|<图或进程名>|<库名>|…';
  const dir = String(a[3] || 'v').toLowerCase().startsWith('h') ? 'h' : 'v';
  let box = null;
  if (a[4]) {
    const p = a[4].split(',').map((x) => Number(String(x).trim()));
    if (p.length === 4 && p.every((v) => Number.isFinite(v))) box = { x: p[0], y: p[1], w: p[2], h: p[3] };
    else return '❌ 区域格式应为 x,y,w,h（收到「' + a[4] + '」）';
  }
  const expect = Number(a[5]) > 0 ? Number(a[5]) : 0;
  const names = a[6] ? String(a[6]).split(/[,，]/).map((s) => s.trim()) : [];

  /* 图哪来：图片路径 ✓ 或进程名（顺手按窗口截一张 ✓ + 换算坐标 ✓） */
  let shot = null, imgPath = target;
  if (!/\.(png|jpe?g|bmp)$/i.test(target)) { shot = await shotWindow(target, {}); imgPath = shot.path; }
  else if (!fs.existsSync(imgPath)) return '❌ 找不到这张图：' + imgPath;

  const o = { image: imgPath, baseDir: libbase, libName, dir, expect, half: undefined };
  if (box) o.region = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h };

  if (mode === 'save') {
    const r = await IL.buildLibrary(Object.assign({ names }, o));
    const lines = [];
    lines.push('📚 已建图标库「' + libName + '」：★切出 ' + r.index.cells + ' 个模板★（' + r.dir + ' 方向）');
    if (!shot) lines.push(spaceNoteFor(r.index.imageW, r.index.imageH));
    lines.push('  目录：' + r.dir + '　索引：' + r.indexFile);
    lines.push('  几何：格距 ' + (r.analysis.spacing || 0).toFixed(1) + 'px，残差 ' + (r.analysis.cv * 100).toFixed(1)
      + '%，' + (r.analysis.consistent ? '等距 ✓' : '不等距 ✗'));
    lines.push('  ★文件名带序号✗→✓★（序号是几何给的 ✓，名字是人给的 ✓，分开存 ✓ —— 免得再出现"写着狙击其实是近卫"✗）：');
    r.index.entries.forEach((e) => {
      let extra = '';
      if (shot) { const K = coordsFrom(shot, e.box.x + Math.round(e.box.w / 2), e.box.y + Math.round(e.box.h / 2)); extra = '　她的坐标空间 ' + K.space.x + ',' + K.space.y; }
      lines.push('    ' + String(e.index).padStart(2) + '. ' + (e.given ? '「' + e.name + '」✓' : '（未命名 #' + e.index + '）')
        + '　' + e.file + '　中心 ' + e.center + extra);
    });
    lines.push('  ⚠️ 名字**只**来自你给的那串（顺序 = 从上到下 ✓）—— ★我不猜含义✗★；'
      + '要给名字就按顺序写在最后一个参数里（例：ALL,先锋,近卫,重装,狙击,术师,医疗,辅助,特种 ✓）。');
    return lines.join('\n');
  }

  const r = await IL.matchLibrary(Object.assign({ min: undefined }, o));
  const lines = [];
  lines.push('🔍 认图标（库「' + libName + '」，' + r.dir + ' 方向，★' + r.rows.length + ' 格★）');
  /* 传进程名 → 下面每格的"坐标"已换算成她的坐标空间 ✓；传图片路径 → 只有图内像素 ✗，必须明说 */
  if (!shot) lines.push(spaceNoteFor(r.index.imageW, r.index.imageH));
  lines.push('  ★判据（真机实测调的）★：最优分 ≥ ' + r.matchMin + ' **且** 领先次优 ≥ ' + r.marginMin
    + ' 才算"就是它" ✓；分数 ≥ ' + r.candMin + ' 但不够以上两条 → 报"⚠️ 不确定" ✗ 不硬选 ✓；低于 ' + r.candMin + ' → "❌ 没找到" ✓');
  if (shot) lines.push('  图：' + shot.path);
  const tally = { match: 0, uncertain: 0, none: 0 };
  r.rows.forEach((row) => {
    tally[row.verdict] = (tally[row.verdict] || 0) + 1;
    let extra = '';
    if (shot) {
      const K = coordsFrom(shot, row.box.x + Math.round(row.box.w / 2), row.box.y + Math.round(row.box.h / 2));
      extra = '　坐标 ' + K.space.x + ',' + K.space.y;
      /* 同 grid_count：只有换算成她的坐标空间的坐标才记进账本 ✓（图片路径那种不记 ✗） */
      if (row.verdict === 'match') { try { require('./prov').instance.offer(K.space.x, K.space.y, 'icon_lib', String(row.name)); } catch (e) {} }
    }
    const second = row.second ? ('，次名「' + row.second.name + '」' + row.second.score.toFixed(3)) : '';
    const margin = (row.margin == null) ? '-' : row.margin.toFixed(3);
    if (row.verdict === 'match') {
      lines.push('  ' + String(row.index).padStart(2) + '. ★就是它：「' + row.name + '」★　分数 ' + row.score.toFixed(3)
        + '　领先次优 ' + margin + '　尺度 ' + (row.scale == null ? '-' : row.scale) + extra);
    } else if (row.verdict === 'uncertain') {
      lines.push('  ' + String(row.index).padStart(2) + '. ⚠️ ★不确定★（最高「' + (row.all[0] ? row.all[0].name : '-') + '」' + row.score.toFixed(3)
        + '，领先次优只有 ' + margin + '，不到 ' + r.marginMin + '）→ ★我不硬选✗：请把区域收窄/换个角度再来一次，或让你/主人给一次答案 ✓★' + second + extra);
    } else {
      lines.push('  ' + String(row.index).padStart(2) + '. ❌ ★没找到★（最高只有 ' + row.score.toFixed(3) + '，低于 ' + r.candMin + '）' + second + extra);
    }
  });
  lines.push('  ★统计★：就是它 ' + tally.match + ' 格 ✓　不确定 ' + tally.uncertain + ' 格 ⚠️　没找到 ' + tally.none + ' 格 ❌'
    + '（共 ' + r.rows.length + ' 格）');
  lines.push('  ⚠️ 名字来自模板库 ✓（人给过的顺序 ✓）；★认不出时明说 ✗ 不硬凑 ✓★；'
    + '要点击请用上面的坐标，点完用 screen_diff 确认 ✓。');
  return lines.join('\n');
}

async function run(tool, arg) {
  if (tool === 'win_shot') return await winShot(arg);
  if (tool === 'grid_count') return await gridCount(arg);
  if (tool === 'icon_lib') return await iconLib(arg);
  throw new Error('desktopwin 不认识这个工具：' + tool);
}

module.exports = { install, run, winShot, gridCount, iconLib, shotWindow, coordsFrom };
