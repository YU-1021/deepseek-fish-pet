// 游戏助手：持续盯屏 → 视觉决策 → 键鼠执行 → 容错，循环到 DONE / 手动停止 / 到步数上限。
//
// 平时**完全关闭**：不起循环、不抓屏、不调模型、不碰键鼠。
// 只有用户对 AI 助手说"打游戏"，模型按 play-game 技能调 game_start 才会启动。
//
// 设计要点：
// - 循环在**主进程**里跑，一步 = 抓帧 → 视觉判断 → 解析动作 → 执行 → 回看画面变没变。
// - **决策**：把最近几步「看到什么 / 做了什么 / 画面变没变」回喂给视觉模型，
//   所以它不会重复无效动作，而是换做法 —— 这是"真的会打"和"乱点一通"的区别。
// - **容错**：抓帧 / 视觉 / 动作三类失败各自重试或跳过，不因一次抖动整体崩掉；
//   同一个操作反复无效、画面长时间不变、视觉连续不可用 → 判定卡住，自动收手并说明原因。
// - 每步通过 onLog 推给对话窗，用户实时看得到，随时能停（stop 响应在 250ms 内）。
const screenstream = require('./screenstream');
const vision = require('./vision');
const assistant = require('./assistant');
const config = require('./config');

const PROTOCOL = '\n\n【协议】每次观察后：'
  + '\n1) 先用一句中文说明：现在是什么局面（主界面/菜单/战斗/加载中/结算/弹窗…）、你的判断。'
  + '\n2) 最后单独一行，二选一：'
  + '\n   ACTION: 工具|参数     —— 坐标基于 1280x720 截图，左上角 0,0，取你要点的元素中心'
  + '\n   DONE                  —— 目标已达成，或当前确实没有任何可做的操作（就写 DONE，别写成 ACTION: DONE）'
  + '\n可用工具：click / dclick / rclick / drag / scroll / type / key / move。'
  + '\n注意：一次只做一个动作；看不清就先点开看得清的地方，别乱点。';

let onLog = () => {};
let onStop = () => {};
let onStart = () => {};
let onFinish = () => {};
let running = false;
let stopFlag = false;
let step = 0;
let opts = { task: '', intervalMs: 3500, actionWaitMs: 1200, maxSteps: 60, dryRun: false };

let recent = [];                                     // 最近几步的短期记忆，回喂给模型
let lastAct = '';                                    // 上一个动作（判断是不是在原地打转）
let repeatAct = 0;                                   // 同一个动作连续重复了几次
let errStreak = 0;                                   // 连续硬失败次数
let stopReason = '';
let tally = { act: 0, ok: 0, fail: 0, same: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function log(kind, text) { try { onLog({ kind, text: String(text), step, at: Date.now() }); } catch {} }

/* 可被打断的等待：停手后最多 250ms 就退出，不会卡在长时间的 sleep 里 */
async function nap(ms) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (stopFlag) return;
    await sleep(Math.min(250, end - Date.now()));
  }
}

/* 画面差异：数 64x36 灰度格里"真的变了"的格数（sig 来自抓帧页在**像素**上算的指纹）。
   两个坑都实测过：
   - 不能对 jpeg 字节做哈希：同一静止画面两次编码的字节都不同，会误判成 89% 巨变；
   - 网格不能太粗：16x9 时"白底上又开一个白窗口"整屏 0 格变化，完全看不见，64x36 才看得到。
   单格灰度差 >15 才算变了（静止画面实测最大只有 7，抖动不会误报）。 */
function cellsChanged(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let changed = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.substr(i, 2), 16) || 0;
    const y = parseInt(b.substr(i, 2), 16) || 0;
    if (Math.abs(x - y) > 15) changed++;
  }
  return changed;
}

/* 抓帧：抖一下不算失败，重试 3 次再放弃 */
async function grabFrameSafe() {
  for (let i = 1; i <= 3; i++) {
    try {
      const f = await screenstream.grabFrame();
      if (f && f.dataUrl) return f;
    } catch {}
    if (i < 3) { log('wait', '抓不到屏幕，重试 ' + i + '/3…'); await nap(400 * i); }
  }
  return null;
}

/* 视觉判断：网络抖动/限流很常见，退避重试 3 次 */
async function askVision(prompt, dataUrl) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const t = await vision.describe(config.load(), dataUrl, prompt, 'low');
      if (t && t.trim()) return t;
      lastErr = new Error('模型返回空');
    } catch (e) { lastErr = e; }
    if (i < 3) {
      log('wait', '视觉调用失败（' + String((lastErr && lastErr.message) || '').slice(0, 70) + '），重试 ' + i + '/3…');
      await nap(900 * i);
    }
  }
  throw lastErr || new Error('视觉调用失败');
}

function trimRecent() { if (recent.length > 8) recent = recent.slice(-8); }

/* 提示词 = 任务 + 最近几步的实况 + 针对性提醒 + 协议 */
function buildPrompt() {
  let ctx = '';
  if (recent.length) {
    ctx = '\n\n【你最近几步的实况（别重复无效的操作）】\n'
      + recent.slice(-6).map((r, i) =>
        (i + 1) + '. 看到：' + r.saw + (r.did ? ' ｜ 做了：' + r.did : '') + (r.effect ? ' ｜ 画面：' + r.effect : '')
      ).join('\n');
  }
  let hint = '';
  if (recent.length) {
    const last = recent[recent.length - 1];
    if (last.effect === '没有变化') {
      hint += '\n【提醒】上一次操作后画面**毫无变化** —— 说明它没生效。这一轮换一种做法：换坐标、换按键、先关掉遮挡的弹窗、或者等加载完再动，别再重复同一个操作。';
    } else if (last.effect) {
      hint += '\n【提醒】上一次操作**起效了**（画面有变化），接着往目标推进。';
    }
  }
  if (repeatAct >= 2) hint += '\n【提醒】同一个操作已经连续做了 ' + (repeatAct + 1) + ' 次，明显卡住了：换成完全不同的思路。';
  return '【任务】' + opts.task + ctx
    + '\n\n（这是第 ' + step + ' 步，最多 ' + opts.maxSteps + ' 步）' + hint + PROTOCOL;
}

function status() {
  return { running, step, task: opts.task, dryRun: opts.dryRun, maxSteps: opts.maxSteps, stopReason, tally: Object.assign({}, tally) };
}

function init(o) {
  if (o && o.onLog) onLog = o.onLog;
  if (o && o.onStop) onStop = o.onStop;
  if (o && o.onStart) onStart = o.onStart;
  if (o && o.onFinish) onFinish = o.onFinish;
}

async function start(o) {
  if (running) return { ok: false, error: '游戏助手已经在跑了' };
  const cfg = config.load();
  const task = String((o && o.task) || '').trim();
  if (!task) return { ok: false, error: '请先写清楚要做什么（游戏名 + 目标 + 策略）' };
  if (!cfg.visionEnabled) return { ok: false, error: '游戏助手需要视觉模型：请先在设置（⚙️）里勾选「启用视觉模型看画面」' };
  if (!assistant.allowed(cfg.assistant, 'click')) return { ok: false, error: '需要把 AI 助手权限开到「完全权限」（游戏助手要操作鼠标）' };

  opts = {
    task,
    intervalMs: clamp(Number((o && o.intervalMs) || cfg.gameIntervalMs || 3500), 1200, 15000),
    actionWaitMs: clamp(Number((o && o.actionWaitMs) || cfg.gameActionWaitMs || 1200), 300, 5000),
    maxSteps: clamp(Number((o && o.maxSteps) || cfg.gameMaxSteps || 60), 1, 300),
    dryRun: !!(o && o.dryRun),
  };
  running = true; stopFlag = false; step = 0;
  recent = []; lastAct = ''; repeatAct = 0; errStreak = 0; stopReason = '';
  tally = { act: 0, ok: 0, fail: 0, same: 0 };

  log('info', '🎮 启动（间隔 ' + (opts.intervalMs / 1000) + 's，最多 ' + opts.maxSteps + ' 步）'
    + (opts.dryRun ? '【试运行：只看不动手】' : ''));
  log('info', '任务：' + task.slice(0, 140));
  try { onStart(); } catch {}

  loop().catch((e) => log('err', '循环异常：' + ((e && e.message) || e))).finally(() => {
    running = false;
    const summary = '🛑 收手了（共 ' + step + ' 步'
      + (tally.act ? '，操作 ' + tally.act + ' 次（成功 ' + tally.ok + ' / 失败 ' + tally.fail + '）' : '')
      + '）：' + (stopReason || '已结束');
    log('info', summary);
    try { onStop(); } catch {}
    try { onFinish({ step, tally: Object.assign({}, tally), stopReason, summary, task: opts.task, dryRun: opts.dryRun }); } catch {}
  });
  return { ok: true };
}

function stop() {
  if (!running) return { ok: true, already: true };
  stopFlag = true;
  log('info', '收到停止指令，正在收尾…');
  return { ok: true };
}

async function loop() {
  while (running && !stopFlag && step < opts.maxSteps) {
    step++;

    /* 1) 看：抓帧（含重试） */
    const frame = await grabFrameSafe();
    if (!frame) { stopReason = '连续抓不到屏幕'; break; }
    const sig = frame.sig || '';

    /* 2) 判断：视觉模型看局面 + 想下一步（含退避重试） */
    let text = '';
    try {
      text = await askVision(buildPrompt(), frame.dataUrl);
    } catch (e) {
      errStreak++;
      log('err', '视觉调用连续失败：' + String((e && e.message) || e).slice(0, 140));
      if (errStreak >= 3) { stopReason = '视觉模型连续不可用（检查网络/API Key）'; break; }
      await nap(opts.intervalMs);
      continue;
    }
    errStreak = 0;

    const saw = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    log('see', '👁 ' + text.trim());

    // 兼容模型把结束写成 "DONE" 或 "ACTION: DONE"（实测它经常会带上 ACTION 前缀）
    if (/(^|\n)[ \t]*(ACTION[ \t]*[:：][ \t]*)?DONE[ \t]*($|\n)/i.test(text)) {
      stopReason = '模型判断目标已完成';
      log('info', '✅ ' + stopReason);
      break;
    }

    const m = text.match(/ACTION\s*[:：]\s*([a-z_]+)\s*\|\s*(.+)/i);
    if (!m) {
      log('wait', '这一步没有给出动作，等下一次观察');
      recent.push({ saw, did: '', effect: '' }); trimRecent();
      await nap(opts.intervalMs);
      continue;
    }

    /* 3) 做：执行一个动作 */
    const act = { tool: m[1].trim().toLowerCase(), arg: m[2].trim() };
    const key = act.tool + '|' + act.arg;
    repeatAct = (key === lastAct) ? repeatAct + 1 : 0;
    lastAct = key;

    const cfgNow = config.load();
    if (!assistant.TOOL_TIER[act.tool] || !assistant.allowed(cfgNow.assistant, act.tool)) {
      log('err', '动作不被允许：' + act.tool + '（检查 AI 助手权限档）');
      recent.push({ saw, did: act.tool + '（被权限拦下）', effect: '' }); trimRecent();
      await nap(opts.intervalMs);
      continue;
    }
    if (opts.dryRun) {
      log('act', '（试运行）本应执行：' + act.tool + ' ' + act.arg);
      recent.push({ saw, did: act.tool + ' ' + act.arg + '（试运行，未真的执行）', effect: '' }); trimRecent();
      await nap(opts.intervalMs);
      continue;
    }

    let did = act.tool + ' ' + act.arg;
    try {
      const r = await assistant.run(act.tool, act.arg);
      tally.act++; tally.ok++;
      log('act', '🖱 执行 ' + act.tool + ' ' + act.arg + ' → ' + String((r && r.text) || r).slice(0, 100));
    } catch (e) {
      tally.act++; tally.fail++;
      did += '（失败：' + String((e && e.message) || e).slice(0, 60) + '）';
      log('err', '执行失败：' + ((e && e.message) || e));
    }

    /* 4) 回看：动作到底生效没有（这是决策质量的来源） */
    await nap(opts.actionWaitMs);
    let effect = '';
    const f2 = await grabFrameSafe();
    if (f2 && f2.sig && sig) {
      const cells = cellsChanged(sig, f2.sig);
      effect = cells <= 0 ? '没有变化' : ('有变化（' + cells + ' 处变了）');
      // 算「连续」多少次没变化：中间只要变过一次就清零，否则偶发的静止会累加成误判
      if (effect === '没有变化') tally.same++; else tally.same = 0;
    }
    recent.push({ saw, did, effect }); trimRecent();

    /* 5) 容错：明显在死磕就别磕了 */
    if (effect === '没有变化' && repeatAct >= 3) {
      stopReason = '同一个操作连续 ' + (repeatAct + 1) + ' 次都没让画面变化，判定卡住';
      log('err', '⛔ ' + stopReason + '，自动收手'); break;
    }
    if (tally.same >= 12) { stopReason = '连续 ' + tally.same + ' 次操作画面都没变化，判定在做无效操作'; log('err', '⛔ ' + stopReason + '，自动收手'); break; }

    await nap(opts.intervalMs);
  }

  if (!stopReason) {
    if (step >= opts.maxSteps) stopReason = '到了步数上限（' + opts.maxSteps + '）';
    else if (stopFlag) stopReason = '用户让它停下';
    else stopReason = '已结束';
  }
}

module.exports = { init, start, stop, status };
