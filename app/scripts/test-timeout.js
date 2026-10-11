/* timeout.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-timeout.js
 */
const T = require('../src/timeout');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== timeout.js 单元测试（纯 Node）===');

  /* §1 超时表：按工具查、未知工具走默认 */
  ok(T.timeoutFor('click') === 15000, '§1 click 有专属超时', String(T.timeoutFor('click')));
  ok(T.timeoutFor('watch_screen') === 180000, '§1 watch_screen 给足了时间（它自己最长 120 秒）');
  ok(T.timeoutFor('从来没听过的工具') === T.TOOL_TIMEOUT_MS.default, '§1 未知工具走 default');
  ok(T.timeoutFor(null) === T.TOOL_TIMEOUT_MS.default, '§1 null 也走 default');

  /* §2 正常完成 / 正常失败 */
  {
    const r = await T.withTimeout(Promise.resolve('好'), 1000, 'x');
    ok(r.timedOut === false && r.value === '好', '§2 正常完成 → {timedOut:false, value}');
  }
  {
    const r = await T.withTimeout(Promise.reject(new Error('炸了')), 1000, 'x');
    ok(r.timedOut === false && r.error && r.error.message === '炸了', '§2 正常失败 → 异常原样交回（不吞）');
  }

  /* §3 ★ 超时：结构化返回 + **原 promise 不被抛弃** */
  {
    let lateRejected = false;
    let lateSettled = false;
    const slow = (async () => { await sleep(200); lateSettled = true; throw new Error('迟到的失败'); })();
    process.once('unhandledRejection', () => { lateRejected = true; });
    const r = await T.withTimeout(slow, 50, 'slow_tool');
    ok(r.timedOut === true && r.code === 'TOOL_TIMEOUT', '§3 超时 → 结构化 TOOL_TIMEOUT', JSON.stringify({ tool: r.tool, ms: r.afterMs }));
    ok(r.tool === 'slow_tool' && r.afterMs === 50, '§3 带上了工具名和阈值');
    ok(typeof r.message === 'string' && r.message.indexOf('超时') >= 0, '§3 有一句给模型看的话', r.message.slice(0, 40));
    /* 等那个慢 promise 真的 reject，看有没有变成 unhandledRejection */
    await sleep(300);
    ok(lateSettled === true, '§3 慢 promise 确实在超时之后才失败（测试有意义）');
    ok(lateRejected === false, '★ §3 迟到的 rejection **被接住了**，没有 unhandledRejection（DSH 的"不抛弃 promise"）');
  }

  /* §4 超时之后原 promise 正常完成 → 也不该有副作用 */
  {
    let done = false;
    const slow = (async () => { await sleep(200); done = true; return '晚到的成功'; })();
    const r = await T.withTimeout(slow, 50, 'x');
    ok(r.timedOut === true, '§4 先超时');
    await sleep(300);
    ok(done === true, '§4 原操作仍然跑完了（我们不抛弃它，只是不等它）');
  }

  /* §5 onTimeout 回调会被调用（用于转后台任务/记日志） */
  {
    let called = null;
    await T.withTimeout(sleep(200), 30, 'bg_tool', (tool, ms) => { called = { tool, ms }; });
    ok(called && called.tool === 'bg_tool' && called.ms === 30, '§5 onTimeout 回调被调用（可用来转后台）', JSON.stringify(called));
  }

  /* §6 不传 ms → 用工具表里的值 */
  {
    const r = await T.withTimeout(sleep(5), 0, 'click');   // click=15000ms，肯定不超时
    ok(r.timedOut === false && r.value === undefined, '§6 不传 ms 时按工具表算');
  }

  /* §7 非 promise 值也能包（工具可能同步返回字符串） */
  {
    const r = await T.withTimeout('直接的值', 1000, 'x');
    ok(r.timedOut === false && r.value === '直接的值', '§7 同步值也能正常包住');
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
