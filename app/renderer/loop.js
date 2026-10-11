/* agent 主循环驱动器（停止条件显式化）—— 抄自 DSH 的 dsh-agent-loop
 *
 * 【为什么需要】原来主循环在 renderer/chat.js 的 runTask 里，**递归 + 停止条件散在六处**：
 *   depth > stepBudget、lookStreak > LOOK_STREAK_MAX、!r、!next、!next.en、异常 ——
 *   而且**停止原因从未被记录**：一律 reportTask()，所以用户只看到"她停了"，
 *   不知道为什么停、也没法据此改进。
 *   今天那次"看→又想看"的自转就是直接后果：唯一的闸门是 depth > stepBudget，
 *   而步数上限当时被调到 400，于是空转了几分钟。
 *
 * 【DSH 怎么做（dsh-agent-loop/lib/index.js）】
 *   · :951 `while (true)` 每步发 step/start … step/end；
 *   · :1151,:1017 停止原因是**联合类型** `completed | max-tokens | blocked | aborted | error`
 *     —— 不是"循环结束"这么一句糊话；
 *   · :911 `agent/pre-step` waterfall 可以在**步进之前**否决（返回 reject）；
 *   · :711 "Every request is derived from the session log"（每步都从会话日志重新出发）。
 *
 * 【本模块】把"能不能再走一步"和"为什么停下"收进一个地方，并且**只做判定、不做 UI**：
 *   渲染层每步之前问一次 beforeStep()，结束时把 reason 交给 reportTask() 显示出来。
 *   判定是纯逻辑 → 可以纯 Node 测试（见 app/scripts/test-loop.js）。
 *
 * 【加载方式】渲染进程是普通 <script>（无 module/require），所以写成 UMD-ish：
 *   浏览器里挂到 window.PetLoop，Node 里走 module.exports —— 同一份代码两边都能用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetLoop = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 停止原因（照 DSH 的联合类型，按桌宠的实际情况取名）：
   *   completed    正常收尾（模型不再给出下一步动作）
   *   step-budget  步数预算用完
   *   look-streak  连续只在"看屏幕"、没有任何实际动作（自转）
   *   no-result    工具没有返回结果（链路出问题）
   *   no-next      模型没有给出后续（空回复）
   *   aborted      被中止（用户喊停 / 换任务）
   *   error        出错 */
  const REASONS = ['completed', 'step-budget', 'look-streak', 'no-result', 'no-next', 'aborted', 'error'];

  const MSG = {
    'step-budget': (s) => '⏸ 已达到本次任务的步数上限（' + s.stepBudget + '），先停下来。',
    'look-streak': (s) => '⏸ 连续 ' + s.lookStreak + ' 次都只是在看屏幕（最近一次是 ' + s.lastTool + '）、没有任何实际动作，先停下来。'
      + '这通常意味着卡在"看→再看→再看"的自转里 —— 需要换个办法（点一下试试、放大看清、裁模板、退回上一层），或者告诉主人卡在哪。',
    'completed': () => '',
    'no-result': (s) => '⏸ ' + (s.lastTool || '这一步') + ' 没有返回结果（执行链路可能出了问题），先停下来。',
    'no-next': () => '⏸ 模型没有给出后续动作，先停下来。',
    'aborted': () => '⏸ 已中止当前任务。',
    'error': (s) => '⏸ 出错了先停下来：' + (s.error || '(未提供错误信息)'),
  };

  function create(opts) {
    const o = Object.assign({ stepBudget: 6, lookStreakMax: 6, lookOnlyTools: [] }, opts || {});
    const lookSet = {};
    for (const t of (o.lookOnlyTools || [])) lookSet[t] = 1;

    let steps = 0;          // 已经走过的步数
    let lookStreak = 0;     // 连续"只看不动"的次数
    let lastTool = '';
    let reason = null;      // 终止原因（未结束则为 null）
    let started = false;

    function start() {
      steps = 0; lookStreak = 0; lastTool = ''; reason = null; started = true;
      return snap();
    }

    function snap() {
      return { steps, lookStreak, lastTool, reason, stepBudget: o.stepBudget, lookStreakMax: o.lookStreakMax, started };
    }

    function stop(r, extra) {
      reason = r;
      return { kind: 'stop', reason: r, message: (MSG[r] || (() => ''))(Object.assign(snap(), extra || {})), detail: extra || null };
    }

    /* 步进之前问一次：能不能走？返回 {kind:'continue'} 或 {kind:'stop', reason, message}。
     * 注意顺序：**先看是不是自转，再看预算** —— 自转是"立刻该停"的信号，
     * 而预算用尽是"走够了"；先报自转，用户得到的解释更贴切。 */
    function beforeStep(step) {
      const s = step || {};
      const tool = String(s.tool || '');
      if (reason) return { kind: 'stop', reason, message: (MSG[reason] || (() => ''))(snap()), alreadyStopped: true };
      if (!started) start();

      if (lookSet[tool]) {
        /* 注意：这里只**累加计数**，真正的判定放在下面 —— 因为"这一看"本身还是允许的，
           要看的是"连着看了太多次"。 */
        lookStreak += 1;
        lastTool = tool;
        if (lookStreak > o.lookStreakMax) return stop('look-streak');
      } else {
        lookStreak = 0;
        if (tool) lastTool = tool;
      }

      if (steps >= o.stepBudget) return stop('step-budget');
      steps += 1;
      return { kind: 'continue', steps, lookStreak };
    }

    /* 结束时登记原因（completed / error / aborted / no-result / no-next） */
    function finish(r, extra) {
      if (reason) return { kind: 'stop', reason, message: (MSG[reason] || (() => ''))(snap()) };
      return stop(r || 'completed', extra);
    }

    function abort(why) { return finish('aborted', { error: why }); }
    function fail(err) { return finish('error', { error: (err && err.message) || err }); }

    return {
      start, beforeStep, finish, abort, fail, stats: snap,
      REASONS, messageFor: (r, extra) => (MSG[r] || (() => ''))(Object.assign(snap(), extra || {})),
    };
  }

  return { create, REASONS, MSG };
});
