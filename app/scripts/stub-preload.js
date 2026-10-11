/* 最小桩：让 chat.js 能在没有主进程后端的情况下跑起来（只为了看界面/抓 JS 报错）
 * 键要用 **preload 的方法名**（configGet），不是 IPC 频道名（config:get）。
 * 关键几个调用返回"像真的"的值，否则 chat.js 会停在「绑定 API」面板，看不到主界面。 */
const REAL = {
  configGet: { apiKey: 'stub-key', ttsEnabled: true, replyLanguage: 'en', vocabLevel: 'high', assistant: 'full', petSkin: 'dafeiyu' },
  chatLog: { entries: [] },
  vocabList: [],
  speakTrend: { total: 0, days: [], avg: 0, best: 0 },
  speakAutoAdd: { on: true },
  ttsVoices: { voices: [], styles: [] },
  memoryInfo: { id: 'stub', turns: 0 },
  asrStatus: { engine: 'whisper', hasModel: true, model: 'base.en', binary: true },
};
const assistantStub = {
  mode: 'allow',
  calls: [],
  reset(mode) { this.mode = mode || 'allow'; this.calls = []; },
};
window.__assistantStub = assistantStub;
window.petAPI = new Proxy({}, {
  get: (_t, name) => (...args) => {
    const k = String(name);
    if (k === 'assistantInspect') {
      assistantStub.calls.push({ method: 'inspect', value: args[0] });
      if (assistantStub.mode === 'deny') return Promise.resolve({ ok: false, decision: 'deny', reason: 'permission-denied', risk: 'forbidden' });
      if (assistantStub.mode === 'confirm') return Promise.resolve({ ok: true, decision: 'confirm', reason: 'destructive-action', risk: 'destructive' });
      return Promise.resolve({ ok: true, decision: 'allow', reason: 'tier-allowed', risk: 'read' });
    }
    if (k === 'assistantApprove') {
      assistantStub.calls.push({ method: 'approve', value: args[0] });
      return Promise.resolve({ ok: true, decision: 'confirm', token: 'one-use-test-token' });
    }
    if (k === 'assistantRun') {
      assistantStub.calls.push({ method: 'run', value: args[0] });
      return Promise.resolve({ ok: true, result: 'stub executed' });
    }
    if (k in REAL) return Promise.resolve(REAL[k]);
    if (/^on[A-Z]/.test(k)) return undefined;            // 事件订阅：调用方都有 if 保护
    return Promise.resolve({});
  },
});
