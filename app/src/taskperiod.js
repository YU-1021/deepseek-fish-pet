/* taskperiod.js —— ★「任务期」什么时候算结束★（纯逻辑 · 可注入时钟 · 可单测）
 *
 * 【任务期是什么】主人在做任务时要求"对话窗**全程**最小化"（他自己强调过 5 次 ✓）——
 *   于是有了这一段"对话窗被藏起来"的时期 ✓。藏起来容易 ✓，★难的是"什么时候可以还回来"✗★。
 *
 * 【★这次真机 bug 的根因（读代码 + debug.log 得出的，不是猜）★】
 *   原来的判定：`连续 chatRestoreIdleMs（15 秒）没有任何**屏幕动作** → 恢复对话窗` ✗
 *   · ① 计时的重置点只有**工具结束**（assistant:run 的 finally ✓）→
 *        ★她「想 + 说话」的时间不算推进✗★ → 思考越久越容易被掐 ✓；
 *   · ② 计时器是**上一次工具结束时**装的 ✓ → 下一次工具跑得比剩余时间久，
 *        就会在**动作进行中**到点 ✗；
 *   · ③ 到点时**不复核**"现在到底在不在推进"✗；
 *   · ④ 这条结束**不写会话日志** ✗ → 事后查不到"任务期为什么结束了" ✓。
 *   真机现场（debug.log）：15:33:12 最后一次工具结束 → 她在 15:33:13~26 连说了 8 条（气泡 + tts）
 *   → 15:33:27.016 「任务期结束（15s 没有屏幕动作）→ 恢复对话窗」✗ → ★剩下 5 格再没点★ ✓
 *   ★一句话✗★：★任务越需要她思考，越容易被误判成"做完了"✗★（这是 bug，不是她点不到 ✗）。
 *
 * 【本模块的判定（四条缺一不可）】
 *   ① ★"在推进"的证据变宽★：任何工具（开始/结束 ✓）、`mark()` 打上来的任何活动
 *      （她发言 / 朗读 / 主人说话 / 步骤流水 ✓）都重置计时 ✓；
 *   ② ★循环还在跑就绝不算结束★：`active` = "循环还没给出停止原因"✓
 *      （main 里由 chat:send / chat:continue 的"有没有下一行动作"驱动 ✓）；
 *   ③ ★有工具在跑就绝不算结束★：`inFlight > 0` ✓；
 *   ④ ★空闲多久才算真的空闲★：`idleMs`（默认 60s ✓）；而"在跑"时用 `stuckMs`（默认 300s ✓）
 *      只是**兜底重装**：★在跑就不恢复✗★（宁可多等她，也不要在她干活时把窗弹出来 ✓），
 *      只记一条"任务还在推进（已 X 秒没活动）"给日志 ✓。
 *   ★到点时要**按当下的事实再判一次**✗→✓★ —— 这是这次 bug 的直接教训 ✓。
 *
 * 【依赖注入（为什么不用真时钟✗）】
 *   `now` / `setTimeout` / `clearTimeout` 全部可注入 ✓ → app/scripts/test-taskperiod.js
 *   可以在纯 Node 里把"时间"捏在手里，把每一条边界都钉死（不需要真的等 60 秒 ✓）。
 */
'use strict';

function create(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const setT = o.setTimeout || setTimeout;
  const clrT = o.clearTimeout || clearTimeout;
  const idleMs = () => {
    const v = o.idleMs ? Number(o.idleMs()) : 60000;
    return v > 3000 ? v : 60000;          // ★配得比 3s 还小就按 60s 兜住 ✓（15s → 60s ✓）
  };
  const stuckMs = () => {
    const v = o.stuckMs ? Number(o.stuckMs()) : 300000;
    return v > 30000 ? v : 300000;
  };
  const onRestore = o.onRestore || (() => {});
  const onStuck = o.onStuck || (() => {});

  let hidden = false;
  let timer = null;
  let active = false;      // ★循环还没给出停止原因 = 任务还在推进★
  let inFlight = 0;        // ★有工具正在执行★
  let lastAt = 0;
  let lastWhy = '';
  let stuckTicks = 0;

  function stats() {
    return {
      hidden, active, inFlight, lastAt, lastWhy,
      idleMs: idleMs(), stuckMs: stuckMs(), timerArmed: !!timer, stuckTicks,
    };
  }

  function arm(why) {
    if (!hidden) return;
    if (timer) { clrT(timer); timer = null; }
    const busy = active || inFlight > 0;
    const delay = busy ? stuckMs() : idleMs();
    timer = setT(() => {
      timer = null;
      /* ★到点了：按**当下**的事实再判一次 ✗→✓（这一次复核就是这次 bug 的正解核心 ✓） */
      if (inFlight > 0) { arm('工具还在跑'); return; }
      if (active) {
        stuckTicks++;
        try { onStuck(stats()); } catch (e) {}
        arm('任务还在推进');           // ★在跑 → 继续等，绝不恢复对话窗 ✗★
        return;
      }
      const idleS = Math.round((now() - (lastAt || now())) / 1000);
      hidden = false;
      try {
        onRestore({
          reason: 'idle-restore',
          tag: (why ? why + '，' : '') + '空闲 ' + idleS + 's 没有任何推进（最后一条证据：' + (lastWhy || '-') + '）',
          idleS, stats: null,
        });
      } catch (e) {}
    }, delay);
  }

  /* ★"在推进"的唯一打点处★ */
  function mark(why) {
    lastAt = now();
    lastWhy = String(why == null ? '' : why);
    if (hidden) arm(lastWhy);
  }

  return {
    mark,
    /* 进入任务期（第一次因为屏幕工具把对话窗藏起来时调 ✓） */
    enter(why) { hidden = true; mark(why || '进入任务期'); },
    /* 循环是否还在跑（main 用"有没有下一行动作"驱动 ✓）
       ★这个状态一变就要重新装表 ✗→✓★ —— 它是**窗口长度**的分界线：
         · 变成"在跑" → 换成兜底窗口（不恢复 ✓）；
         · 变成"收尾" → ★换成空闲窗口 ✓★：循环一结束，就只等"真的空闲"那点时间了 ✓
           （★这里也必须打点 ✓，否则"收尾"之后计时器还按老窗口算 ✗ —— 
             测试 §2 第一条就是这个坑：setActive(false) 不打点 → 61s 也不恢复 ✗）。 */
    setActive(v) { active = !!v; mark('循环' + (active ? '在跑' : '收尾')); },
    /* 工具进出（同一个工具两次打点 ✓ —— 开始也算推进 ✓，跑着的时候靠 inFlight 挡住空闲判定 ✓） */
    toolStart(name) { inFlight++; mark('工具开始(' + (name || '') + ')'); },
    toolEnd(name) { inFlight = Math.max(0, inFlight - 1); mark('工具结束(' + (name || '') + ')'); },
    /* ★循环已结束 / 被停止 → 立刻还回对话窗★（reason 用调用方给的真实原因 ✓，不写 idle-restore ✗） */
    endNow(why) {
      active = false;
      mark('任务期收尾(' + (why || '') + ')');
      if (!hidden) return false;
      hidden = false;
      if (timer) { clrT(timer); timer = null; }
      const idleS = Math.round((now() - (lastAt || now())) / 1000);
      try { onRestore({ reason: 'loop-end', tag: '循环结束(' + (why || '') + ')，最后一次推进 ' + idleS + 's 前：' + (lastWhy || '-'), idleS }); } catch (e) {}
      return true;
    },
    stats,
  };
}

module.exports = { create };
