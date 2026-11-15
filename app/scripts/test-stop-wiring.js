/* test-stop-wiring.js —— ★「停止」这条链的**契约检查**（纯 Node）★
 *
 * 跑法：node app/scripts/test-stop-wiring.js
 *
 * ⚠️ ★诚实标注：这是**静态契约 + 纯逻辑**检查，不是真机点击★ ✗→✓
 *   "点一下真的停"由 app/scripts/probe-stop.js（离屏 + 真实 chat.js/loop.js）真机验证 ✓；
 *   主进程那半边（全局快捷键 / requestStop / assistant:run 闸门）**没法在主人的桌宠正在跑的时候**验 ✗
 *   （single-instance 锁 ✓，而且拉起来会弹可见窗口 ✗ —— 主人被弹窗烦过 ✓）。
 *   → 所以这一支做三件**能做的**事：
 *     ① 纯逻辑：`interrupted` 在 loop 与 stoplog 两张表里、且能被记下来（含 via ✓）；
 *     ② 静态契约：main/preload/renderer/chat.html/chat.css 里那几处**必须存在**的接线 ✓
 *        （少一处就是"按了没反应"或"记不成 interrupted" ✗ —— 今天两类都踩过 ✓）；
 *     ③ 明确列出**没验到**的那一条 ✓（不假装 ✓）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
function src(rel) { return fs.readFileSync(path.join(APP, rel), 'utf8'); }
function has(s, needle) { return s.indexOf(needle) >= 0; }

console.log('=== test-stop-wiring（停止：契约检查）===');

/* §1 纯逻辑：interrupted 是登记在册的原因，而且"是谁停的"会一起记下来 */
{
  const loop = require('../renderer/loop');
  const stoplog = require('../src/stoplog');
  ok(loop.REASONS.indexOf('interrupted') >= 0, '§1 loop.REASONS 含 interrupted', loop.REASONS.join('/'));
  ok(stoplog.KNOWN.indexOf('interrupted') >= 0, '§1 stoplog.KNOWN 含 interrupted');
  ok(loop.REASONS.slice().sort().join(',') === stoplog.KNOWN.slice().sort().join(','),
    '★§1 两张表是同一套（不然会记成 unknownReason ✗）★');
  const r = stoplog.noteStop({ stopReason: 'interrupted', via: '快捷键 Control+Alt+S', ok: false });
  ok(r.ok && r.wrote && r.known === true, '★§1 interrupted 能被记下来且算已知原因★', JSON.stringify(r.rec));
  ok(r.rec && r.rec.via === '快捷键 Control+Alt+S', '★§1 "是谁停的"（via）一起记下来了★', JSON.stringify(r.rec));
  const c = loop.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: [] });
  c.start();
  ok(c.finish('interrupted').reason === 'interrupted' && c.finish('completed').reason === 'interrupted',
    '★§1 原因一旦定下来就冻结（不会被后面的 completed 翻回去 ✗）★');
}

/* §2 静态契约：主进程那半边 */
{
  const m = src('main.js');
  ok(has(m, 'globalShortcut'), '§2 main.js 引入了 globalShortcut');
  ok(has(m, 'globalShortcut.register(') && has(m, 'requestStop('), '★§2 全局快捷键真的注册了，而且进的是同一个 requestStop★');
  ok(has(m, "globalShortcut.unregisterAll()"), '★§2 退出时摘掉快捷键（不然热重载几次就被自己占着 ✗ = 按停没反应 ✓）★');
  ok(has(m, 'const stopGen = 0') || has(m, 'let stopGen = 0'), '§2 停止代数（stopGen）存在 —— 相当于 abortSignal ✓');
  ok(/stopState\.stopped = true/.test(m), '§2 requestStop 会真的把闸门关上');
  ok(has(m, "noteStop({ stopReason: 'interrupted'"), '★§2 停止原因 interrupted 真的落盘（照 DSH 的 turn/end）★');
  ok(has(m, "ipcMain.on('task:stop'"), '§2 界面按钮那条 IPC 在');
  ok(has(m, 'if (stopState.stopped) {\n    try { dbg'), '★§2 assistant:run 开头有停止闸门（最后一道门 ✓）★');
  const iGuard = m.indexOf('if (stopState.stopped)');
  const iRun = m.indexOf('r = await assistant.run(');
  ok(iGuard > 0 && iRun > iGuard, '★§2 闸门在 assistant.run 之前（顺序错了等于没拦 ✗）★', 'guard@' + iGuard + ' < run@' + iRun);
  ok(/chat:continue[\s\S]{0,400}if \(stopState\.stopped\)/.test(m), '★§2 chat:continue 也拦了（停了就不再花 token 问下一步 ✓）★');
  ok(/STOP_RE_MAIN\.test\(text\)[\s\S]{0,200}requestStop\('聊天里喊停'\)/.test(m), '§2 聊天里的"停"也走同一条 requestStop ✓');
  ok(/else if \(stopState\.stopped\)[\s\S]{0,200}stopState\.stopped = false/.test(m), '★§2 主人**新指令**才解除停止（不然会永久哑 ✗）★');
  ok(has(m, 'requestStopForTest') && has(m, 'stopStateForTest'), '§2 给探针留了真入口 ✓');
}

/* §3 静态契约：preload / renderer / 界面 */
{
  const p = src('preload.js');
  ok(has(p, "ipcRenderer.send('task:stop'") && has(p, "'task:stop', (_e, d)"), '★§3 preload 双向都暴露了（发出去 + 收回来）★');
  const c = src('renderer/chat.js');
  ok(has(c, "getElementById('stop')") || has(c, "$('stop')"), '§3 chat.js 拿到了停止按钮');
  ok(has(c, "btn.addEventListener('click'"), '★§3 按钮的点击真的接了（只加不改地挂在末尾 ✓）★');
  ok(has(c, "LOOP.finish('interrupted'"), '★★§3 停止时冻结原因是 interrupted（不是 aborted ✗、不是 completed ✗）★★');
  ok(has(c, 'taskGen++'), '★§3 复用已有的 taskGen 代际号（不新造机制 ✓）★');
  ok(has(c, "window.petAPI.onTaskStop"), '★§3 快捷键/聊天喊停那条事件也接了（跨窗口能停 ✓）★');
  ok(has(c, "document.querySelectorAll('.actionbar')"), '§3 停止时清掉还没批准的动作条 ✓');
  const h = src('renderer/chat.html');
  ok(/id="stop"/.test(h), '§3 chat.html 里有可见的停止按钮');
  ok(/Ctrl\+Alt\+S/.test(h), '§3 按钮的 title 告诉了主人快捷键是什么 ✓');
  const css = src('renderer/chat.css');
  ok(has(css, 'button.stopbtn'), '§3 停止按钮的样式在（不是裸按钮 ✓）');
}

/* §4 ★「任务期结束」这次真机 bug 的接线检查★（2026-10-10）
   真机现场：她「想 + 说话」的 ~17 秒被"15s 没有屏幕动作"误判成任务结束 ✗ → 剩下 5 格没点 ✓。
   ★这一节把"修复所依赖的每一根线"钉住★ —— 少一根，那个 bug 就会以别的形状回来 ✓：
     ① 判定逻辑在**可单测的纯模块**里（src/taskperiod.js ✓；真正的行为由 test-taskperiod.js 钉 ✓）；
     ② "她在推进"的所有来源都打了点（工具开始/结束 ✓、她发言/朗读 ✓、步骤流水 ✓、主人说话 ✓）；
     ③ "循环还在跑"这个信号真的接上了（chat:send / chat:continue 的"有没有下一行动作" ✓）；
     ④ 循环结束 / 被停止 → 立刻还回对话窗 ✓；
     ⑤ ★老的 15 秒硬编码必须**真的没了**✗★（不是"改了个默认值"✓，是判定不再只看屏幕动作 ✓）。 */
{
  const m = src('main.js');
  ok(has(m, "require('./src/taskperiod')"), '★§4 判定接到纯模块 src/taskperiod.js（可单测 ✓）★');
  ok(has(m, 'markToolStart(') && has(m, 'markToolEnd('), '★§4 工具有开始/结束两次打点（"在跑"才能被挡住 ✓）★');
  ok(/function markChatActivity\(/.test(m) && /TASKPERIOD\.mark\(/.test(m), '§4 所有活动都走同一个打点函数 ✓');
  const ri = m.indexOf('function relayToChat');
  const relay = ri >= 0 ? m.slice(ri, ri + 900) : '';
  ok(has(relay, 'markChatActivity('), '★★§4 她的发言/步骤流水（relayToChat）算"在推进"✓ —— 真机被掐断的就是这 17 秒 ★★');
  ok(/tts:speak[\s\S]{0,500}markChatActivity\(/.test(m), '★§4 她开口朗读（tts:speak）算"在推进" ✓★');
  ok(/chat:send[\s\S]{0,4000}markChatActive\(/.test(m), '★§4 主人消息 / 回复里的"有没有下一行动作"驱动 chatTaskActive ✓★');
  ok(/chat:continue[\s\S]{0,4000}markChatActive\(/.test(m), '★§4 续跑同样驱动 chatTaskActive ✓★');
  ok(/stats:task[\s\S]{0,3000}endTaskPeriodNow\(/.test(m), '★§4 循环结束（stats:task 带停止原因）→ 立刻收尾 ✓★');
  ok(/function requestStop[\s\S]{0,5000}endTaskPeriodNow\(/.test(m), '§4 被停止 → 立刻收尾 ✓');
  ok(has(m, 'chatTaskStuckMs'), '§4 "任务在跑"的兜底周期可配 ✓');
  /* ★老 bug 的**代码指纹**必须消失★（注释里保留"当年怎么错的"是**有意的文档** ✓，
     所以这里只查可执行的那几处 ✗→✓） */
  ok(!has(m, 'chatRestoreIdleMs) || 15000'), '★★§4 老代码 `chatRestoreIdleMs || 15000` **真的没了**★★');
  ok(/chatRestoreIdleMs\)[\s\S]{0,160}return v > 3000 \? v : 60000/.test(m),
    '★§4 新的默认空闲窗是 60s 并且有下限兜底 ✓（15s → 60s ✓）★');
  ok(/if \(chatWasVisible\) \{[\s\S]{0,400}TASKPERIOD\.enter\(/.test(m),
    '★§4 进入任务期改走 TASKPERIOD.enter（不再自己裸装计时器 ✓）★');
  ok(!has(m, 'chatTaskHideTimer'), '★§4 老的那个"裸计时器变量"也真的删干净了 ✓★');
}

/* §5 ★作用域检查 —— 我上一版就是在这儿翻车的✗★（2026-10-10 15:57 真机）
   我把"任务期状态 + 判定"写进了 `assistant:run` 的 handler **里面** ✗ →
   `requestStop` / `chat:send`（模块级）调用 → `ReferenceError: endTaskPeriodNow is not defined` ✗
   → ★她"听不见主人说话"✗（每句话都在 chat:send 里抛异常、模型根本没被叫 ✓）★，
   表现就是"她不动了" ✓（比惰性超时严重得多 ✓）。
   ★这一节把"作用域"钉住✗→✓★：这些定义必须出现在 handler **之前**（= 模块级 ✓），而且只能有一份 ✓。 */
{
  const m = src('main.js');
  const iH = m.indexOf("ipcMain.handle('assistant:run'");
  const NAMES = [
    'const TASKPERIOD', 'function markChatActive(', 'function markChatActivity(',
    'function markToolStart(', 'function markToolEnd(', 'function endTaskPeriodNow(',
    'function taskPeriodStats(', 'let chatTaskHidden', 'let chatTaskActive', 'let chatToolInFlight',
  ];
  ok(iH > 0, '§5 找得到 assistant:run 这个 handler（作用域判据的基准 ✓）', '@' + iH);
  const bad2 = NAMES.filter((n) => { const i = m.indexOf(n); return !(i > 0 && i < iH); });
  ok(bad2.length === 0, '★★§5 任务期的状态与函数**全在模块级**（不在 assistant:run 的 handler 里）★★',
    bad2.length ? ('★这些还在 handler 里/找不到 ✗：' + bad2.join(', ')) : '10 项全在 handler 之前 ✓');
  ok((m.match(/const TASKPERIOD/g) || []).length === 1, '★§5 TASKPERIOD 只定义一次（不能有两份 ✗）★');
  /* ★"用一句话驱动她"这条链路的关键打点必须还在★（真机就是靠它判断"她听不听得见" ✓） */
  ok(has(m, "'[chat] send from='"), '★§5 chat:send 里那行 `[chat] send from=` 还在（真机验证"她听不听得见"就靠它 ✓）★');
}

console.log('');
console.log('⚠️ ★没验到的（如实说 ✗）★：主进程的"全局快捷键真的按下去了"这条，');
console.log('   需要在一台**没有跑着主人桌宠**的机器/时刻上验（single-instance 锁 + 不许弹窗 ✓）→');
console.log('   本次只做了静态契约检查 + 纯逻辑检查 ✓；渲染层那半边由 probe-stop.js 真机验证 ✓。');
console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
