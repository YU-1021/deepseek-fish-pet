/* probe-clickenv.js —— ★A/B 两条的真机验证探针★（2026-10-10）
 *
 * 跑法（在桌宠空闲时；必须先清掉 ELECTRON_RUN_AS_NODE，否则退化成纯 node）：
 *   cd C:\deepseek\desktop-pet\app
 *   Remove-Item env:ELECTRON_RUN_AS_NODE
 *   node_modules\electron\dist\electron.exe app\scripts\probe-clickenv.js
 *
 * 它在验什么：
 *   A. 点击前的环境检查：目标点上压着谁 / 亮像素比例 / 是不是自己的窗（真机窗口列表 + 真抓帧）
 *   B. 失败回执：必须以 ❌ 开头，且原因是**细分后**的那几种（被挡 / 越界 / 主人在用鼠标）
 *
 * 安全边界（铁律）：
 *   · ★不开可见窗口★：不 new 可见 BrowserWindow、不 openDevTools、跑完 process.exit(0)
 *     （抓帧走 screenstream，它自己的窗口是 show:false）
 *   · 只做**一次**真实点击，落点是"环境检查判定为干净"的那一点（默认 1860,662 —— 游戏右边缘那一列）；
 *     其余全部在"检查就拦下来"的路径上，一次点击都不会发出去（断言 out.result 不存在）
 *   · 用**独立 userData**（拷一份 config），不写脏主人真实的数据
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const APP = path.join(__dirname, '..');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const TMP = 'C:/deepseek/tmp-clickenv';
fs.mkdirSync(TMP, { recursive: true });
try { fs.copyFileSync(path.join(REAL, 'config.json'), path.join(TMP, 'config.json')); } catch (e) {}
app.setPath('userData', TMP);
/* 探针自己管生命周期（默认"最后一个窗口关掉就退出"会让收尾没跑完进程就没了） */
app.on('window-all-closed', function () { });

const out = [];
function L(s) { out.push(String(s)); try { process.stdout.write(String(s) + '\n'); } catch (e) {} }
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; L('  [PASS] ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; L('  [FAIL] ' + label + (extra ? '   ' + extra : '')); }
}
function info(label, extra) { L('  [INFO] ' + label + (extra ? '   ' + extra : '')); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* --noreal：跳过 §7 那一次真实点击（先跑一遍确认其它都过，再跑完整版） */
const NOREAL = process.argv.indexOf('--noreal') >= 0;

/* 抓一帧 BGRA（和 assistant.grabBgraForEnvCheck 同一条路：屏幕流优先，回退 desktopCapturer）。
   ⚠️ 不写盘、不画准星 —— 别让我们自己画的东西影响"这一块亮不亮"。 */
async function grab() {
  try {
    const ss = require(path.join(APP, 'src', 'screenstream'));
    const f = await ss.grabFrame({ grid: false, noCursor: true });
    if (f && f.dataUrl) {
      const img = nativeImage.createFromDataURL(f.dataUrl);
      const s = img.getSize();
      if (s.width && s.height) return { bgra: img.toBitmap(), w: s.width, h: s.height, src: 'stream' };
    }
  } catch (e) { info('屏幕流抓帧失败：' + ((e && e.message) || e)); }
  return null;
}

async function main() {
  const fw = require(path.join(APP, 'src', 'focuswin'));
  const EC = require(path.join(APP, 'src', 'envcheck'));
  const SD = require(path.join(APP, 'src', 'safedrive'));
  const input = require(path.join(APP, 'src', 'input'));
  const assistant = require(path.join(APP, 'src', 'assistant'));
  const ui = require(path.join(APP, 'src', 'userinput'));
  const space = input.space();
  const ENV = { selfPids: [process.pid], grab, spaceW: space.w, spaceH: space.h, screenW: space.w, screenH: space.h };

  L('=== probe-clickenv（A 环境检查 / B 失败回执）===');
  info('坐标空间 ' + space.w + 'x' + space.h);
  L('');

  /* ---------------- §0 真机窗口现场 ---------------- */
  L('§0 真机窗口现场（这是判据的原料）');
  const l0 = await fw.listWindows();
  info('listWindows ok=' + l0.ok + ' dpi=' + l0.dpi + ' 前台=' + l0.foregroundTitle);
  const PTS = [[100, 600], [1860, 662]];
  for (const p of PTS) {
    const st = EC.stackAt(p[0], p[1], l0.windows, {});
    info('点 (' + p[0] + ',' + p[1] + ') 上按 z 序：' + (st.length ? st.map((w) => w.title.slice(0, 22) + '(z' + w.z + ')').join(' > ') : '(没有可见窗口)'));
  }
  L('');

  /* ---------------- §1 纯判定（假数据，确定性） ---------------- */
  L('§1 decide() 纯判定（注入假窗口，覆盖飞框/自己的窗/干净三种）');
  const GAME = { title: '明日方舟', x: 0, y: 0, w: 1920, h: 1080, hwnd: 1, pid: 111, z: 13, visible: true, iconic: false, cloaked: false, topmost: false };
  const CAL = { title: '日历', x: 1560, y: 400, w: 350, h: 420, hwnd: 2, pid: 222, z: 1, visible: true, iconic: false, cloaked: false, topmost: true };
  const PET = { title: '大肥鱼 · 对话', x: 100, y: 500, w: 500, h: 400, hwnd: 3, pid: 333, z: 2, visible: true, iconic: false, cloaked: false, topmost: true };
  const CLOAKED = { title: 'Windows 输入体验', x: 0, y: 0, w: 1920, h: 1080, hwnd: 4, pid: 444, z: 5, visible: true, iconic: false, cloaked: true, topmost: false };
  const r1 = EC.decide(1860, 662, [GAME, CLOAKED], { screenW: 1920, screenH: 1080 });
  ok(r1.blocked === false && r1.top && r1.top.title === '明日方舟', '§1 只有游戏（+ 一个 cloaked 幽灵窗）→ 放行', 'top=' + (r1.top && r1.top.title));
  const r2 = EC.decide(1860, 662, [CAL, GAME], { screenW: 1920, screenH: 1080 });
  ok(r2.blocked === true && r2.reason === 'target-covered-by-flyout', '§1 ★日历飞框压在小面板之上 → 拦住★', r2.reason || '');
  const r3 = EC.decide(200, 600, [PET, GAME], { screenW: 1920, screenH: 1080 });
  ok(r3.blocked === true && r3.reason === 'target-under-own-window', '§1 ★自己的桌宠窗压着 → 拦住★', r3.reason || '');
  const r4 = EC.decide(960, 540, [CLOAKED, GAME], { screenW: 1920, screenH: 1080 });
  ok(r4.blocked === false, '§1 ★全屏但 cloaked 的幽灵窗不算遮挡者★（不然谁都点不了）', 'top=' + (r4.top && r4.top.title));
  const r5 = EC.decide(960, 1060, [GAME], { screenW: 1920, screenH: 1080, taskbarTop: 1030 });
  ok(r5.blocked === true && r5.reason === 'point-on-taskbar', '§1 ★任务栏那一条 → 拦住（点它会弹日历飞框）★', String(r5.reason));
  L('');

  /* ---------------- §2 真机：被 DSH 窗压着的点 ---------------- */
  L('§2 真机：点 (100,600)（现在正是 DSH 窗口的地盘）');
  const e2 = await EC.checkPoint(100, 600, ENV);
  info('checkPoint: blocked=' + e2.blocked + ' reason=' + e2.reason + ' top=' + (e2.top && e2.top.title));
  ok(e2.blocked === true, '§2 ★有窗口压着 → 拦住★', String(e2.reason));
  ok(e2.top && (e2.reason === 'target-under-own-window' || e2.reason === 'target-covered-by-flyout'), '§2 ★能说出是谁挡着★', JSON.stringify(e2.top));
  ok(!(e2.bright), '§2 被窗口拦住时不再白抓一帧（bright=' + JSON.stringify(e2.bright) + '）');
  L('');

  /* ---------------- §3 真机：干净的点 + 亮像素比例 ---------------- */
  L('§3 真机：点 (1860,662)（游戏右边缘那一列）');
  const e3 = await EC.checkPoint(1860, 662, ENV);
  info('checkPoint: blocked=' + e3.blocked + ' top=' + (e3.top && e3.top.title)
    + ' bright=' + (e3.bright ? (e3.bright.ratio * 100).toFixed(1) + '%(' + e3.bright.region.w + 'x' + e3.bright.region.h + ')' : '没算出来'));
  ok(e3.blocked === false, '§3 ★干净的点 → 放行★', 'top=' + (e3.top && e3.top.title));
  ok(!!(e3.bright && e3.bright.ratio < 0.20), '§3 ★这一块亮像素比例正常（<20%）★',
    e3.bright ? (e3.bright.ratio * 100).toFixed(1) + '%' : 'null');
  /* 亮像素比例能不能真的抓到浅色面板？拿同一帧在两个不同区域对比 —— 证明这个特征不是常数 */
  const fr = await grab();
  if (fr) {
    const dark = EC.brightRatio(fr.bgra, fr.w, fr.h, EC.regionAround(1860, 662, fr.w, fr.h, space.w, space.h, 60));
    const whole = EC.brightRatio(fr.bgra, fr.w, fr.h, { x: 0, y: 0, w: fr.w, h: fr.h });
    info('同一帧：目标点周围 60x60 亮比例 ' + (dark.ratio * 100).toFixed(1) + '%，整屏平均 ' + (whole.ratio * 100).toFixed(1) + '%');
    ok(dark.ratio !== whole.ratio, '§3 亮像素比例是**局部**特征（不是整屏常数）');
  } else { ok(false, '§3 抓帧（注意：抓不到就没法量亮比例）'); }
  L('');

  /* ---------------- §4 真机：clickSafe 被拦时一次点击都不发 ----------------
     ⚠️ 2026-10-11：被拦时 clickSafe 现在**默认抛错**（这样上层那条链才会写 ❌ 而不是假 ✅ ✓）
     —— 探针要看结构体，所以传 softBlock:true ✓；同时验默认那条会抛 ✓ */
  L('§4 真机：clickSafe(100,600) —— 拦下来，而且★一次点击都没发★');
  let threw = null;
  try { await SD.clickSafe(100, 600, Object.assign({ kind: 'click' }, { envCheck: ENV })); }
  catch (e) { threw = e; }
  ok(!!threw && threw.blocked === true && String(threw.message).charAt(0) === '❌',
    '§4 ★被拦时默认抛错，消息以 ❌ 开头★（上层就会写成失败而不是假成功）',
    threw ? String(threw.message).slice(0, 60) : '没抛');
  const c4 = await SD.clickSafe(100, 600, Object.assign({ kind: 'click' }, { envCheck: ENV, softBlock: true }));
  info('clickSafe(softBlock): ok=' + c4.ok + ' blocked=' + c4.blocked + ' reason=' + c4.reason + ' 有 result 字段=' + ('result' in c4));
  ok(c4.ok === false && c4.blocked === true, '§4 ★拒绝点击★', String(c4.reason));
  ok(!('result' in c4), '§4 ★input.click 压根没被调用（没有 result 字段 = 没发出去）★');
  L('');

  /* ---------------- §4b 真机：任务栏（今天的头号坑） ---------------- */
  L('§4b 真机：任务栏那一带（y≈1040~1080）—— 点它就会弹日历飞框');
  let tbTop = null;
  try {
    const d = require('electron').screen.getPrimaryDisplay();
    tbTop = EC.taskbarTopOf(d, space.h);
    info('工作区 ' + d.workAreaSize.width + 'x' + d.workAreaSize.height + ' 屏幕 ' + d.size.width + 'x' + d.size.height
      + ' → 任务栏上边缘（坐标空间 y）≈ ' + tbTop);
  } catch (e) { info('算任务栏上边缘失败：' + ((e && e.message) || e)); }
  ok(tbTop != null && tbTop > 900 && tbTop < space.h, '§4b 真机算出了任务栏上边缘', 'taskbarTop=' + tbTop);
  const eTb = await EC.checkPoint(960, tbTop + 8, Object.assign({}, ENV, { taskbarTop: tbTop }));
  info('checkPoint(960,' + (tbTop + 8) + '): blocked=' + eTb.blocked + ' reason=' + eTb.reason);
  ok(eTb.blocked === true && eTb.reason === 'point-on-taskbar', '§4b ★任务栏上的点 → 拦住★', String(eTb.reason));
  const repTb = await assistant.run('click', '960,' + (tbTop + 8));
  L('  [回执] ' + String(repTb).split('\n')[0].slice(0, 130));
  ok(String(repTb).charAt(0) === '❌' && /任务栏/.test(String(repTb)), '§4b ★回执说清"那是任务栏、点了会弹日历"★（一次点击都没发）');
  L('');

  L('§5 真机：assistant.run(click) 的回执文案（B 条）');
  const rep5 = await assistant.run('click', '100,600');
  L('  [回执] ' + String(rep5).split('\n')[0].slice(0, 140));
  ok(String(rep5).charAt(0) === '❌', '§5 ★回执以 ❌ 开头★（她的循环就按这个判失败）', String(rep5).slice(0, 12));
  ok(/被挡|压着|自己的|挡住/.test(String(rep5)), '§5 ★回执说清了"被谁挡着"★');
  const rep6 = await assistant.run('click', '5000,3000');
  L('  [回执] ' + String(rep6).split('\n')[0].slice(0, 140));
  ok(String(rep6).charAt(0) === '❌' && /越界/.test(String(rep6)), '§5 ★越界坐标 → ❌ + "坐标越界"（细分后的原因）★');
  L('');

  /* ---------------- §6 真机：主人在用鼠标（故障注入，不真点） ---------------- */
  L('§6 真机：主人在用鼠标 → 回执必须说"我在等他停"（★不点★）');
  let seq = 0;
  ui.setParams({ enabled: true, pollMs: 20, movePx: 2, calmMs: 6000, expectPx: 5 });
  ui.setCursorSource(function () { seq += 40; return { x: 300 + seq, y: 300 }; });
  ui.notePetMove(1, 1);            // 启动轮询（她自己动了一下）
  await wait(250);                 // 假装的"主人"在动 → lastUserAt 被刷新
  info('userinput: userActive=' + ui.isUserActive() + ' msSinceUser=' + ui.state().msSinceUser);
  ok(ui.isUserActive() === true, '§6 前置：故障注入让 isUserActive=true');
  const rep7 = await assistant.run('click', '1860,662');
  L('  [回执] ' + String(rep7).split('\n')[0].slice(0, 140));
  ok(String(rep7).charAt(0) === '❌', '§6 ★主人占用鼠标 → 回执以 ❌ 开头★');
  ok(/主人正在操作鼠标|让位/.test(String(rep7)), '§6 ★回执说清了是"主人在用鼠标，我等他停"★');
  ok(!/✅/.test(String(rep7)), '§6 ★没有假装成功★（哪怕目标坐标完全合法）');
  ui.setCursorSource(null);
  /* 收尾：让"主人"停手（calmMs 调到 200ms 等一小下）—— 不然后面 §7 会一直被"让位"挡住 */
  ui.setParams({ enabled: true, calmMs: 200 });
  await wait(450);
  ok(ui.isUserActive() === false, '§6 收尾：主人停手 → 让位解除（下一步才能真点）');
  L('');

  /* ---------------- §7 真机：干净的点真的点下去 ---------------- */
  L('§7 真机：干净的点 → 真的点（唯一一次真实点击）');
  if (NOREAL) {
    info('--noreal：跳过真实点击（只验证前面那些"拦下来"的路径）');
  } else {
  const rep8 = await assistant.run('click', '1860,662');
  L('  [回执] ' + String(rep8).split('\n')[0].slice(0, 200));
  ok(String(rep8).charAt(0) === '✅', '§7 ★干净的点 → ✅ 正常点下去★', String(rep8).slice(0, 12));
  ok(/光标已确认到达/.test(String(rep8)), '§7 ★并且确实确认了光标到位（不是假成功）★');
  ok(/环境已查/.test(String(rep8)), '§7 ★成功回执里带上了"环境干净"★');
  }
  /* 真实点击可能把游戏切到前台、盖住主人正在看的 DSH 窗口 —— 收尾把它放回去（别改主人的现场） */
  try {
    const fx = await fw.focusWindowEx('DeepSeek Harness');
    info('收尾：把 DSH 窗口放回前台 ok=' + fx.ok + ' step=' + fx.step + ' 回读前台=' + fx.foreground);
  } catch (e) { info('收尾置前失败：' + ((e && e.message) || e)); }
  L('');

  L('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.writeFileSync('C:/deepseek/probe-clickenv.out.txt', out.join('\n'), 'utf8'); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

app.whenReady().then(() => {
  main().catch((e) => {
    L('探针崩了：' + ((e && e.stack) || e));
    try { fs.writeFileSync('C:/deepseek/probe-clickenv.out.txt', out.join('\n'), 'utf8'); } catch (e2) {}
    process.exit(2);
  });
});
