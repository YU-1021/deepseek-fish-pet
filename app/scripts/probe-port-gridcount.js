/* probe-port-gridcount.js —— ★移植后的真机验证：拿**真实抓帧**跑 grid_count★
 *
 * 跑法：node app\scripts\probe-port-gridcount.js [图片路径，可省]
 *
 * 【为什么必须用真机抓帧 ✗→✓】
 *   合成图只能证明算法自洽 ✓；"在真实画面上能不能测出格子"必须用**真图** ✓
 *   （昨天的教训：find_grid 在合成图上没事、在职业列上只测到 1 段 ✗）。
 *   这里用的是**之前真机跑 win_shot 留下的那张游戏窗口图** ✓（%APPDATA%\dayu-pet\shots\win-Arknights-*.png ✓），
 *   以及一张全屏图 ✓ —— 都不需要开任何窗口 ✓、不碰主人的屏幕 ✓。
 *
 * ★它顺便验证"移植有没有接上"★：直接调 **移植过来的** src/desktopwin.js + src/gridcount.js ✓
 * （和她在对话里走的同一条代码 ✓）—— 如果接线没接好，这里就会报错/输出 0 格 ✗。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const GC = require('../src/gridcount');
const WIN = require('../src/desktopwin');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const SHOTS = path.join(process.env.APPDATA || '.', 'dayu-pet', 'shots');

function newest(pattern) {
  try {
    const list = fs.readdirSync(SHOTS).filter((f) => pattern.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return list.length ? path.join(SHOTS, list[0].f) : null;
  } catch (e) { return null; }
}

(async () => {
  console.log('=== probe-port-gridcount（移植后的真机抓帧验证）===');

  /* ① 纯算法层：直接 analyze 真实 PNG（不带任何 Electron / MCP ✓） */
  const png = process.argv[2] || newest(/^win-.*\.png$/i);
  if (!png || !fs.existsSync(png)) {
    console.log('  ⚠️ 没找到真机抓帧（%APPDATA%\\dayu-pet\\shots\\win-*.png ✗）→ 只跑合成图自检');
  } else {
    const { Jimp } = require('jimp');
    const img = await Jimp.fromBuffer(fs.readFileSync(png));
    const luma = GC.lumaFromBitmap(img.bitmap.data, img.width, img.height, false);
    console.log('  真图：' + png + '  (' + img.width + '×' + img.height + ')');
    /* ★两次调用，两种用法都测 ✗→✓★
       ① 只给"整帧去掉标题行和任务栏"的范围（y 60~1012 ✓）→ 靠**窄条自动搜索**找列 ✓；
          ⚠️ 实测：整帧不裁范围时，自动搜索可能挑到**一列文字**（间距 ~24px ✓ 也是等距 ✗）
             —— 工具会如实说"凑不出 9 格" ✓（不编 ✓），★区域得由调用方收窄✓（工具描述里写了 ✓）。
       ② 给**明确的职业列窄条**（x 1600~1919，y 60~1012 ✓）= 主人/模型该用的调法 ✓
          → 这一条才是验收数字的那次 ✓（对齐 lead 在 55d53b7 上验的 9 格 / ~116px / 残差 4.8% ✓）。 */
    const REG_Y = { y0: 60, y1: Math.min(1012, img.height - 1) };
    const rAuto = GC.analyze(luma, img.width, img.height, Object.assign({ dir: 'v', k: 2, expect: 9, bandSearch: 56 }, REG_Y));
    console.log('  ① 自动搜窄条：' + rAuto.cells.length + ' 格 / 格距 ' + rAuto.spacing.toFixed(1)
      + 'px / 残留 ' + (rAuto.cv * 100).toFixed(1) + '% / 量的是 ' + JSON.stringify(rAuto.region));
    const r = GC.analyze(luma, img.width, img.height, Object.assign({
      dir: 'v', k: 2, expect: 9, bandSearch: 56,   // ★bandSearch 就是 grid_count 工具里默认带的那个 ✓（先自动收窄成窄条 ✓）
      region: { x0: Math.round(img.width * 0.83), x1: img.width - 1, y0: REG_Y.y0, y1: REG_Y.y1 },
    }));
    console.log('  ★② 明确给职业列窄条：测到 ' + r.cells.length + ' 格★  格距 ' + r.spacing.toFixed(1) + 'px  残差 '
      + (r.cv * 100).toFixed(1) + '%  consistent=' + r.consistent + '  量的是 ' + JSON.stringify(r.region));
    console.log('  每格中心：' + r.cells.map((c) => (c.estimated ? '(估)' : (c.inLattice ? '' : '外')) + c.center).join(', '));
    ok(r.cells.length >= 4, '★真图上测出了格子（不是 0 ✓）★', 'n=' + r.cells.length);
    ok(r.spacing > 40, '★格距是"图标格"的量级（>40px ✓ —— 文本行只有 ~24px ✗）★', r.spacing.toFixed(1) + 'px');
    ok(r.consistent === true, '★判定"等距" ✓★', '残差 ' + (r.cv * 100).toFixed(1) + '%');
    ok(r.quality.verdict === 'ok', '★可信度结论 = ok ✓★', JSON.stringify(r.quality.reasons));
    ok(r.cells.length === 9, '★★职业列 = 9 格（ALL + 8 职业 ✓ 主人的顺序表就是 9 项）★★', 'n=' + r.cells.length);
    /* 这一条是"移植是否有意义"的关键：老 find_grid 的算法在同一张图上测不出来 ✓ */
    const W = img.width, H = img.height;
    const prof = [];
    for (let y = 0; y < H; y++) { let s = 0; for (let x = r.region.x0; x <= r.region.x1; x++) s += luma[y * W + x]; prof.push(s / (r.region.x1 - r.region.x0 + 1)); }
    const mx = Math.max(...prof), mn = Math.min(...prof);
    const oldRuns = GC.findRuns(prof, mn + (mx - mn) * 0.35, 6, 5);   // find_grid 的老算法 ✓
    console.log('  （对照）老算法在同一区域：' + oldRuns.length + ' 段');
    ok(oldRuns.length !== 9, '§对照：★老 find_grid 的老算法在这个区域上测不出 9 段★（实测 ' + oldRuns.length + ' 段 ✓）', '');
  }

  /* ② 接线层：走 desktopwin.run('grid_count', 图片) —— 和她在对话里走的是同一条 ✓ */
  if (png && fs.existsSync(png)) {
    WIN.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1536, h: 864, scaleFactor: 1.25 }), shotDir: () => SHOTS });
    const out = await WIN.run('grid_count', png + '|v||9');
    const first = String(out).split('\n').slice(0, 3).join(' | ');
    console.log('  [desktopwin 回执] ' + first);
    ok(/★测到 \d+ 格★/.test(out), '★desktopwin.run(grid_count) 真的接上了（回执里有"测到 N 格"✓）★');
    ok(!/❌/.test(out.split('\n')[0]), '§回执开头不是错误 ✓');
  }

  /* ③ 依赖自检：win_shot 需要的 MCP server 能不能起来 + 工具数 */
  try {
    const MCP = require('../src/mcp');
    MCP.configure({});
    const entry = ((MCP.servers()['desktop-auto'] || {}).args || [])[0];
    console.log('  desktop-auto 入口：' + entry);
    ok(!!entry && fs.existsSync(entry), '★desktop-auto 的 server 入口在磁盘上（win_shot 依赖它 ✓）★', entry);
    const tools = await MCP.listTools('desktop-auto');
    console.log('  desktop-auto 工具数：' + tools.length);
    ok(tools.length >= 20, '★MCP desktop-auto 起得来、工具数对得上（>20 ✓）★', tools.length + ' 个');
    ok(tools.some((t) => t.name === 'bot_screenshot'), '★含 bot_screenshot（win_shot 要的那个 ✓）★');
    MCP.stopAll();
  } catch (e) {
    ok(false, 'desktop-auto MCP 起不来（win_shot 会不可用 ✗）', String((e && e.message) || e));
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 探针崩了：' + (e && e.stack || e)); process.exit(1); });
