/* probe-stop.js —— ★真机验证「停止」：真的停住了吗★（离屏渲染，不开可见窗口 ✓）
 *
 * 跑法：node_modules\electron\dist\electron.exe app\scripts\probe-stop.js
 *   （先 Remove-Item env:ELECTRON_RUN_AS_NODE）
 *
 * 【为什么这样验，而不是"跑个真任务点一下"✗】
 *   真任务要花主人的 token ✓、还会真动鼠标 ✗（现在屏幕上就是他正在用的 DSH 窗口和游戏 ✓）。
 *   所以这里用**离屏窗口 + 桩主进程** ✓：被验证的代码是 ★真实的 chat.html + chat.js + loop.js★ ✓
 *   （她跑任务时用的那一份，一字未改 ✓），桩只负责"当主进程"（照 main.js 的契约 ✓）。
 *
 * 【要证明的四件事（主人要的"真的停"✗→✓）】
 *   ① 点「⏹ 停止」→ ★后面不再执行任何动作★ ✓（用 assistantRun 的调用次数当**可数证据**✓）；
 *   ② ★停止原因如实落盘 = interrupted★ ✓（renderer 的 reportTask → statsTask 里能看到 ✓）；
 *   ③ 界面上看得见"已停止"✓（按钮文字/聊天窗里那一行 ✓）；不是"打印一句停了"✗；
 *   ④ ★反向对照★：不点停止时这条链**确实会一直跑**✓ ——
 *      不然"它停了"可能只是因为链本来就跑完了 ✗（没有对照组的实验不算实验 ✓）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
const log = [];
function L(s) { log.push(s); console.log(s); }
function ok(cond, label, extra) {
  if (cond) { pass++; L('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; L('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const OUT = 'C:/deepseek/probe-stop.out.txt';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 460, height: 800, show: false,          /* ★show:false：绝不弹窗 ✓（铁律 5）★ */
    webPreferences: {
      contextIsolation: false,                     /* 让 executeJavaScript 能碰到 send/$ ✓ */
      nodeIntegration: false,
      preload: path.join(__dirname, 'stub-stop-preload.js'),
    },
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2 && !/Security Warning|Content-Security-Policy|Autofill/.test(String(msg))) errs.push(String(msg).slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, d) => errs.push('RENDER GONE ' + JSON.stringify(d)));

  const js = (code) => win.webContents.executeJavaScript(code);
  const probe = () => js('window.__probe ? ({stopped:__probe.stopped,runs:__probe.runs,stopReqs:__probe.stopReqs,tasks:__probe.tasks,continues:__probe.continues}) : null');

  win.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(1200);
      L('=== probe-stop（停止：真的停住了吗）===');
      L('① 先跑一个**会一直继续**的多步任务（不点停止 → 应该看到它反复执行 ✓）');
      await js(`document.getElementById('input').value='帮我一步一步点那个按钮'; document.getElementById('send').click(); true;`);
      await sleep(1400);
      const mid = await probe();
      L('   1.4s 时：assistantRun 已执行 ' + (mid ? mid.runs : '?') + ' 次，chatContinue ' + (mid ? mid.continues : '?') + ' 次');
      ok(!!mid && mid.runs >= 2, '★对照组：不点停止时这条链**真的在继续**（steps ≥ 2）★', 'runs=' + (mid && mid.runs));

      L('② ★现在点界面上的「⏹ 停止」按钮（不是调内部函数 ✓ 真点 ✓）★');
      const btnText = await js(`(function(){var b=document.getElementById('stop'); if(!b) return '(没有停止按钮!)'; b.click(); return b.textContent; })()`);
      L('   按钮点完的即时文字：' + JSON.stringify(btnText));
      ok(/停止/.test(String(btnText)), '★界面上确实有「停止」按钮，而且点得到★', btnText);
      const atStop = await probe();
      const runsAtStop = atStop ? atStop.runs : -1;
      L('   停止时 assistantRun 次数 = ' + runsAtStop + '，停止请求 = ' + JSON.stringify(atStop && atStop.stopReqs));

      /* 停止后给它充足的时间（4 秒 > 4 个动作的时长 ✓）：次数必须不再增长 ✓ */
      await sleep(4000);
      const after = await probe();
      L('   4s 后 assistantRun 次数 = ' + (after && after.runs) + '（停止时是 ' + runsAtStop + '）');
      const growth = (after ? after.runs : 0) - runsAtStop;
      /* 点击那一刻可能已经有一个动作在飞 ✓ —— 允许**最多 1 个**（停止前就派出去的 ✓），
         之后必须彻底安静 ✓（这是"真的停"和"看起来停了"的分界线 ✓） */
      ok(growth <= 1, '★★停止之后不再派发新动作（最多 1 个"已经在飞"的）★★', '增长 ' + growth + ' 次');
      const runsAfterStop = after ? after.runs : 0;
      await sleep(1500);
      const after2 = await probe();
      ok(after2 && after2.runs === runsAfterStop, '★★停止 5.5s 后彻底安静：动作数一动不动 ★★',
        runsAfterStop + ' → ' + (after2 && after2.runs));

      L('③ 停止原因有没有如实落盘（renderer 会 reportTask → statsTask ✓）');
      const tasks = (after2 && after2.tasks) || [];
      const reasons = tasks.map((t) => t.stopReason);
      L('   statsTask 收到的停止原因：' + JSON.stringify(reasons));
      ok(reasons.indexOf('interrupted') >= 0, '★★停止原因 = interrupted（真的落盘了）★★', JSON.stringify(reasons));
      const state = await js('window.__petStopState ? window.__petStopState() : null');
      ok(!!state && state.taskStopReason === 'interrupted', '★renderer 侧的原因也是 interrupted ✓', JSON.stringify(state));

      L('④ 界面上看得见"已停止"（不是只 print 一句 ✗）');
      const msgs = await js(`Array.from(document.querySelectorAll('#msgs .msg')).map(function(e){return e.textContent;}).filter(function(t){return t.indexOf('停')>=0;}).slice(-3)`);
      L('   聊天窗里含"停"的最近几条：' + JSON.stringify(msgs));
      ok(msgs.some((m) => /不会再执行|已停止/.test(m)), '★聊天窗里有一行明确的"已停止/不会再执行"★', msgs.join(' | ').slice(0, 120));

      L('⑤ 反向保险：停止之后 main 侧的闸门也不放行（桩里按 main.js 同语义实现 ✓）');
      const blocked = await js('window.petAPI.assistantRun({tool:"click",arg:"1,1"})');
      L('   停止后再调 assistantRun → ' + JSON.stringify(blocked));
      ok(!!blocked && blocked.stopped === true, '★停止后动作被主进程侧闸门拒绝（stopped:true）★', JSON.stringify(blocked));

      L('');
      L('JS 报错：' + (errs.length ? errs.join(' || ') : '（无）'));
      ok(errs.length === 0, '渲染层没有 JS 报错（历史上改渲染层把聊天窗弄白过 ✗）');
      L('');
      L('通过 ' + pass + ' / ' + (pass + fail));
      fs.writeFileSync(OUT, log.join('\n'), 'utf8');
      app.exit(fail ? 1 : 0);
    } catch (e) {
      L('❌ 探针崩了：' + (e && e.stack || e));
      fs.writeFileSync(OUT, log.join('\n'), 'utf8');
      app.exit(1);
    }
  });
});
