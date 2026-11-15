/* test-taskperiod.js —— ★「任务期什么时候结束」的单元测试（纯 Node + 假时钟）★
 *
 * 跑法：node app/scripts/test-taskperiod.js
 *
 * 【为什么必须能把时间捏在手里 ✗→✓】
 *   真机 bug 是"她思考 17 秒被 15 秒的空闲判定掐断"✗ —— 这种事**不能靠真机上跑一遍看看** ✓
 *   （要等 15/60/300 秒 ✗、而且主进程的代码没法在探针里跑：single-instance 锁 + 不许弹窗 ✗）。
 *   所以判定逻辑抽成 src/taskperiod.js（可注入 now/setTimeout ✓）—— 这里把每条边界钉死 ✓。
 *
 * 【★第 1 条用例就是真机现场★】复现 debug.log 那 17 秒：工具结束后她一直在**说话 + 思考**，
 *   老代码会在这里恢复对话窗（= 判定任务结束 ✗），新代码必须**不**恢复 ✓。
 */
'use strict';
const TP = require('../src/taskperiod');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

/* ★假时钟：时间只能通过 adv() 前进 ✓；到点的回调按时间顺序触发 ✓ */
function harness(o) {
  const cfg = o || {};
  let t = 0;
  let seq = 1;
  const timers = new Map();          // id -> {fn, at}
  const restores = [];
  const stucks = [];
  const setT = (fn, delay) => { const id = seq++; timers.set(id, { fn, at: t + delay }); return id; };
  const clrT = (id) => { timers.delete(id); };
  const tp = TP.create({
    now: () => t, setTimeout: setT, clearTimeout: clrT,
    idleMs: cfg.idleMs, stuckMs: cfg.stuckMs,
    onRestore: (i) => restores.push(i),
    onStuck: (s) => stucks.push(s),
  });
  function adv(ms) {
    const end = t + ms;
    for (;;) {
      const due = Array.from(timers.entries()).filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, v] = due[0];
      timers.delete(id);
      t = v.at;
      v.fn();
    }
    t = end;
  }
  return { tp, adv, restores, stucks, timers, now: () => t };
}

console.log('=== test-taskperiod（任务期结束判定：假时钟单元测试）===');

/* §1 ★真机现场复现★：工具结束后她一直在说话/思考 → 绝不能恢复对话窗 */
{
  const h = harness();
  h.tp.enter('屏幕工具(click)');
  h.tp.setActive(true);                 // 循环还在跑（还有下一步）
  h.tp.toolStart('click');              // 15:33:12 左右：工具结束
  h.adv(200);                           // 工具跑了 200ms
  h.tp.toolEnd('click');
  /* 15:33:13 ~ 15:33:26 她连说 8 条（立绘气泡 + tts ✓ —— 真机 debug.log 里就是这些行 ✓） */
  for (let i = 0; i < 8; i++) { h.tp.mark('她开口朗读'); h.adv(1700); }
  ok(h.restores.length === 0, '★★§1 真机现场：她说话 + 思考的 ~15s 里**没有**恢复对话窗（老代码在这儿被掐断 ✗）★★',
    'restores=' + h.restores.length);
  /* 再往后走很久：只要循环还在跑（active ✓），就永远不恢复 ✓ */
  h.adv(1000 * 1000);
  ok(h.restores.length === 0, '★★§1 任务还在推进（循环没给停止原因）→ 等多久都不恢复 ✓★', '过了 1000s');
  ok(h.stucks.length >= 1, '§1 但会按兜底周期记一条"还在推进"的日志 ✓（可查、且不误伤 ✓）', 'stuck 日志 ' + h.stucks.length + ' 条');
}

/* §2 循环结束了（active=false）→ 空闲 idleMs 之后才恢复 ✓（默认 60s，不是 15s） */
{
  const h = harness();
  h.tp.enter('屏幕工具(screen_look)');
  h.tp.setActive(true);
  h.tp.toolStart('screen_diff'); h.adv(300); h.tp.toolEnd('screen_diff');
  h.tp.setActive(false);                // 循环给了停止原因（收尾 ✓）
  h.adv(59000);
  ok(h.restores.length === 0, '§2 空闲还没到 60s → 先不恢复 ✓（老默认 15s 会在这里恢复 ✗）');
  h.adv(2000);
  ok(h.restores.length === 1, '★§2 空闲满 60s → 恢复一次 ✓★');
  ok(h.restores[0].reason === 'idle-restore', '★§2 原因登记为 idle-restore（会落进会话日志 ✓）★', h.restores[0].reason);
  ok(/空闲/.test(h.restores[0].tag), '§2 回执里带"空闲多少秒 + 最后一条证据"', h.restores[0].tag.slice(0, 60));
}

/* §3 ★工具在跑 = 绝不算空闲★（真机的另一种形状：计时器在上一次工具结束时装的，
      下一次工具跑得比剩余时间久 → 老代码会在**动作进行中**到点 ✗） */
{
  const h = harness();
  h.tp.enter('屏幕工具(click)');
  h.tp.setActive(false);                // 故意把"循环在跑"关掉，只靠 inFlight 撑
  h.tp.toolStart('click');
  h.adv(60 * 1000 * 5);                 // 这个工具跑了 5 分钟（远超 60s 空闲窗）
  ok(h.restores.length === 0, '★★§3 工具正在执行 → 超过空闲窗也**不**恢复 ✓（老代码会在动作进行中误判 ✗）★★');
  ok(h.timers.size <= 1, '§3 计时器没有堆起来（一次只有一个待触发 ✓）', 'pending=' + h.timers.size);
  h.tp.toolEnd('click');
  h.adv(61 * 1000);
  ok(h.restores.length === 1, '§3 工具结束后才可能空闲恢复 ✓');
}

/* §4 每一次"推进"都把计时往后推（她发言也算推进 ✓） */
{
  const h = harness();
  h.tp.enter('屏幕工具(click)');
  h.tp.setActive(false);
  for (let i = 0; i < 6; i++) { h.tp.mark('她开口朗读'); h.adv(40000); }   // 每 40s 说一句
  ok(h.restores.length === 0, '★§4 每 40s 有活动 → 一直不恢复 ✓（"她在说话"就被当成推进 ✓）★');
  h.adv(61000);
  ok(h.restores.length === 1, '§4 停止活动 60s 后才恢复 ✓');
}

/* §5 nothing-to-do：没进任务期时，一切打点都不该装表、也不该恢复 */
{
  const h = harness();
  h.tp.mark('她开口朗读');
  h.tp.setActive(true);
  h.tp.toolStart('click'); h.tp.toolEnd('click');
  h.adv(10 * 60 * 1000);
  ok(h.restores.length === 0, '§5 没进任务期 → 永远不会"恢复"（也不会装表 ✓）', 'pending=' + h.timers.size);
  ok(h.timers.size === 0, '§5 没有多余的计时器 ✓');
}

/* §6 endNow：循环结束/被停止 → ★立刻★恢复（不等空闲窗 ✓），原因用调用方给的真实原因 ✓ */
{
  const h = harness();
  h.tp.enter('屏幕工具(click)');
  h.tp.setActive(true);
  h.tp.mark('工具开始(click)');
  h.adv(1000);
  const r = h.tp.endNow('循环结束(completed)');
  ok(r === true && h.restores.length === 1, '★§6 循环一结束就**立刻**恢复对话窗 ✓（主人要马上看结果 ✓）★');
  ok(h.restores[0].reason === 'loop-end', '★§6 这条**不**记成 idle-restore ✓（避免同一件事记两遍 ✓）★', h.restores[0].reason);
  ok(h.timers.size === 0, '§6 计时器被清掉 ✓');
  ok(h.tp.stats().hidden === false, '§6 状态回到"没在任务期" ✓');
}

/* §7 默认窗口确实是 60s（不是 15s），而且配得特别小也有下限 */
{
  const h = harness();
  h.tp.enter('x'); h.tp.setActive(false);
  const st = h.tp.stats();
  ok(st.idleMs === 60000, '★§7 默认空闲窗 = 60s（真机 bug 就是 15s 太短 ✗）★', 'idleMs=' + st.idleMs);
  ok(st.stuckMs === 300000, '§7 "任务在跑"的兜底周期 = 300s', 'stuckMs=' + st.stuckMs);
  const h2 = harness({ idleMs: () => 800 });
  h2.tp.enter('x'); h2.tp.setActive(false);
  ok(h2.tp.stats().idleMs === 60000, '★§7 配成 800ms 这种危险值 → 按 60s 兜住 ✓★', 'idleMs=' + h2.tp.stats().idleMs);
}

/* §8 恢复之后不会再重复恢复（幂等 ✓ —— 真机上"对话窗反复弹出来"也是主人骂过的问题 ✗） */
{
  const h = harness();
  h.tp.enter('x'); h.tp.setActive(false);
  h.adv(61000);
  ok(h.restores.length === 1, '§8 恢复过一次 ✓');
  h.tp.mark('她开口朗读');            // 恢复之后她还在说话
  h.adv(10 * 60 * 1000);
  ok(h.restores.length === 1, '★§8 恢复之后不论过多久、有多少活动，都**不会**再恢复一次 ✓（不会反复弹窗 ✓）★');
  h.tp.endNow('再来一次');
  ok(h.restores.length === 1, '§8 已经不在任务期时 endNow 也不产生第二次恢复 ✓');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
