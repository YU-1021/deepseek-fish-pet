/* 「主人正在用鼠标吗」检测 —— 她控制光标时，主人一动就让位、松手再继续
 *
 * 需求场景：打游戏 / 看视频时她替我操作鼠标，但我想自己接管时，
 *   我一动鼠标她就该**立刻停手**，等我松手（一段时间没动）再自动继续。
 *
 * 实现：主进程按固定间隔读**全局光标位置**（Electron 的 screen.getCursorScreenPoint）。
 *   她自己在动鼠标时会用 notePetMove() 登记"预期落点"，并连带登记一小段容忍半径。
 *   于是判定很简单：
 *     光标位置变了，但既不在我的预期落点附近、也不是我刚放下的位置 → 是主人在动 → 让位。
 *   最后一次"主人活动"距今超过 calmMs → 认为主人松手了 → 继续。
 *
 * 为什么不用 GetAsyncKeyState 去读鼠标按键：Electron 侧拿不到（要原生扩展或再 spawn 一个
 *   PowerShell，每 50ms 一次太重）。而"按鼠标"几乎总伴随位移，用位移做代理足够，
 *   而且零额外依赖。代价：**完全不动、只按住左键**这种情况检测不到（已在文档里写明）。
 *
 * 生命周期：不用手动管理 —— notePetMove() 会幂等启动轮询，连续 petIdleStopMs 没有她的动作
 *   就自己停掉（不打游戏时零开销）。
 */
const { screen } = require('electron');

const DEFAULTS = {
  enabled: true,        // 总开关
  pollMs: 50,           // 轮询间隔
  movePx: 6,            // 单次位移超过多少像素算"动过"
  calmMs: 3000,         // 主人多久没动算"松手了"（用户要求 3 秒）
  expectPx: 40,         // 她的预期落点容忍半径（鼠标加速/取整会带来小偏差）
  petIdleStopMs: 10000, // 她这么久没动作就停掉轮询
};

let P = Object.assign({}, DEFAULTS);
let timer = null;
let lastPos = null;
let lastUserAt = 0;
let lastPetAt = 0;
let expected = null;      // { x, y, at }
let stats = { polls: 0, userMoves: 0, petMoves: 0, pauses: 0, pausedMs: 0 };

/* 光标来源可以替换。
 * 为什么需要：真实光标**没法在测试里控制** —— 机器的物理鼠标每秒发 125~1000 次事件，
 *   测试刚 SetCursorPos 完，1ms 后读回来可能已经被真人挪走了（实测就是如此，
 *   目标 (400,300) 读回 (729,590)，而且同一目标三次读数都不一致）。
 *   所以把"读光标"抽成可注入的源：生产用 Electron 的 screen.getCursorScreenPoint，
 *   测试注入一个假光标序列，判定逻辑就能被确定性地验证。 */
const realCursor = () => { try { return screen.getCursorScreenPoint(); } catch { return null; } };
let getCursor = realCursor;
function setCursorSource(fn) { getCursor = (typeof fn === 'function') ? fn : realCursor; }

function setParams(o) { P = Object.assign({}, DEFAULTS, o || {}); return P; }
const params = () => Object.assign({}, P);

function nowMs() { return Date.now(); }

/* 她自己的落点：登记一下，避免把自己动的当成主人动的 */
function notePetMove(screenX, screenY) {
  lastPetAt = nowMs();
  expected = { x: Number(screenX) || 0, y: Number(screenY) || 0, at: lastPetAt };
  stats.petMoves++;
  start();
}

/* 模型坐标（抓帧尺寸，默认 1920x1080）→ 屏幕 DIP 坐标，供 notePetMove 使用 */
function fromModel(x, y) {
  const d = screen.getPrimaryDisplay();
  /* 和 input.js / 抓帧保持同一个坐标空间（默认 1920x1080，可配）。
     这里直接读 config 而不 require('./input')：input.js 反过来依赖本模块做落点登记，
     互相 require 会成环。 */
  let W = 1920, H = 1080;
  try {
    const c = require('./config').load();
    if (Number(c.screenCaptureWidth) > 0) W = Number(c.screenCaptureWidth);
    if (Number(c.screenCaptureHeight) > 0) H = Number(c.screenCaptureHeight);
  } catch {}
  return { x: (Number(x) || 0) / W * d.size.width, y: (Number(y) || 0) / H * d.size.height };
}
function notePetMoveModel(x, y) { const p = fromModel(x, y); return notePetMove(p.x, p.y); }

function tick() {
  stats.polls++;
  const cur = getCursor();
  if (!cur) return;
  if (lastPos) {
    const dx = cur.x - lastPos.x, dy = cur.y - lastPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= P.movePx) {
      /* 是不是我刚动过的？在预期落点附近就算我的（鼠标加速/取整会有偏差） */
      const nearExpected = expected && nowMs() - expected.at < 3000
        && Math.abs(cur.x - expected.x) <= P.expectPx && Math.abs(cur.y - expected.y) <= P.expectPx;
      if (nearExpected) { stats.petMoves++; }
      else { lastUserAt = nowMs(); stats.userMoves++; }
    }
  }
  lastPos = { x: cur.x, y: cur.y };
  /* 她长时间没动作 → 停掉轮询，平时零开销 */
  if (timer && nowMs() - lastPetAt > P.petIdleStopMs) stop();
}

function start() {
  if (!P.enabled || timer) return;
  lastPos = null;
  lastPos = getCursor();
  timer = setInterval(tick, Math.max(20, Number(P.pollMs) || 50));
  try { timer.unref && timer.unref(); } catch {}
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* 主人现在正在用鼠标吗 */
function isUserActive() {
  if (!P.enabled) return false;
  return (nowMs() - lastUserAt) < (Number(P.calmMs) || 1200);
}

/* 等主人松手；返回等了多久（毫秒）。超时也返回（不无限等，避免任务卡死） */
function waitUntilFree(timeoutMs) {
  if (!P.enabled || !isUserActive()) return Promise.resolve(0);
  const t0 = nowMs();
  const cap = Math.max(1000, Number(timeoutMs) || 120000);
  stats.pauses++;
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const waited = nowMs() - t0;
      if (!isUserActive() || waited > cap) {
        clearInterval(iv);
        if (waited > cap) stats.pausedMs += waited;
        resolve(waited);
      }
    }, Math.max(30, Number(P.pollMs) || 50));
  });
}

function state() {
  return {
    enabled: P.enabled, running: !!timer, userActive: isUserActive(),
    msSinceUser: lastUserAt ? nowMs() - lastUserAt : null,
    msSincePet: lastPetAt ? nowMs() - lastPetAt : null,
    params: params(), stats: Object.assign({}, stats),
  };
}
function resetStats() { stats = { polls: 0, userMoves: 0, petMoves: 0, pauses: 0, pausedMs: 0 }; }

module.exports = {
  DEFAULTS, setParams, params, notePetMove, notePetMoveModel, fromModel,
  start, stop, isUserActive, waitUntilFree, state, resetStats,
  setCursorSource, realCursor,
};
