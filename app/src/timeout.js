/* 工具超时策略 —— 抄自 DSH 的 dsh-tool-call-timeout-policy + dsh-timeout
 *
 * 【为什么】原来每个调用点各写各的 timeout（asr/assistant/focuswin/input/llm/matcher/screenstream），
 *   结果是：**没有统一口径**（谁该等多久、超时了怎么办，到处不一样），
 *   而且**外层没有兜底** —— 某个工具真卡住时，整轮对话就挂在那里，用户看到的就是"她不动了"。
 *
 * 【DSH 怎么做（dsh-tool-call-timeout-policy/lib/index.js）】
 *   · :123 超时**由工具自己声明**（`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`），
 *     策略插件只负责读表、不硬编码；
 *   · dsh-timeout/lib/index.js:57 `deadline()` 用 `AbortSignal.any` 把信号合起来；
 *   · :125 **替换 `exec.signal` 之后委派给原工具** —— 定时器赢了才把它转成结构化的 `TOOL_TIMEOUT`，
 *     **原工具的 promise 永远不被丢弃**（不抛弃、不 unhandled rejection）；
 *   · dsh-tool-pwsh/lib/index.js:187 长时间操作**转成后台 job** 继续跑，而不是杀掉。
 *
 * 【本模块的取舍】
 *   · 超时表集中在这里（一处声明、到处生效），按工具给不同时长；
 *   · `withTimeout` **永不 reject** —— 它总是 resolve 成 `{timedOut, value|error|code}`，
 *     调用方不需要写 try/catch 去分辨"是超时还是普通失败"；
 *   · ⚠️ 关键细节：**超时之后原 promise 仍然挂着**，它会 resolve 或 reject —— 我们必须在
 *     `else` 分支里把它接住，否则就是一个 unhandledRejection（§3 专门测这条）；
 *   · "只通知不杀"是**外层**的语义；真正杀死子进程仍然由各调用点自己的 execFile timeout 负责
 *     （两层配合：外层告诉模型"这个工具超时了"，内层保证不留孤儿进程）。
 */
'use strict';

/* 超时表：一处声明。数字都给得比正常耗时长一截，只在"真卡住"时才触发。 */
const TOOL_TIMEOUT_MS = {
  default: 60000,
  /* 看屏幕类 */
  screen_look: 30000,
  screen_shot: 30000,
  watch_screen: 180000,        // 它自身最长可拍 120 秒，必须给足
  /* 定位类 */
  find_template: 40000,
  find_template_scroll: 150000, // 里面可能滚十几次，每次都要抓帧+匹配
  find_text: 60000,
  make_template: 30000,
  template_list: 10000,
  /* 键鼠类 */
  click: 15000, rclick: 15000, dclick: 15000, move: 15000,
  drag: 25000, scroll: 15000, key: 15000, type: 60000,
  /* 流程类 */
  flow_run: 300000, flow_save: 10000, flow_list: 10000,
  /* 文件类 */
  read_file: 30000, write_file: 30000, list_dir: 20000,
  run_file: 120000, proj_run: 120000, proj_read: 20000, proj_write: 20000,
  /* 技能/网页 */
  use_skill: 20000, skill_read: 20000, skill_ls: 10000,
  web_open: 60000, web_read: 60000, web_click: 30000, web_type: 30000,
  /* 窗口 */
  focus_window: 25000, windows_list: 25000,
  /* 游戏托管 */
  game_start: 300000, game_stop: 30000, game_status: 15000,
};

function timeoutFor(tool) {
  const t = String(tool || '');
  /* 【唯一声明处】优先读能力注册表（工具自己声明的 timeoutMs），表里没有才回落到下面这张。
     这样"新加一个工具"只需要在 src/registry.js 的 TOOL_DEFS 里写一行。
     （注册表 lazily 建一次并缓存 —— withTools 会注册 40 多个定义，不必每次调用都重建。） */
  try {
    if (!timeoutFor._reg) timeoutFor._reg = require('./registry').withTools();
    const d = timeoutFor._reg.get('tool', t);
    if (d && Number.isFinite(d.timeoutMs)) return d.timeoutMs;
  } catch {}
  if (Object.prototype.hasOwnProperty.call(TOOL_TIMEOUT_MS, t)) return TOOL_TIMEOUT_MS[t];
  return TOOL_TIMEOUT_MS.default;
}

/* 给超时写一句人/模型都能看懂的话（模型要靠它决定下一步） */
function timeoutMessage(tool, ms) {
  return '⏱ **' + tool + ' 超时了**（超过 ' + Math.round(ms / 1000) + ' 秒没有返回）。\n'
    + '可能的原因：目标窗口没响应、网络慢、或者这一步本身就是慢操作。\n'
    + '**这不是"操作失败"** —— 它可能还在后台继续跑。建议：先 screen_look 看一眼画面到底变了没有，'
    + '再决定是重试、换个做法，还是停下来告诉我。';
}

/* 把一个 promise 包上超时。**永远 resolve**，形状固定：
 *   { timedOut:false, value }           正常完成
 *   { timedOut:false, error }           正常失败（把异常原样交回调用方）
 *   { timedOut:true,  code:'TOOL_TIMEOUT', tool, afterMs, message }
 * onTimeout 可选：超时时额外调一次（例如记日志、或把操作转后台）。
 */
function withTimeout(promise, ms, tool, onTimeout) {
  const limit = Number(ms) || timeoutFor(tool);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (typeof onTimeout === 'function') onTimeout(tool, limit); } catch {}
      resolve({ timedOut: true, code: 'TOOL_TIMEOUT', tool: String(tool || ''), afterMs: limit, message: timeoutMessage(tool, limit) });
    }, limit);
    Promise.resolve(promise).then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ timedOut: false, value }); },
      (error) => {
        /* ★ 这一分支有两种情况：
           ① 还没超时 → 正常把失败交回调用方；
           ② **已经超时了**（settled=true）→ 原 promise 现在才 reject。
              我们必须在这里把它**接住**（什么都不做也算接住），否则会变成
              unhandledRejection —— 这正是 DSH 说的"工具的 promise 不被抛弃"。
              §3 就是测这一条的。 */
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      }
    );
  });
}

module.exports = { withTimeout, timeoutFor, timeoutMessage, TOOL_TIMEOUT_MS };
