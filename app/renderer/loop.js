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
 *   · :1027-1030 停止原因是**联合类型**（DSH 一共 ★7 个★：
 *     `completed | max-tokens | blocked | aborted | error | interrupted | forked`
 *     —— 写进 turn/end，见 typert.host.js:803，**落到会话日志**里，事后查得到 ✓）
 *     ★不是"循环结束"这么一句糊话★；
 *     （⚠️ 这段注释原来只抄了 5 个，把 `interrupted` / `forked` 漏了 —— 2026-10-10 补齐。）
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
   *   aborted      被中止（主人用**聊天消息**喊停 / 换任务）
   *   error        出错
   *   ★interrupted 被**外部强制中断**（界面上的「停止」按钮 / 全局快捷键 ✓）
   *                —— 2026-10-10 新增。★为什么它与 aborted 分开✗★：
   *                  DSH 的联合类型里这两个是**两个值**✓（`aborted` 带 abortSignal.reason ✓、
   *                  `interrupted` 是"外部中断"✓）；桌宠这次的诉求正是"主人**点一下**就停"✓，
   *                  与"她在聊天里说停"不是同一条路 ✓ —— 分开记，事后 grep 才分得清
   *                  "是按钮停的"还是"她/模型自己收的" ✓，而不是混成一个模糊的 aborted ✗。
   *   ★idle-restore 任务**期**结束（不是"循环结束" ✗）：连续一段时间没有任何推进
   *                （没发言、没工具调用、循环也早已给出停止原因 ✓）→ 判定"任务期结束" → 恢复对话窗 ✓。
   *                —— 2026-10-10 新增。★真机 bug★：她「想 + 说话」的 ~17 秒被"15s 没有屏幕动作"
   *                误判成任务结束 ✗ → 剩下 5 格再没点 ✓（"任务越需要她思考，越容易被掐断"✗）。
   *                ★为什么登记在这张表里✗★：本项目的"任务结束原因"只有这一张表 ✓，
   *                而 stoplog.KNOWN 必须与它**逐字一致** ✓（probe-stoplog.js 会断言 ✓），
   *                不然新原因会被标成 unknownReason ✗（等于没登记 ✓）。 */
  const REASONS = ['completed', 'step-budget', 'look-streak', 'no-result', 'no-next', 'aborted', 'error', 'interrupted', 'idle-restore'];

  const MSG = {
    'step-budget': (s) => '⏸ 已达到本次任务的步数上限（' + s.stepBudget + '），先停下来。',
    'look-streak': (s) => '⏸ 连续 ' + s.lookStreak + ' 次都只是在看屏幕（最近一次是 ' + s.lastTool + '）、没有任何实际动作，先停下来。'
      + '这通常意味着卡在"看→再看→再看"的自转里 —— 需要换个办法（点一下试试、放大看清、裁模板、退回上一层），或者告诉主人卡在哪。',
    'completed': () => '',
    'no-result': (s) => '⏸ ' + (s.lastTool || '这一步') + ' 没有返回结果（执行链路可能出了问题），先停下来。',
    'no-next': () => '⏸ 模型没有给出后续动作，先停下来。',
    'aborted': () => '⏸ 已中止当前任务。',
    'error': (s) => '⏸ 出错了先停下来：' + (s.error || '(未提供错误信息)'),
    /* 外部停止：说人话 + 明确"不会再动了" ✓（主人今天就是因为"按了停没反应"才发火的 ✗） */
    'interrupted': (s) => '⏹ 已停止（' + (s.via || '停止选项') + '触发）—— ★接下来一个动作都不会再执行★ ✓'
      + '（已经把这一轮的任务链断掉了 ✓；想让我继续时，直接说要做什么就行 ✓）',
    /* ★任务期结束（不是循环结束）★：这条**只**在"真的空闲"时才该出现 ✓ ——
       它以前压根没有记录 ✗（真机查过 session.json 里没有对应事件 ✓），所以"任务期为什么结束"查不到 ✓。 */
    'idle-restore': (s) => '⏹ 任务期结束（' + (s.via || '空闲') + '）—— 连续一段时间没有任何推进'
      + '（她没说话、没调工具、循环也早已结束 ✓），所以把对话窗还回来 ✓。'
      + '★注意✗★：如果这一步是被"空闲"掐掉的，说明任务还没做完 —— 需要看会话日志里上一条真正的停止原因 ✓。',
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
