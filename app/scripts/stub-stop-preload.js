/* stub-stop-preload.js —— 给 probe-stop.js 用的桩（**只为验证"停止"那条真实代码路径**）
 *
 * ★它演的是**主进程**（照 main.js 的契约 ✓），被验证的是**真实的 renderer 代码**：
 *   chat.html + chat.js + loop.js（一字未改 ✓ 就是她跑的那份 ✓）。
 *
 * 【契约（与 main.js 对齐 ✓）】
 *   · chatSend    ：返回一条**带 ACTION 的回复** → 触发多步任务（就是"长任务"✓）
 *   · assistantRun：每次调用记一笔 ✓（这就是"执行了一个动作"的**可数证据**✓）；
 *                   带一点延时（模拟真实点击 700ms ✓）→ 才有"跑到一半按停止"的窗口 ✓；
 *                   ★停止之后一律拒绝（与 main.js 的 stopState 闸门同语义 ✓）★
 *   · chatContinue：返回**下一步 ACTION** → 不加干预时这个链会一直跑 ✔（所以"它停了"是可证的 ✓）
 *   · statsTask   ：把 stopReason 收下来 ✓（renderer 的 reportTask 就是往这里报 ✓）
 *   · onTaskStop  ：把收到的事件转给 renderer 的处理器 ✓（快捷键那条路走这里 ✓）
 */
const { ipcRenderer } = require('electron');

const S = { stopped: false, via: '', runs: 0, stopReqs: [], tasks: [], continues: 0, timers: [] };
window.__probe = S;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ★assistant:run 的闸门★ —— 与 main.js 里那段同语义：
   停止之后不再执行任何动作 ✓（renderer 若漏判，这一层会拦住 ✓） */
async function assistantRun(a) {
  if (S.stopped) {
    return { ok: false, stopped: true, result: '⏹ 主人已经按了停止 —— 这个动作我没有执行 ✓' };
  }
  S.runs++;
  await sleep(700);
  /* 不回 action → 让 renderer 去问 chatContinue（真实多步任务的走法 ✓） */
  return { ok: true, result: '✅ 已执行 ' + (a && a.tool) + '（第 ' + S.runs + ' 次）' };
}

let actionSeq = 0;
function nextAction() { actionSeq++; return { tool: 'click', arg: (100 + actionSeq) + ',' + (200 + actionSeq) }; }

const REAL = {
  configGet: { apiKey: 'stub-key', ttsEnabled: false, replyLanguage: 'en', vocabLevel: 'high', assistant: 'full', petSkin: 'dafeiyu' },
  chatLog: { entries: [] },
  vocabList: [],
  speakTrend: { total: 0, days: [], avg: 0, best: 0 },
  speakAutoAdd: { on: false },
  ttsVoices: { voices: [], styles: [] },
  asrStatus: { engine: 'whisper', hasModel: true, model: 'base.en', binary: true },
  statsGet: { stepBudget: 30 },
  chatSend: async () => ({ en: 'On it, Master.', zh: '这就去，主人。', words: [], choices: [], action: nextAction() }),
  chatContinue: async () => {
    S.continues++;
    if (S.stopped) return { en: 'Stopped.', zh: '⏹ 已停止 ✓', words: [], choices: [], stopped: true, action: null };
    await sleep(120);
    return { en: 'Next step.', zh: '下一步。', words: [], choices: [], action: nextAction() };
  },
  assistantRun,
  statsTask: async (o) => { S.tasks.push(o); return { ok: true }; },
  taskStop: async (via) => { S.stopReqs.push(via || '停止按钮'); S.stopped = true; return { ok: true }; },
  taskStopState: async () => ({ stopped: S.stopped, via: S.via, hotkey: 'Control+Alt+S' }),
  ttsSpeak: async () => ({ ok: false, error: 'stub: 不合成' }),
};

window.petAPI = new Proxy({}, {
  get: (_t, name) => {
    const k = String(name);
    if (k === 'onTaskStop') return (cb) => { ipcRenderer.on('probe:stop', (_e, d) => cb(d)); };
    /* ★注意：REAL 里的值**两种都有**★ —— 有的直接是值（configGet 是个对象 ✓），
       有的要每次调用现算（chatSend 每次都要给下一条 ACTION ✓）。
       第一版统一当函数调 ✗ → `REAL[k] is not a function` → chat.js 的初始化直接断了 ✗
       → 任务根本没起来（runs=0 ✓）→ 看着像"停止很干净"，其实什么都没跑 ✗。
       ★这就是"没有对照组的实验不算实验"✗→✓★（探针里那条对照组断言把它抓出来了 ✓）。 */
    if (k in REAL) {
      const v = REAL[k];
      if (typeof v === 'function') return (...args) => Promise.resolve(v(...(args || [])));
      return () => Promise.resolve(v);
    }
    if (/^on[A-Z]/.test(k)) return undefined;
    return (...args) => Promise.resolve({});
  },
});
