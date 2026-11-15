/* probe-desktopwin.js —— ★真机验证「按窗口截图 + 数格子」这两个工具★（纯 Node，不开任何窗口 ✓）
 *
 * 跑法：node app\scripts\probe-desktopwin.js [游戏进程名，默认 Arknights] [普通窗口进程名，默认 DeepSeek Harness]
 *
 * 【为什么能在纯 Node 里跑】
 *   src/desktopwin.js 把 electron 依赖**注入**（space / display / shotDir ✓）→
 *   探针给一组真实值就能跑 ✓，不需要开 Electron 窗口 ✓（主人被弹窗烦过 ✗，这条是硬规矩 ✓）。
 *
 * 【它断言什么（★都是真机数据，不是想象★）】
 *   ① 游戏窗口：★右侧职业图标列 → 恰好 9 格 + 等距 ✓★（主人给的顺序表是 9 项 ✓）
 *   ② 普通窗口：★同一套算法在别的窗口上也测得出等距格 ✓★（证明不是对游戏过拟合 ✓）
 *   ③ 裁窗口：图比窗口大时，我们自己裁；断言"裁完尺寸 = windowBounds × 缩放" ✓
 *   ④ ★把"它其实是整屏图"这件事也断言下来★（诚实高于好看 ✓）
 *
 * 产物：shots/ 下的 win-*.png|jpg + C:\deepseek\probe-desktopwin.out.txt
 */
'use strict';
const fs = require('fs');
const path = require('path');

const WIN = require('../src/desktopwin');
const MCP = require('../src/mcp');

let pass = 0, fail = 0;
const out = [];
function L(s) { out.push(s); console.log(s); }
function ok(cond, label, extra) {
  if (cond) { pass++; L('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; L('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const GAME = process.argv[2] || 'Arknights';
const NORMAL = process.argv[3] || 'DeepSeek Harness';
/* 本机实测（PowerShell: [System.Windows.Forms.Screen]::PrimaryScreen.Bounds = 1536x864 ✓，
   物理屏 1920x1080 → scaleFactor 1.25 ✓）。
   ★真应用里这三个值是 electron 的 screen.getPrimaryDisplay() 给的 ✓，不是写死的 ✓★ */
const DISP = { w: 1536, h: 864, scaleFactor: 1.25 };
const SPACE = { w: 1920, h: 1080 };
const SHOTS = path.join(process.env.APPDATA || '.', 'dayu-pet', 'shots');

(async () => {
  WIN.install({
    space: () => SPACE,
    display: () => DISP,
    shotDir: () => SHOTS,
  });
  MCP.configure({});

  L('=== probe-desktopwin（按窗口截图 + 数格子 · 真机）===');
  L('服务器：' + JSON.stringify((MCP.servers()['desktop-auto'] || {}).args));

  /* ── ① 普通窗口：证明"裁窗口"这条路真的发生 + 尺寸可断言 ── */
  L('');
  L('① 普通窗口「' + NORMAL + '」');
  let shotNormal = null;
  try {
    shotNormal = await WIN.shotWindow(NORMAL, {});
    L('  windowBounds=' + JSON.stringify(shotNormal.windowBounds) + ' 图=' + shotNormal.w + '×' + shotNormal.h
      + ' 返回的原始图=' + JSON.stringify(shotNormal.imageWH) + ' 裁过=' + !!shotNormal.crop + ' looksFullScreen=' + shotNormal.looksFullScreen);
    const wb = shotNormal.windowBounds || {};
    /* 断言：裁完的图 = 窗口尺寸 × 缩放 ✓（±2px 容差，取整） */
    const wantW = Math.round(wb.width * DISP.scaleFactor), wantH = Math.round(wb.height * DISP.scaleFactor);
    ok(Math.abs(shotNormal.w - wantW) <= 2 && Math.abs(shotNormal.h - wantH) <= 2,
      '★裁出来的窗口图尺寸 = windowBounds × 缩放★', shotNormal.w + '×' + shotNormal.h + ' vs 期望 ' + wantW + '×' + wantH);
    ok(shotNormal.path && fs.existsSync(shotNormal.path), '窗口图落盘了 ✓', shotNormal.path);
  } catch (e) { ok(false, '普通窗口截图', e.message); }

  /* ② 普通窗口上数格子：拿它左侧列表（一列行）测，断言"等距成格" ✓ */
  if (shotNormal) {
    const r2 = await WIN.run('grid_count', shotNormal.path + '|v|60,140,' + Math.max(40, shotNormal.w - 200) + ',700|');
    L('② 普通窗口（DSH 左侧列表）数格子 → 见下面回执');
    L(r2);
    const m = r2.match(/★测到 (\d+) 格★/);
    const n = m ? Number(m[1]) : 0;
    ok(n >= 3, '★普通窗口上也测出了格子列★', 'n=' + n);
    ok(/等距 ✓/.test(r2), '★普通窗口上判定"等距"✓★（不是只有游戏才行 ✓）');
  }

  /* ── ③ 游戏窗口：右侧职业图标列 → 断言 9 格 ── */
  L('');
  L('③ 游戏窗口「' + GAME + '」右侧职业图标列（主人给的顺序表：ALL+8 = 9 项 ✓）');
  const r3 = await WIN.run('grid_count', GAME + '|v|1600,60,320,960|9');
  L(r3);
  const g = r3.match(/★测到 (\d+) 格★/);
  const gn = g ? Number(g[1]) : 0;
  ok(gn === 9, '★★游戏右侧职业列 = 9 格★★', 'n=' + gn);
  ok(/等距 ✓/.test(r3), '★这 9 格是等距的 ✓★');
  ok(/期望 9 格：★扫到可用参数/.test(r3), '★"期望 9 格"这条约束被满足（扫阈值找到了可行参数）★');

  /* ── ④ 诚实断言：机器上的 bot_screenshot 其实是整屏图 ── */
  L('');
  L('④ ★诚实检查：bot_screenshot 到底返回了什么★');
  const s = await WIN.shotWindow(GAME, {});
  L('  窗口 ' + JSON.stringify(s.windowBounds) + '，返回图 ' + JSON.stringify(s.imageWH) + '，裁过=' + !!s.crop);
  ok(!!s.crop || s.imageWH.w > (s.windowBounds ? s.windowBounds.width : 0) + 2,
    '★确认：返回的图比窗口大 → 是"整屏图"✗（我们因此自己裁 ✓）★',
    '图 ' + s.imageWH.w + '×' + s.imageWH.h + ' vs 窗口 ' + (s.windowBounds ? s.windowBounds.width + '×' + s.windowBounds.height : '?'));

  L('');
  L('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.writeFileSync('C:/deepseek/probe-desktopwin.out.txt', out.join('\n'), 'utf8'); } catch (e) {}
  MCP.stopAll();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  L('❌ 探针崩了：' + (e && e.stack || e));
  try { fs.writeFileSync('C:/deepseek/probe-desktopwin.out.txt', out.join('\n'), 'utf8'); } catch (e2) {}
  process.exit(1);
});
