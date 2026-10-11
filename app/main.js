const { app, BrowserWindow, ipcMain, Menu, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
/* clock 必须最先加载：它会劫持 Date.now()，后面的模块读到的才是平移过的时间 */
const clock = require('./src/clock');
const config = require('./src/config');
const llm = require('./src/llm');
const memory = require('./src/memory');
const mood = require('./src/mood');
const assistant = require('./src/assistant');
const web = require('./src/web');
const dsh = require('./src/dsh');
const vocab = require('./src/vocab');
const tts = require('./src/tts');
const asr = require('./src/asr');
const chatlog = require('./src/chatlog');
const screenstream = require('./src/screenstream');
const gameagent = require('./src/gameagent');
const skills = require('./src/skills');
const style = require('./src/style');
const projects = require('./src/projects');
const stats = require('./src/stats');
const persona = require('./src/persona');
const personatags = require('./src/personatags');
const petactions = require('./src/petactions');
const speak = require('./src/speak');
const testlog = require('./src/testlog');const userinput = require('./src/userinput');
const input = require('./src/input');
const { createPromptBuilder } = require('./src/prompt-builder');
const { classifyAction } = require('./src/permission-policy');
const { createActionAuthority } = require('./src/action-authority');
const { createActionAudit } = require('./src/action-audit');
const { createActionExecutor } = require('./src/action-executor');

const dbg = (msg) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  /* 结构化日志镜像一份：debug.log 是自由文本、几万行里翻不出规律，
     testlog.jsonl 能直接按模块/事件聚合，这是"测完找异常数据"的入口。
     只记 dbg 的第一段（像 [asr] / [stats] / [pron] 这种前缀）当模块名 */
  try {
    const s = String(msg);
    const m = s.match(/^\[([a-z0-9_]+)\]\s*(.*)$/i);
    testlog.log(m ? m[1] : 'main', 'dbg', m ? { v: m[2] } : { v: s });
  } catch {}
};

let petWin = null;
let chatWin = null;
let didSummarize = false;

/* ---------------- 自动埋点（测试用，见 src/testlog.js） ----------------
 * 给每个模块的导出函数套一层，自动记录 模块/函数/耗时/参数摘要/结果摘要/错误。
 * 这样"每个模块都有日志"不用去改 25 个文件，也不会漏。
 * 注意：**不能埋 testlog 自己**（log 里再调 log 会无限递归）。 */
try {
  const bus = require('./src/bus');
  const store = require('./src/store');
  testlog.instrumentAll({
    llm, memory, mood, assistant, web, dsh, vocab, tts, asr, chatlog,
    screenstream, gameagent, skills, style, projects, stats, persona,
    personatags, petactions, speak, store,
  }, {
    /* tokens 在裁剪历史时每轮调几十次，纯计算、没有可分析的信息量 */
    tokens: { skip: ['est', 'clip', 'estMessages'] },
    /* 这两个是"改状态"的核心：记下调用**前**的值，才能看出"扣了多少 / 涨了多少"。
       （startupDecay 没有参数，不记 before 的话日志里全是 mood=0，查不出原因。） */
    mood: {
      before: {
        adjust: () => { const m = mood.load(); return { affection: m.affection, mood: m.mood }; },
        startupDecay: () => { const m = mood.load(); return { affection: m.affection, mood: m.mood, lastSeen: m.lastSeen }; },
      },
    },
    stats: {
      before: {
        nudge: () => { const a = stats.all(); return { dependency: a.dependency, iq: a.iq, diligence: a.diligence }; },
        rebaseline: () => stats.all(),
      },
    },
  });
  for (const ev of ['store:error', 'stats:changed', 'stats:rebaseline', 'stats:judged',
    'memory:changed', 'memory:permanent', 'memory:skillmem', 'session:start', 'session:end', 'session:turn']) {
    bus.on(ev, (d) => { try { testlog.log('bus', ev, (d && typeof d === 'object') ? d : { v: d }); } catch {} });
  }
  testlog.log('main', 'boot', { ver: app.getVersion(), clockOffsetMs: clock.offset(), day: clock.day() });
} catch (e) { dbg('[testlog] 埋点失败（不影响运行）: ' + ((e && e.message) || e)); }
let allowChatClose = false;

const posFile = () => path.join(app.getPath('userData'), 'position.json');
/* 读窗口位置，并**夹进可见工作区**。
 * 为什么必须夹：用户实际遇到过 —— 位置被存成 {"x":-107,"y":588}，
 * 于是她的窗口有 107px 在屏幕左边外面、立绘基本看不到，
 * 而用户又没法拖一个看不见的窗口，就卡在"她不见了"的状态，
 * 只能手工去改 position.json 才救回来。
 * 这里按主显示器的可用区（去掉任务栏）把它拉回屏幕内，保证永远看得见。
 * 注：窗口尺寸此时还不知道，所以只保证左上角落在工作区内、
 * 并留一点余量（不让它完全贴边）。 */
const loadPosition = () => {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(posFile(), 'utf8')); } catch { return null; }
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;   // 不含任务栏
    const x = Math.max(0, Math.min(wa.width - 80, Math.round(p.x)));
    const y = Math.max(0, Math.min(wa.height - 60, Math.round(p.y)));
    if (x !== Math.round(p.x) || y !== Math.round(p.y)) {
      try { fs.writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {}
      return { x, y, clampedFrom: { x: Math.round(p.x), y: Math.round(p.y) } };
    }
    return { x, y };
  } catch { return { x: Math.round(p.x), y: Math.round(p.y) }; }
};
const savePosition = (x, y) => { try { fs.writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {} };
const loadPersona = () => persona.load();   // 人设现在放在 userData（AI 要能改它）

/* 记忆系统：依赖注入（记忆层不硬依赖 llm/config/persona，方便以后替换或单测） */
memory.init({ llm, config, persona: loadPersona, skillCatalog: () => skills.catalog() });
/* 存储层出错（读坏文件、写失败）必须留痕：以前这些全是静默的，出事了完全查不到 */
memory.bus.on('store:error', (e) => dbg('[store] ' + ((e && e.msg) || '')));

function writeDestination(action) {
  const tool = String(action && action.tool || '');
  const raw = String(action && action.arg || '');
  const sep = raw.indexOf('||');
  const head = (sep >= 0 ? raw.slice(0, sep) : raw).trim().replace(/^["']|["']$/g, '');
  try {
    if (tool === 'write_file') return path.isAbsolute(head) ? path.resolve(head) : '';
    if (tool === 'proj_write') return projects.safePath(head);
    if (tool === 'skill_write') return skills.safePath(head);
    if (tool === 'flow_save') {
      const flows = require('./src/flows');
      const name = flows.safeFlowName(head);
      return name ? path.join(flows.flowsDir(app.getPath('userData')), name + '.json') : '';
    }
  } catch {}
  return '';
}

async function assistantActionFacts(action) {
  const state = userinput.state();
  const destination = writeDestination(action);
  const tool = String(action && action.tool || '');
  return {
    destinationExists: !!(destination && fs.existsSync(destination)),
    focusVerified: (tool === 'type' || tool === 'key') ? await assistant.focusVerified() : false,
    userActive: !!state.userActive,
    userEpoch: Number.isInteger(state.userEpoch) ? state.userEpoch : 0,
  };
}

const actionAuthority = createActionAuthority({ now: Date.now });
const actionAudit = createActionAudit({ dir: app.getPath('userData'), now: Date.now });
const actionExecutor = createActionExecutor({
  allowed: (tier, tool) => assistant.allowed(tier, tool),
  classifyAction,
  authority: actionAuthority,
  audit: actionAudit,
  getFacts: assistantActionFacts,
  waitUntilFree: (timeoutMs) => userinput.waitUntilFree(timeoutMs),
  runTool: (action) => runToolWithWindows(action),
  now: Date.now,
});

/* 【立绘窗隐藏的看门狗】用户报"启动不了桌宠" —— 实际是**她一直在跑、但立绘窗被藏起来了**：
 * 日志里 `visibility {"hidden":true}` / `false` 交替出现，最后一次停在 true。
 * 根因：所有"临时藏一下"的地方（看屏幕时藏立绘、把窗口让给点击目标、游戏托管时收起）
 * 都是"藏 → setTimeout 放回"，**一旦在这两步之间被打断（热重载 / 异常 / 进程被杀），
 * 窗口就永远藏着** —— 用户看到的就是"双击没反应、桌宠不见了"，而且单实例锁还被这个
 * 活着的实例占着，所以重新启动也没用。
 * 做法：每次隐藏都登记时间戳；看门狗每 3 秒查一次，只要**没有隐藏操作正在进行**
 * （最近 4 秒内没登记过）却还是不可见，就无条件 show 回来。
 * 为什么敢无条件 show：这个应用里**没有**"用户主动隐藏桌宠"的功能，隐藏都是内部临时行为。
 * 例外：游戏托管（gameagent）会长时间收起桌宠 —— 那种情况用 petHideSticky 标记，
 * 看门狗不去抢（否则会把桌宠塞回游戏画面上挡住点击）。 */
let lastPetHideAt = 0;
let petHideSticky = false;
function markPetHidden(why) {
  lastPetHideAt = Date.now();
  try { dbg('[pet] 临时隐藏立绘窗（' + (why || '') + '）'); } catch {}
}
function startPetVisibilityWatchdog() {
  setInterval(() => {
    try {
      if (!petWin || petWin.isDestroyed()) return;
      /* 【每次都重申置顶】用户报"我一切到别的界面，桌宠就不见了、退到后台了，我想办公时看见"。
         根因是我加的 clearAllTop() 用 Win32 抹掉了桌宠自己的 WS_EX_TOPMOST，而 Electron
         并不知道（它以为 alwaysOnTop 还是 true），所以不会重新置顶。已让 clearAllTop 排除
         自己的 pid；这里再每 3 秒重申一次当保险 —— Electron 对"已经置顶"的重复调用是 no-op，
         不会闪、也没有副作用。 */
      try { petWin.setAlwaysOnTop(true, 'screen-saver'); } catch {}
      if (petWin.isVisible()) return;
      if (petHideSticky) return;                          // 游戏托管期间收起，是正常状态
      if (Date.now() - lastPetHideAt < 4000) return;       // 正常的临时隐藏，别抢
      petWin.show();
      try { petWin.setAlwaysOnTop(true, 'screen-saver'); } catch {}
      dbg('[pet] 看门狗：立绘窗被藏太久（上次隐藏于 ' + Math.round((Date.now() - lastPetHideAt) / 1000) + ' 秒前），已强制显示回来');
    } catch {}
  }, 3000);
}

function readPromptOverride() {
  try {
    const file = path.join(app.getPath('userData'), 'prompts', 'override.md');
    if (!fs.existsSync(file)) return '';
    return String(fs.readFileSync(file, 'utf8') || '').trim();
  } catch { return ''; }
}

const promptBuilder = createPromptBuilder({
  loadPersona,
  loadMood: () => mood.load(),
  getTone: (p) => personatags.toneOf(p),
  getBehaviorSpec: () => stats.behaviorSpec(),
  buildMemoryContext: () => memory.buildContext(),
  getPracticeWords: (limit) => vocab.toPractice(limit),
  getSkillCatalog: () => skills.catalog(),
  isToolAllowed: (tier, tool) => assistant.allowed(tier, tool),
  getScreenSpace: () => input.space(),
  readPromptOverride,
  log: dbg,
});

function buildSystemPrompt(cfg) { return promptBuilder.buildSystemPrompt(cfg); }
function buildContinuePrompt(cfg) { return promptBuilder.buildContinuePrompt(cfg); }
function buildContinueUserPrompt() { return promptBuilder.buildContinueUserPrompt(); }

async function genReply(cfg, messages, onPartial) {
  let raw;
  if (onPartial && typeof llm.stream === 'function') {
    let sent = false;
    try {
      raw = await llm.stream(cfg, messages, (full) => {
        if (sent) return;
        // EN 行写完（后面跟了换行）就把英文先抛出去，让渲染层提前开始朗读
        const m = full.match(/^EN[:：]\s*([\s\S]+?)\r?\n/);
        if (m && m[1].trim()) { sent = true; onPartial(m[1].trim()); }
      });
    } catch (e) {
      dbg('[llm] stream fail, fallback to non-stream: ' + String((e && e.message) || e));
      raw = await llm.request(cfg, messages);
    }
  } else {
    raw = await llm.request(cfg, messages);
  }
  const reply = llm.parseReply(raw);
  if (!reply.en) reply.en = "Hmm, I'm not sure what to say... n-not that I care!";
  return { reply, raw };
}

function createPet() {
  const saved = loadPosition();
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const opts = {
    width: 380, height: 460,
    transparent: true, frame: false, alwaysOnTop: true, resizable: false,
    hasShadow: false, skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    opts.x = Math.min(Math.max(saved.x, -140), wa.width - 140);
    opts.y = Math.min(Math.max(saved.y, 0), wa.height - 140);
  }
  petWin = new BrowserWindow(opts);
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.on('moved', scheduleSavePos);
  hitInfo = null; hitIgnoring = null; holdInteractive = false;
  startHitLoop();

  petWin.webContents.on('context-menu', () => {
    const isChat = config.load().petMode === 'chat';
    Menu.buildFromTemplate([
      { label: isChat ? '✋ 切到交互模式（点部位出动作）' : '💬 切到聊天模式（可拖拽/可戳）', click: () => {
        const mode = isChat ? 'interact' : 'chat';
        config.save({ petMode: mode });
        dbg('[pet] mode -> ' + mode + ' (menu)');
        if (petWin && !petWin.isDestroyed()) { try { petWin.webContents.send('pet:mode', { mode }); } catch {} }
      } },
      { label: '📁 打开立绘姿态文件夹（丢 PNG 进去即生效）', click: () => {
        const d = petactions.posesDir();
        try { fs.mkdirSync(d, { recursive: true }); } catch {}
        shell.openPath(d).catch(() => {});
      } },
      { label: '🎭 让她重写交互台词（全量）', click: () => {
        refreshPetLines(loadPersona(), true)
          .then((r) => dbg('[petlines] 手动全量重写 -> ' + JSON.stringify(r)))
          .catch((e) => dbg('[petlines] 手动重写失败 ' + ((e && e.message) || e)));
      } },
      { type: 'separator' },
      { label: '🐟 投喂小鱼干', click: () => petWin.webContents.send('pet:feed') },
      { label: '🖐 摸摸头', click: () => petWin.webContents.send('pet:pat') },
      { label: '🎤 麦克风检测', click: () => petWin.webContents.send('pet:miccheck') },
      { type: 'separator' },
      { label: '打开对话', click: () => createChat() },
      { label: '结束本次会话', click: () => { createChat(); setTimeout(() => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('memory:endAsk'); }, 700); } },
      { type: 'separator' },
      { label: '退出桌宠', click: () => app.quit() }
    ]).popup({ window: petWin });
  });
}

/* ---------------- 聊天记录 / 谁在说话 ----------------
   回声问题的根因：回复同时推给桌宠和返回给对话窗，两边各自 TTS 一遍，
   两股音频错开一瞬 → 听起来就是回音。规则改为「谁问的谁出声」。 */
function isFromChat(e) {
  try { return !!(chatWin && !chatWin.isDestroyed() && e && e.sender && e.sender.id === chatWin.webContents.id); } catch { return false; }
}
function sessionId() { try { return memory.session.info().id; } catch { return ''; } }

/* 把一条消息记进"看得见的聊天记录"（最小化/重开还能看到） */
function logTurn(text, reply) {
  const sid = sessionId();
  if (text) chatlog.add(sid, { who: 'me', text });
  if (reply && reply.en) chatlog.add(sid, { who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
}

/* 把桌宠这边主动说的话同步到对话窗（不发声，只显示，保持记录完整） */
function relayToChat(msg) {
  if (!chatWin || chatWin.isDestroyed()) return;
  try { chatWin.webContents.send('chat:log', msg); } catch {}
}

ipcMain.handle('chat:log:all', () => chatlog.all(sessionId()));

function createChat() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.restore(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 500, height: 720, title: '大肥鱼 · 对话', autoHideMenuBar: true,
    backgroundColor: '#f3f6fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('chat:opened');

  // 点 × 默认只是「最小化」，不真的关掉会话；要结束会话请用窗口里的「结束本次会话」
  chatWin.on('close', (e) => {
    if (allowChatClose) return;
    e.preventDefault();
    try { chatWin.minimize(); } catch {}
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('chat:closed');
  });
  chatWin.on('minimize', () => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('chat:closed'); });
  chatWin.on('restore', () => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('chat:opened'); });
  chatWin.on('closed', () => {
    chatWin = null;
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('chat:closed');
  });
}

/* 真正关掉对话窗口（由页面上的「结束本次会话」按钮触发） */
function closeChatForReal() {
  allowChatClose = true;
  if (chatWin && !chatWin.isDestroyed()) chatWin.close();
  allowChatClose = false;
}

/* ---------------- 记忆 ---------------- */
/* 具体实现都在 src/memory/ 下（session / medium / long / permanent / context / jobs）。
   这里只调门面：
     memory.onAppStart()    启动：迁移、恢复草稿、衰减、熔炼日记、晋升、保留策略
     memory.buildContext()  每轮注入的记忆块（顺序固定，利于前缀缓存）
     memory.pickHistory()   历史按 token 预算裁剪 + 老回合压缩
     memory.onTurn()        一轮对话入库（含 compact 精简版）
     memory.onSessionEnd()  收尾：写中期摘要 + 抽永久记忆候选
*/

/* ---------------- IPC ---------------- */
/* 位置保存（拖拽结束、窗口移动后防抖落盘） */
let posSaveTimer = null;
function scheduleSavePos() {
  clearTimeout(posSaveTimer);
  posSaveTimer = setTimeout(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const [x, y] = petWin.getPosition();
    savePosition(x, y);
  }, 400);
}
/* 拖拽：主进程 8ms 自采样定时器 + setBounds 瞬时定位。
 * 渲染层 mousedown 只发 drag-start（开启定时器）、mouseup 发 drag-end（关闭定时器）；
 * 移动由主进程定时器读真实光标坐标完成，不依赖渲染层 mousemove 逐帧触发，
 * 因此移动窗口不会中断 mousemove → 事件断流（拖拽跟不上/延迟）被打破。
 * 定位用 target = dragWin + (cursor - dragAnchor)：坐标公式本身没问题（实测 afterError ≤1px）。
 * 必须用 setBounds 并每 tick 钉死 w/h：本机（125% DPI + 透明窗口）移动窗口时尺寸会随位移
 * 持续变大（width += dx/2），而立绘是 margin:0 auto 居中，窗口一变宽立绘就在窗口内右移
 * → 表现为"拖拽时立绘偏出光标、点一下又弹回"。详见 错题本.md。
 * 保留 1px 死区：125% DPI 下 setBounds/getPosition 有 ±1px 取整误差，若不抑制会产生"按住平移"抖动。
 * 注：当前带诊断日志（[drag-diag]/[hit-diag]/[pointer-diag]），排查用，可随时移除。 */
let dragging = false;
let dragWin = null;      // 按下时窗口位置（锚点）
let dragAnchor = null;   // 按下时光标位置（锚点）
let dragTimer = null;    // 8ms 自采样定时器
const PET_W = 380;       // 桌宠窗口固定宽度（与 createPet / pet:resize 保持一致）
let petH = 196;          // 桌宠窗口期望高度（由 pet:resize 维护，拖拽时钉死防止尺寸累积）

/* ---- 拖拽诊断（临时）---- */
let dragDiagLast = 0;
let dragDiagSeq = 0;

function beginDrag() {
  if (!petWin || petWin.isDestroyed()) return;
  const [wx, wy] = petWin.getPosition();
  const c = screen.getCursorScreenPoint();
  dragWin = { x: wx, y: wy };
  dragAnchor = { x: c.x, y: c.y };
  dragging = true;
  dragDiagLast = 0;
  dragDiagSeq = 0;
  applyIgnore(false, 'drag-start');
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(dragStep, 8);
}
function dragStep() {
  if (!dragging || !petWin || petWin.isDestroyed() || !dragWin || !dragAnchor) return;
  const tickStart = performance.now();
  const gap = dragDiagLast ? tickStart - dragDiagLast : 0;
  dragDiagLast = tickStart;
  dragDiagSeq += 1;

  const c = screen.getCursorScreenPoint();
  const tx = Math.round(dragWin.x + (c.x - dragAnchor.x));
  const ty = Math.round(dragWin.y + (c.y - dragAnchor.y));

  const [beforeX, beforeY] = petWin.getPosition();
  const beforeErrX = tx - beforeX;
  const beforeErrY = ty - beforeY;

  // 1px 死区（保留）：防 DPI 取整抖动
  if (Math.abs(beforeErrX) <= 1 && Math.abs(beforeErrY) <= 1) {
    return;
  }

  /* 用 setBounds 而不是 setPosition：本机实测（125% DPI + 透明窗口）移动窗口时
     尺寸会随位移持续变大（width += dx/2），立绘是 margin:0 auto 居中，
     窗口一变宽立绘就在窗口内右移 → 拖拽时立绘偏出光标。
     每 tick 用固定的 w/h 覆盖即可阻止累积（不能回填当前 bounds，否则会自增）。 */
  petWin.setBounds({ x: tx, y: ty, width: PET_W, height: petH });

  const [afterX, afterY] = petWin.getPosition();
  const afterErrX = tx - afterX;
  const afterErrY = ty - afterY;
  const stepMs = performance.now() - tickStart;

  /* 诊断：sp 记录立绘盒（窗口内偏移/尺寸），用来确认立绘在窗口内没有移位 */
  const sp = hitInfo ? [hitInfo.left, hitInfo.top, hitInfo.width, hitInfo.height] : null;

  if (gap > 40 || Math.abs(afterErrX) > 1 || Math.abs(afterErrY) > 1 || dragDiagSeq % 60 === 0) {
    dbg('[drag-diag] ' + JSON.stringify({ seq: dragDiagSeq, gap: Math.round(gap), step: Math.round(stepMs * 10) / 10, cursor: [c.x, c.y], target: [tx, ty], before: [beforeX, beforeY], beforeError: [beforeErrX, beforeErrY], after: [afterX, afterY], afterError: [afterErrX, afterErrY], sp }));
  }
}
function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragWin = null;
  dragAnchor = null;
  scheduleSavePos();
}
ipcMain.on('drag-start', () => beginDrag());
ipcMain.on('drag-end', () => endDrag());
ipcMain.on('quit', () => app.quit());
/* 语音/识别失败等错误写进 debug.log —— 方便远程收集试用者的现场 */
ipcMain.on('log:error', (_e, m) => dbg('[r] ' + String(m).slice(0, 500)));
ipcMain.on('chat:open', () => createChat());
ipcMain.on('chat:close', () => closeChatForReal());

/* ---------------- 本地语音识别（whisper.cpp，离线） ---------------- */
ipcMain.handle('asr:status', () => asr.status(config.load().asrModel));
ipcMain.handle('asr:download', async (_e, name) => {
  const model = String(name || config.load().asrModel || 'tiny.en');
  const isVad = (model === 'vad');        // VAD 模型不能当成 asrModel 存进去
  const push = (p) => {
    const msg = 'asr:progress';
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send(msg, p);
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send(msg, p);
  };
  try {
    await asr.downloadModel(model, push);
    if (!isVad && model !== config.load().asrModel) config.save({ asrModel: model });
    dbg('[asr] 模型下载完成 ' + model + (isVad ? '（VAD）' : ''));
    return { ok: true, status: asr.status(config.load().asrModel) };
  } catch (e) {
    dbg('[asr] 下载失败 ' + model + ' : ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});
/* 音标补齐：给一批词问模型要音标，写进缓存后推给窗口。
   同一批词给过一次就永远命中缓存 —— 所以只有用户真正说过的"新词"才会花这一次调用。 */
async function fillIpa(words) {
  const cfg = config.load();
  const miss = speak.ipaMissing(words);
  if (!cfg.apiKey || !miss.length) return null;
  const raw = await llm.request(cfg, [
    { role: 'system', content: speak.buildIpaPrompt(miss.slice(0, 40)) },
    { role: 'user', content: '请输出 JSON。' },
  ]);
  const o = speak.parseJson(raw);
  if (!o) return null;
  const n = speak.ipaPut(o);
  if (n) dbg('[speak] 音标补齐 ' + n + ' 条（本次新词：' + miss.slice(0, 8).join(',') + '）');
  const payload = { ipa: speak.ipaGet(words) };
  for (const w of [petWin, chatWin]) {
    if (w && !w.isDestroyed()) { try { w.webContents.send('speak:ipa', payload); } catch {} }
  }
  return n;
}

ipcMain.handle('asr:transcribe', async (_e, buf) => {
  const cfg = config.load();
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (!b || b.length < 1000) return { ok: true, text: '' };
    const r = await asr.transcribeDetailed(b, cfg.asrModel || 'base.en', {
      vad: cfg.asrVad !== false,
      vadThreshold: cfg.asrVadThreshold,
    });
    const text = r.text;
    // 只有非语音标注（哼唱/音乐/静音）没有实际内容的话直接丢掉，别白花一次对话
    if (!/[a-z]{2}/i.test(text)) return { ok: true, text: '' };
    /* 逐词清晰度：whisper token 概率的代理，**不是音素级发音评测**（见 speak.js 注释） */
    const score = speak.scoreWords(r.words, cfg);
    const ipa = speak.ipaGet(score.words.map((x) => x.w));
    fillIpa(score.words.map((x) => x.w)).catch(() => {});     // 后台补，不拖慢识别
    /* 自动收生词：读得含糊(poor)的词直接进生词本（config.vocabAutoAdd=false 可关） */
    let autoAdded = [];
    if (cfg.vocabAutoAdd !== false) {
      autoAdded = score.words.filter((x) => x.band === 'poor').map((x) => x.w);
      if (autoAdded.length) {
        for (const w of autoAdded) {
          const i = ipa[speak.keyOf(w)] || {};
          try { vocab.add({ w, ipa: i.ipa || '', zh: i.zh || '' }); } catch {}
        }
        dbg('[speak] 自动收生词：' + autoAdded.join(', '));
      }
    }
    speak.logScore({ overall: score.overall, band: score.band, n: score.words.length, poor: (score.counts || {}).poor || 0 });
    dbg('[asr] words=' + score.words.length + ' overall=' + score.overall + ' band=' + score.band
      + ' vad=' + (r.vad ? 'on' : 'off')
      + ' ipa命中=' + Object.keys(ipa).length + '/' + score.words.length);
    return { ok: true, text, score, ipa, autoAdded };
  } catch (e) {
    dbg('[asr] ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* 翻译器：主人不知道怎么说 → 给 1~3 种地道英文 + 音标 */
ipcMain.handle('speak:translate', async (_e, payload) => {
  const cfg = config.load();
  const zh = String((payload && payload.text) || '').trim();
  if (!zh) return { ok: false, error: '还没输入内容' };
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key' };
  try {
    const p = loadPersona();
    const raw = await llm.request(cfg, [
      { role: 'system', content: speak.buildTranslatePrompt(zh, { scene: '和桌宠「' + (p.name || '大肥鱼') + '」练英语口语' }) },
      { role: 'user', content: '请输出 JSON。' },
    ]);
    const o = speak.parseJson(raw);
    if (!o || !Array.isArray(o.options) || !o.options.length) return { ok: false, error: '模型没给出可用结果' };
    const map = {};
    for (const opt of o.options) for (const w of (opt.words || [])) if (w && w.w) map[w.w] = { ipa: w.ipa, zh: w.zh };
    speak.ipaPut(map);                                        // 顺手把音标收进缓存
    dbg('[speak] 翻译「' + zh.slice(0, 20) + '」→ ' + o.options.length + ' 种说法');
    return { ok: true, options: o.options.slice(0, 3) };
  } catch (e) {
    dbg('[speak] translate err ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* 查一批词的音标（缓存优先；缺的只在后台补，立即返回已有的） */
ipcMain.handle('speak:ipa', (_e, words) => {
  const list = Array.isArray(words) ? words : [];
  const cached = speak.ipaGet(list);
  fillIpa(list).catch(() => {});
  return { ok: true, ipa: cached, missing: speak.ipaMissing(list) };
});

/* 进步曲线 + 自动收生词开关 */
ipcMain.handle('speak:trend', (_e, days) => speak.trend(days));
ipcMain.handle('speak:autoAdd', (_e, on) => {
  const v = (on === undefined) ? (config.load().vocabAutoAdd !== false) : !!on;
  if (on !== undefined) config.save({ vocabAutoAdd: v });
  return { on: v };
});

/* ---------------- 发音评测（"像不像"）的参考句 ----------------
 * 依据 发音评测可行性-20261001.md：拿"目标句的母语者 TTS"当参考做 DTW，
 * 只用逐词相对分 S，不用绝对分（绝对分会被音色差异淹没）。
 *
 * ⚠️ **参考音频必须重采样成 16kHz 才能跑 whisper**：
 *    Edge TTS 给的是 **48kHz mp3**，直接把 mp3 喂 whisper-cli 虽然能出文字，
 *    但 **token 时间戳是坏的** —— 实测 'answer' 的 offsets 是 {from:7100,to:7100}（零长），
 *    段级 offsets 报 0~30000ms 而音频只有 7 秒。逐词归因全靠这组时间戳，坏了就全错位。
 *    所以流程改成：渲染层用 Web Audio 解码 + OfflineAudioContext 重采样到 16k + 自己封 WAV，
 *    再交给这里跑 whisper（见 pron:timing）。
 * 两个 IPC 分工：
 *   pron:ref    → TTS 的 mp3 + 参数（+ 命中缓存的话连词级时间戳一起给）
 *   pron:timing → 拿渲染层传来的 16k 单声道 WAV 跑 whisper，取词级时间戳并缓存
 */
ipcMain.handle('pron:ref', async (_e, payload) => {
  const cfg = config.load();
  const pr = cfg.pron || {};
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: '空句子' };
  const maxChars = Number(pr.refMaxChars) || 200;
  if (text.length > maxChars) return { ok: false, error: '句子太长（>' + maxChars + ' 字），不作参考评测' };
  try {
    const tts = await tts.synthesize(text, { voice: cfg.ttsVoice || undefined });
    if (!tts || !tts.dataUrl) return { ok: false, error: 'TTS 合成失败' };
    const ref = speak.refGet(text);      // 命中缓存就不用渲染层再做重采样那一步
    return { ok: true, dataUrl: tts.dataUrl, words: (ref && ref.words) || null, params: pr };
  } catch (e) {
    dbg('[pron] ref err ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* whisper 对短功能词（I / to / a）经常给**零长**时间戳（from === to），
 * 直接拿去归因会让这些词的帧区间为空、评分里凭空少词。
 * 用相邻词把空档补出来：从上一个词的终点，到下一个词的起点。 */
function fillWordGaps(words) {
  const ws = (words || []).map((w) => ({
    w: String(w.w), from: Number(w.from) || 0, to: Number(w.to) || 0,
  }));
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].to > ws[i].from) continue;
    const prevEnd = i > 0 ? ws[i - 1].to : 0;
    let nextStart = 0;
    for (let k = i + 1; k < ws.length; k++) { if (ws[k].from > prevEnd) { nextStart = ws[k].from; break; } }
    const from = Math.max(prevEnd, Math.min(ws[i].from, nextStart || ws[i].from));
    ws[i].from = from;
    ws[i].to = (nextStart && nextStart > from) ? nextStart : from + 40;   // 兜底给 40ms 窗
  }
  return ws;
}

/* 渲染层已经把 TTS 音频重采样成 16k 单声道 WAV（统一时间轴） */
ipcMain.handle('pron:timing', async (_e, payload) => {
  const cfg = config.load();
  const text = String((payload && payload.text) || '').trim();
  const buf = payload && payload.wav;
  if (!text || !buf) return { ok: false, error: '缺少句子或音频' };
  const hit = speak.refGet(text);
  if (hit) return { ok: true, words: hit.words, cached: true };
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const r = await asr.transcribeDetailed(b, cfg.asrModel || 'base.en', { vad: true });
    const raw = (r.words || []).filter((w) => w && w.w);
    if (!raw.length) return { ok: false, error: 'whisper 没给出词' };
    const words = fillWordGaps(raw);
    speak.refPut(text, words);
    dbg('[pron] 参考句已分析并缓存，词数=' + words.length + '：「' + text.slice(0, 36) + '」');
    return { ok: true, words, cached: false };
  } catch (e) {
    dbg('[pron] timing err ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- 麦克风权限 ---------------- */
/* 语音识别报"没授权/没设备"时，把对话窗弹出来并显示授权面板 */
ipcMain.on('mic:needPermission', (_e, reason) => {
  createChat();
  const send = () => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('mic:permission', reason || ''); };
  setTimeout(send, 600);
  setTimeout(send, 1500);
});
ipcMain.handle('mic:openSettings', async () => {
  try {
    if (process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone');
    else await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.on('pet:resize', (_e, p) => {
  if (!petWin) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const h = Math.round(Math.min(Math.max(Number(p?.h ?? p) || 220, 120), wa.height));
  const [x, y] = petWin.getPosition();
  let newY = y;
  if (y + h > wa.y + wa.height) newY = Math.max(wa.y, wa.y + wa.height - h);
  if (h >= 60) petH = h;   // 忽略渲染层瞬时上报的 4px 噪声，只记录有效高度
  petWin.setBounds({ x, y: newY, width: PET_W, height: h });
});

let shotN = 0;
ipcMain.on('pet:shot', () => {
  setTimeout(async () => {
    if (!petWin || petWin.isDestroyed()) return;
    try {
      const img = await petWin.webContents.capturePage();
      const dir = path.join(__dirname, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      shotN = (shotN % 10) + 1;
      fs.writeFileSync(path.join(dir, `shot-${String(shotN).padStart(2, '0')}.png`), img.toPNG());
    } catch {}
  }, 400);
});

let chatShotN = 0;
ipcMain.on('chat:shot', () => {
  setTimeout(async () => {
    if (!chatWin || chatWin.isDestroyed()) return;
    try {
      const img = await chatWin.webContents.capturePage();
      const dir = path.join(__dirname, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      chatShotN = (chatShotN % 6) + 1;
      fs.writeFileSync(path.join(dir, `chat-${String(chatShotN).padStart(2, '0')}.png`), img.toPNG());
    } catch {}
  }, 400);
});

ipcMain.handle('config:get', () => config.load());
ipcMain.handle('config:set', (_e, patch) => config.save(patch || {}));

ipcMain.handle('config:test', async (_e, patch) => {
  const cfg = { ...config.load(), ...(patch || {}) };
  const sample = await llm.request(cfg, [
    { role: 'system', content: 'You are a connection tester.' },
    { role: 'user', content: 'Reply with exactly: OK' }
  ]);
  return { ok: true, sample: String(sample).slice(0, 80) };
});

ipcMain.handle('chat:send', async (e, payload) => {
  const cfg = config.load();
  const text = String(payload?.text || '').trim();
  if (!text) return { en: '', zh: '', words: [], choices: [] };
  /* 真用户消息到达 → 重置「重复调用」计数（照 DSH dsh-repeat-tool-reminder 的做法：
     主人插话代表环境变了，之前的重复计数不该继续累加）。 */
  try { require('./src/assistant').__repeatReset(); } catch {}
  /* 【每轮开始清扫一次超长历史】照 DSH dsh-compaction-tool-result-pruner：
     把早先那些超长的工具结果**折叠成摘要节点**（追加一条替代事件，**原文仍在事件日志里** + 溢出文件里）。
     阈值取 4000：一次 spill 后的回执约 5~8KB（头 4000 + 提示 + 尾 1000），
     所以它会在"不再是最新几条"之后被折叠；原文有两处保底（spill 文件 + 原始事件），不会丢。
     刚来的那条不会被剪（keepRecent 保护），因为那正是她此刻要看的。 */
  try {
    const pr = memory.session.pruneLong({ maxInlineChars: 4000, keepRecent: 2, minSaveChars: 500, reason: 'turn-sweep' });
    if (pr && pr.count) dbg('[session] 本轮清扫折叠了 ' + pr.count + ' 条超长历史');
  } catch {}
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...memory.pickHistory(),
    { role: 'user', content: text }
  ];
  const fromChat = isFromChat(e);
  try { dbg('[chat] send from=' + (fromChat ? 'chat' : 'pet') + ' len=' + text.length); } catch {}
  const { reply, raw } = await genReply(cfg, messages, (en) => {
    // 流式：EN 一行一出来就先推给"发问方"窗口，让它先开始朗读/显示（谁问的谁出声）
    if (fromChat) {
      if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:partial', { en });
    } else if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send('pet:say-partial', { en });
    }
  });
  if (reply.en) {
    memory.onTurn(text, raw, reply.en);
    mood.adjust({ affection: 1, mood: 2 });
  }
  logTurn(text, reply);
  // 她如果在回复里写了 WRITE 块（多行代码装不进单行 ACTION），解析出来交给前端确认后落盘
  try {
    if (assistant.allowed(cfg.assistant || 'off', 'proj_open')) {
      const files = projects.parseWriteBlocks(raw);
      if (files.length) { reply.files = files; dbg('[proj] reply has ' + files.length + ' file block(s)'); }
    }
  } catch {}
  // 谁问的谁说话：对话窗发起的 → 对话窗读，桌宠只显示气泡不出声（反之同理）
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:say', { ...reply, silent: fromChat });
  if (!fromChat) {
    relayToChat({ who: 'me', text });
    if (reply.en) relayToChat({ who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
  }
  return reply;
});

ipcMain.handle('chat:react', async (_e, kind) => {
  const cfg = config.load();
  const action = kind === 'feed'
    ? '主人刚刚投喂了你一条小鱼干，你正在吃。'
    : '主人正用手在你的头上左右来回抚摸。';
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...memory.pickHistory(1500),
    { role: 'user', content: `（场景：${action}）请完全按你当前的人设，用英语说一句即时的反应，只要 1 句，不要旁白、不要解释。同时给出中文翻译、音标，以及 2 个预制回复。` }
  ];
  const { reply } = await genReply(cfg, messages);
  logTurn('', reply);
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:say', reply);
  if (reply.en) relayToChat({ who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
  return reply;
});

ipcMain.handle('chat:greet', async () => {
  const cfg = config.load();
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    { role: 'user', content: '你的主人刚打开电脑。请用英语说一句简短的开场白问候。' }
  ];
  const { reply, raw } = await genReply(cfg, messages);
  if (reply.en) memory.onAssistant(raw, reply.en);
  logTurn('', reply);
  // 不推 pet:say：这次是桌宠自己调用并直接展示返回值，再推一次会渲染两遍、读两遍
  if (reply.en) relayToChat({ who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
  return reply;
});

ipcMain.handle('persona:get', () => ({ ...loadPersona(), locks: persona.locks(), aiFields: persona.FIELDS, userOnly: persona.USER_ONLY, labels: persona.LABELS }));
ipcMain.handle('persona:set', (_e, patch) => {   // 用户改：所有字段都能改
  const before = persona.load();
  const p = persona.patch(patch || {});
  /* 用户改了人设 → **重新评估一次隐藏数值**：按新基线的变化量整段平移（累积不清零）。
     人设只动了口头禅这类没改关键词时，基线不变 → 数值原地不动。 */
  try {
    const r = stats.rebaseline(persona.load());
    dbg('[stats] rebaseline ' + (r.changed
      ? 'applied=' + (r.applied.map((a) => a.key + (a.delta > 0 ? '+' : '') + a.delta).join(',') || '(基线未变，数值不动)')
      : 'skip: ' + r.reason));
  } catch (e) { dbg('[stats] rebaseline err ' + e); }
  /* 顺带：按概率让 AI 重写交互台词（关键人格换了就大改） */
  maybeRefreshPetLines(before, p).catch((e) => dbg('[petlines] err ' + ((e && e.message) || e)));
  return p;
});
ipcMain.handle('persona:lock', (_e, o) => {
  persona.setLock(o && o.field, !!(o && o.locked));
  return { locks: persona.locks() };
});

/* ---------------- 人设自改：随经历缓慢演化（世界观只有用户能改） ---------------- */
async function evolvePersonaOnce() {
  const cfg = config.load();
  if (!cfg.apiKey) return null;
  const p = persona.load();
  const lockNote = persona.ALL_FIELDS.filter((f) => !persona.aiEditable(f)).map((f) => persona.LABELS[f]).join('、') || '（无）';
  const rec = memory.long.list().slice(-3).map((d) => d.date + '：' + String(d.diary || '').slice(0, 200)).join('\n');
  const facts = memory.permanent.topFacts(20).map((f) => '· ' + f.text).join('\n');
  const mo = mood.load();
  const j = await memory.jobs.evolvePersona(llm, cfg, {
    persona: p, diary: rec, facts, lockNote, affection: mo.affection, mood: mo.mood,
    vocab: personatags.vocabulary(),
  });
  if (!j || !j.changed || !Object.keys(j.fields || {}).length) { dbg('[persona] 这次不需要改'); return null; }
  const r = persona.applyAI(j.fields);
  dbg('[persona] 演化 applied=[' + r.applied.join(',') + '] skipped=[' + r.skipped.join(',') + '] 因为：' + j.reason);
  /* 她自己改了人设 → 同样重新评估一次隐藏数值（与用户手改走同一条路） */
  if (r.applied.length) {
    try {
      const rb = stats.rebaseline(persona.load());
      if (rb.changed && rb.applied.length) {
        dbg('[stats] rebaseline(by AI) applied=' + rb.applied.map((a) => a.key + (a.delta > 0 ? '+' : '') + a.delta).join(','));
      }
    } catch (e) { dbg('[stats] rebaseline(AI) err ' + e); }
    /* 她自己改了人设（包括核心人格）→ 同样按概率触发台词重写 */
    maybeRefreshPetLines(p, persona.load()).catch((e) => dbg('[petlines] err(AI) ' + ((e && e.message) || e)));
  }
  if (r.applied.length && petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('persona:changed', { applied: r.applied, reason: j.reason });
  }
  return { ...r, reason: j.reason };
}
/* 永久记忆一旦有新的晋升 → 顺带检测一次人设要不要变（没有晋升就完全不跑，省 token） */
memory.bus.on('memory:permanent', (r) => {
  if (!r || !r.promoted) return;
  setTimeout(() => { evolvePersonaOnce().catch((e) => dbg('[persona] evolve err ' + e)); }, 2000);
});
ipcMain.handle('persona:evolve', () => evolvePersonaOnce());

/* ---------------- 交互台词：改设定时按概率让 AI 重写 ----------------
 * 关键人格（tier1）换了 → 大概率 + **全量**重写（"大改"）；
 * 只是小修小补       → 小概率 + 只改几句（"小改"）。
 * 结果写进覆盖层 pet-actions-ai.json，**手写底稿 pet-actions.json 不动**。
 * 概率/条数都能在 config.json 里覆盖。
 */
const PET_LINES_MAJOR_P = 0.85;   // 关键人格变了：重写概率
const PET_LINES_MINOR_P = 0.20;   // 只是微调：重写概率
const PET_LINES_MINOR_N = 6;      // 小改时最多改几个部位

function petRegionList() {
  try {
    const j = (regionsCache && regionsCache.regions) ? regionsCache
      : JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'pet-regions.json'), 'utf8'));
    return (j.regions || []).map((r) => ({ id: r.id, name: r.name || r.id }));
  } catch { return []; }
}

async function refreshPetLines(persona, major) {
  const cfg = config.load();
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key' };
  const p = persona || loadPersona();
  const arch = personatags.analyze(p).primary || {};
  const table = petactions.loadTable();
  const all = petRegionList().filter((r) => table.regions[r.id]);      // 只改表里有的热区
  if (!all.length) return { ok: false, error: '没有可改的热区' };

  const prev = petactions.activeOverlay(arch.id);
  const targets = major ? all : all.slice().sort(() => Math.random() - 0.5).slice(0, PET_LINES_MINOR_N);

  const rows = targets.map((r) => {
    const cur = petactions.resolve({ id: r.id, group: table.regions[r.id].group }, p, cfg.petSkin) || {};
    const s = cur.say || {};
    return { id: r.id, name: r.name, en: s.en || '', zh: s.zh || '' };
  });
  const sys = petactions.buildRewritePrompt(p, arch, rows);

  const raw = await llm.request(cfg, [{ role: 'system', content: sys }, { role: 'user', content: '请输出 JSON。' }]);
  const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < 0) return { ok: false, error: '模型没给出 JSON' };
  let o;
  try { o = JSON.parse(t.slice(i, j + 1)); } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }

  const limit = major ? targets.length : PET_LINES_MINOR_N;
  const merged = major ? {} : Object.assign({}, (prev && prev.lines) || {});   // 小改要保留上次改的
  let n = 0;
  for (const [k, v] of Object.entries(o || {})) {
    if (n >= limit) break;
    if (!table.regions[k]) continue;
    const line = petactions.takesLine(v);
    if (!line) continue;
    merged[k] = line;
    n++;
  }
  if (!n) return { ok: false, error: '模型没给出可用台词' };
  petactions.saveOverlay({ sig: personatags.sigOf(p), arch: arch.id || '', lines: merged });
  dbg('[petlines] ' + (major ? '大改' : '小改') + ' arch=' + (arch.id || '?') + ' 写入 ' + n + ' 条');
  if (petWin && !petWin.isDestroyed()) { try { petWin.webContents.send('pet:linesChanged', { major, count: n, arch: arch.id }); } catch {} }
  return { ok: true, major, count: n, arch: arch.id };
}

/* 改完设定调一次：先看"关键人格有没有换"，再掷骰子 */
async function maybeRefreshPetLines(before, after) {
  const cfg = config.load();
  if (!cfg.apiKey) return null;
  const a0 = (personatags.analyze(before || {}).primary || {}).id || '';
  const a1 = (personatags.analyze(after || {}).primary || {}).id || '';
  const major = a0 !== a1;
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
  const prob = major ? pick(cfg.petLinesMajorP, PET_LINES_MAJOR_P) : pick(cfg.petLinesMinorP, PET_LINES_MINOR_P);
  if (Math.random() > prob) {
    dbg('[petlines] skip（关键人格' + (major ? '变了→大改' : '没变→小改') + '，掷骰子没过 p=' + prob + '）');
    return null;
  }
  return refreshPetLines(after, major);
}

ipcMain.handle('pet:refreshLines', (_e, force) => refreshPetLines(loadPersona(), force !== false));
ipcMain.handle('pet:linesInfo', () => {
  const ov = petactions.loadOverlay();
  return { file: petactions.overlayFile(), arch: ov.arch, at: ov.at, count: Object.keys(ov.lines || {}).length, lines: ov.lines };
});

/* 📖 日记面板只暴露「长期记忆」；中期记忆对用户隐藏 */
ipcMain.handle('memory:get', () => ({ long: memory.long.list(), session: memory.session.info() }));
ipcMain.handle('memory:session', () => memory.session.info());
ipcMain.handle('memory:delete', (_e, ref) => {
  if (ref && ref.kind === 'long') memory.long.removeAt(ref.ts);
  return { long: memory.long.list() };
});
/* 结束本次会话：写中期摘要 + 抽永久记忆候选 → 清草稿、开新会话 */
ipcMain.handle('memory:endSession', async () => {
  const r = await memory.onSessionEnd().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('memory:ended', r);
  return r;
});
ipcMain.handle('mood:get', () => mood.load());
ipcMain.handle('mood:adjust', (_e, d) => mood.adjust(d || {}));
ipcMain.handle('dsh:state', () => dsh.state());
ipcMain.handle('vocab:list', () => vocab.load());
ipcMain.handle('vocab:add', (_e, w) => vocab.add(w || {}));
ipcMain.handle('vocab:del', (_e, w) => vocab.del(w));
ipcMain.handle('vocab:review', (_e, w, ok) => vocab.review(w, ok));

/* ---------------- 语音合成（音色） ---------------- */
ipcMain.handle('tts:voices', () => ({
  voices: tts.VOICES,
  styles: Object.entries(tts.STYLES).map(([id, v]) => ({ id, label: v.label, rate: v.rate, pitch: v.pitch })),
  defaultVoice: tts.DEFAULT_VOICE,
  defaultStyle: tts.DEFAULT_STYLE,
}));
ipcMain.handle('tts:speak', async (e, payload) => {
  const cfg = config.load();
  const p = payload || {};
  if (cfg.ttsEnabled === false && !p.force) return { ok: false, error: '朗读已关闭' };
  // 回声排查：同一句话如果两个窗口都来要语音，日志里会看到两条 from= 不同的记录
  try { dbg('[tts] speak from=' + (isFromChat(e) ? 'chat' : 'pet') + ' len=' + String(p.text || '').length); } catch {}
  try {
    return await tts.synthesize(p.text, {
      voice: p.voice || cfg.ttsVoice,
      style: p.style || cfg.ttsStyle,
      rate: p.rate || cfg.ttsRate,
      pitch: p.pitch || cfg.ttsPitch,
    });
  } catch (e) {
    dbg('[tts:speak] ERR=' + String((e && e.stack) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- 外部立绘（免打包换图） + 命中区块图 ---------------- */
const artDir = () => path.join(app.getPath('userData'), 'art');

let artCache = null;   // { key, dataUrl } —— 立绘只在变化时才重新传 dataUrl
ipcMain.handle('art:get', () => {
  let file = null, mtime = 0, custom = false;
  try {
    const f = path.join(artDir(), 'pet-character.png');
    mtime = fs.statSync(f).mtimeMs;
    file = f; custom = true;
  } catch {
    try {
      const f = path.join(__dirname, 'assets', 'pet-character.png');
      mtime = fs.statSync(f).mtimeMs;
      file = f;
    } catch { return { ok: false }; }
  }
  const key = file + '|' + mtime;
  if (!artCache || artCache.key !== key) {
    let dataUrl = null;
    try { dataUrl = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'); } catch {}
    artCache = { key, dataUrl };
  }
  // dataUrl 必须给：渲染层要把它画进 canvas 做像素级命中判定（file:// 的图会污染 canvas，读不了像素）
  return { ok: true, custom, mtime, dataUrl: artCache.dataUrl };
});

/* 命中区块图（归一化多边形）。外部 art/pet-regions.json 优先，方便换立绘时一起换 */
let regionsCache = null;
ipcMain.handle('art:regions', () => {
  if (regionsCache) return regionsCache;
  const candidates = [path.join(artDir(), 'pet-regions.json'), path.join(__dirname, 'assets', 'pet-regions.json')];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      if (j && Array.isArray(j.regions)) { regionsCache = j; return j; }
    } catch {}
  }
  regionsCache = { version: 1, regions: [] };
  return regionsCache;
});

/* ---------------- 交互系统（交互模式 / 聊天模式） ----------------
 * 交互模式：点立绘不同部位出不同动作，动作按**核心人格**变（pet-actions.json）。
 *           这个模式**不拖拽、不戳**，摸头也挪到这里。
 * 聊天模式：原来的行为（可拖拽、可戳）。
 * 立绘姿态槽：动作可以带一个 pose 名，渲染层按名字来取图；
 *           图放 %APPDATA%/dayu-pet/art/poses/<pose>.png 就自动生效，不用改代码。
 */
const poseCache = new Map();
ipcMain.handle('art:pose', (_e, pose) => {
  const name = String(pose || '').trim();
  if (!name) return { ok: false, pose: name, reason: 'empty' };
  const f = petactions.poseFile(name, config.load().petSkin);
  if (!f) return { ok: false, pose: name, reason: 'no-image' };   // 没图不是错误，渲染层只用 CSS
  try {
    const mtime = fs.statSync(f).mtimeMs;
    const hit = poseCache.get(f);
    if (hit && hit.mtime === mtime) return { ok: true, pose: name, path: f, dataUrl: hit.dataUrl };
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    poseCache.set(f, { mtime, dataUrl });
    return { ok: true, pose: name, path: f, dataUrl };
  } catch (e) { return { ok: false, pose: name, reason: String((e && e.message) || e) }; }
});
ipcMain.handle('art:poses', () => ({ dir: petactions.posesDir(), poses: petactions.poseReport(config.load().petSkin) }));

ipcMain.handle('pet:getMode', () => {
  const m = config.load().petMode;
  return { mode: (m === 'chat') ? 'chat' : 'interact' };
});
ipcMain.handle('pet:setMode', (_e, m) => {
  const mode = (m === 'chat') ? 'chat' : 'interact';
  config.save({ petMode: mode });
  dbg('[pet] mode -> ' + mode);
  if (petWin && !petWin.isDestroyed()) {
    try { petWin.webContents.send('pet:mode', { mode }); } catch {}
  }
  return { mode };
});

/* 点了一个热区 → 解析出动作。
 * preset 部位：直接返回预置台词（零延迟、零成本），点下去立刻有反应。
 * key 部位（脸/眼/鳍耳/手/围裙鲸鱼/尾）：**不阻塞**——先返回动作让形变/特效立刻播，
 *   模型的个性化台词在后台生成好再推 pet:say 顶上来（所以这两类部位先不给预置台词，免得闪一下）。 */
async function interactLLM(act) {
  const cfg = config.load();
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...memory.pickHistory(1200),
    { role: 'user', content: `（场景：主人用手点了你的「${act.regionName}」。请完全按你当前的人设，用英语说一句即时的反应，只要 1 句，不要旁白、不要解释。同时给出中文翻译、音标，以及 2 个预制回复。）` },
  ];
  const { reply } = await genReply(cfg, messages);
  if (!reply.en) return;
  logTurn('', reply);
  if (act.mood) { try { mood.adjust(act.mood); } catch {} }
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:say', { ...reply, silent: false });
}

ipcMain.handle('pet:interact', (_e, payload) => {
  const cfg = config.load();
  const act = petactions.resolve(payload && payload.region, loadPersona(), cfg.petSkin);
  if (!act) return { ok: false };
  const willLLM = act.mode === 'llm' && act.key && !!cfg.apiKey;
  const out = { ok: true, ...act, reply: null, fromLLM: willLLM };
  delete out.poseFile;                                  // 路径不外泄，渲染层按 pose 名自己取
  if (willLLM) {
    out.say = '';
    interactLLM(act).catch((e) => dbg('[pet] interact llm fail，回落预置台词: ' + String((e && e.message) || e)));
  } else if (act.mood) {
    try { mood.adjust(act.mood); } catch {}
  }
  dbg('[pet] interact region=' + act.region + ' arch=' + act.arch + ' ' + (willLLM ? 'llm' : 'preset'));
  return out;
});

/* ---------------- 命中判定 / 透明区点穿 ----------------
 * 渲染层把立绘 alpha 压成 1bit 小掩码发过来；这里按全局光标位置轮询：
 * 光标不在立绘实心像素上时让窗口鼠标穿透（不挡桌面图标），在实心上时才接鼠标。
 * 为什么不用渲染层的 mousemove 判定：Electron 的 setIgnoreMouseEvents(true,{forward:true})
 * 在本机实测不转发 mousemove（渲染层一条都收不到），所以只能主进程轮询全局光标。
 */
let hitInfo = null;          // { w, h, mask, left, top, width, height }
let hitTimer = null;
let hitIgnoring = null;      // 当前是否处于穿透状态
let holdInteractive = false; // 按住鼠标期间强制可交互

ipcMain.on('pet:hitmask', (_e, info) => {
  try {
    if (!info || !info.mask) { hitInfo = null; return; }
    hitInfo = {
      w: Number(info.w) | 0, h: Number(info.h) | 0,
      mask: Buffer.from(String(info.mask), 'base64'),
      left: Number(info.left) || 0, top: Number(info.top) || 0,
      width: Number(info.width) || 0, height: Number(info.height) || 0,
    };
    hitIgnoring = null;   // 掩码更新后立刻重新判定一次
  } catch { hitInfo = null; }
});
ipcMain.on('pet:hold', (_e, on) => { holdInteractive = !!on; if (on) applyIgnore(false); });
ipcMain.on('pet:setInteractive', (_e, on) => { if (holdInteractive) return; applyIgnore(!on); });   // 按住期间不许被穿透打断

function solidAtCursor() {
  if (!hitInfo || !hitInfo.width || !hitInfo.height) return true;   // 还没掩码时保守：接鼠标
  if (!petWin || petWin.isDestroyed()) return true;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  const lx = c.x - wx - hitInfo.left;
  const ly = c.y - wy - hitInfo.top;
  /* 光标在立绘**包围盒内** → 一律可交互（点/拖都行）。
     之前按像素 alpha 细判，把立绘身上的透明缝（约 31%）也判成穿透，
     导致点桌宠经常点不中（戳不出反应）。点穿只针对立绘外的空白边。 */
  return lx >= 0 && ly >= 0 && lx < hitInfo.width && ly < hitInfo.height;
}

function applyIgnore(ignore, reason = '') {
  if (!petWin || petWin.isDestroyed()) return;
  if (hitIgnoring === ignore) return;
  hitIgnoring = ignore;
  /* 诊断：记录点穿为何被打开（reason）。hitInfo 只留关键字段，不 dump mask */
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  const hi = hitInfo ? { w: hitInfo.w, h: hitInfo.h, left: hitInfo.left, top: hitInfo.top, width: hitInfo.width, height: hitInfo.height } : null;
  dbg('[hit-diag] ' + JSON.stringify({ ignore, reason, dragging, holdInteractive, cursor: [cursor.x, cursor.y], window: [wx, wy], hitInfo: hi }));
  try { petWin.setIgnoreMouseEvents(ignore, { forward: true }); }
  catch (error) { dbg('[hit-diag] setIgnoreMouseEvents failed ' + error); }
}

function startHitLoop() {
  clearInterval(hitTimer);
  hitTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) { clearInterval(hitTimer); hitTimer = null; return; }
    if (dragging || holdInteractive) { applyIgnore(false, 'dragging-or-holding'); return; }
    const solid = solidAtCursor();
    applyIgnore(!solid, solid ? 'solid' : 'outside-hit-box');
  }, 30);
}
ipcMain.handle('art:open', async () => {
  const d = artDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  const target = path.join(d, 'pet-character.png');
  if (!fs.existsSync(target)) {
    try { fs.copyFileSync(path.join(__dirname, 'assets', 'pet-character.png'), target); } catch {}
  }
  await shell.openPath(d);
  return d;
});
/* 技能：打开技能文件夹 / 列出技能 */
ipcMain.handle('skills:open', async () => {
  skills.ensureBuiltins();
  const d = await skills.openFolder();
  return d || skills.userDir();
});
ipcMain.handle('skills:list', () => skills.list().map((s) => ({ id: s.id, name: s.name, description: s.description })));

/* 把攒够权重的经验归档进技能文件夹：AI 自己决定放哪个技能、哪个文件、怎么写 */
const ARCHIVE_SYS = `你是一个"知识库管理员"。任务：把一条经验归档进技能文件夹。

技能文件夹结构：skills/<技能名>/SKILL.md，技能内部可以有自己的子文件夹。

你有两种回复方式：

【1】先查看现有内容（需要时用；每次回复的最后一行写）：
   ACTION: skill_ls|路径          列目录（要看技能根目录就写 ACTION: skill_ls|）
   ACTION: skill_read|路径        读一个文件

【2】最终写入（内容可以多行，原样放在 <<< 和 >>> 之间）：
   WRITE: <路径>
   <<<
   <这个文件的完整内容，用真实换行，必须保留文件原有内容>
   >>>

规则：
- 先 skill_ls 看看现在有哪些技能；必要时 skill_read 看看相关 SKILL.md 的现有结构
- 判断这条经验属于哪个技能：能并进已有技能就并进去；确实是全新领域才新建技能（新技能的 SKILL.md 开头必须有 --- name: xxx 和 description: xxx --- 的头）
- SKILL.md 保持**简短**（总览 + 索引），详细经验放进子文件夹（如 <技能>/<子类>/<主题>.md）
- 合并进已有文件时，**必须保留原有内容**，只在合适的位置补充
- 全部归档完成后，回复 DONE

只做归档，不要闲聊、不要解释。`;

/* 解析 WRITE 块（多行内容）
   结束标记必须单独成行：非贪婪到第一个 `>>>` 会被内容里的 `a >>> 2` 之类提前截断。 */
function parseWriteBlock(raw) {
  const m = String(raw || '').match(/WRITE\s*[:：]\s*([^\r\n]+)[\s\S]*?<<<[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*>>>[ \t]*(?=\r?\n|$)/);
  if (!m) return null;
  const p = m[1].trim().replace(/^["'`]|["'`]$/g, '');
  if (!p) return null;
  return { path: p, content: m[2] };
}

async function archiveSkills(limit) {
  const cfg = config.load();
  if (!cfg.apiKey) return { ok: false, error: '没配 API Key' };
  const mc = cfg.memory || {};
  const th = mc.skillFileWeight || 4;
  const items = memory.skillmem.ready(th).slice(0, Math.max(1, Math.min(10, Number(limit) || mc.skillArchiveMax || 5)));
  if (!items.length) return { ok: true, filed: 0, total: 0, log: [] };
  const log = [];
  let filed = 0;
  let budget = Math.max(2, Math.min(40, Number(mc.skillArchiveCalls) || 10));   // 总调用硬上限
  for (const it of items) {
    try {
      const messages = [
        { role: 'system', content: ARCHIVE_SYS },
        { role: 'user', content: '要归档的经验（权重 ' + it.weight + '，出现过 ' + (it.hits || 1) + ' 次）：\n' + it.text + (it.skill ? '\n（可能属于技能：' + it.skill + '）' : '') }
      ];
      let wrote = false;
      for (let i = 0; i < 8 && budget > 0; i++) {
        budget--;
        const raw = await llm.request(cfg, messages);
        // ① 写入块（支持多行内容）
        const w = parseWriteBlock(raw);
        if (w) {
          try {
            const r = skills.writeFile(w.path, w.content);
            wrote = true;
            dbg('[skills] write ' + r.path + ' (' + r.bytes + 'B)');
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: '[系统] 已写入 ' + r.path + '（' + r.bytes + ' 字节）。如果还有别的文件要写就继续，否则回复 DONE。' });
            continue;
          } catch (e) {
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: '[系统] 写入失败：' + ((e && e.message) || e) + '。请修正后重试。' });
            continue;
          }
        }
        // ② 查看类工具（单行 ACTION）
        const act = llm.parseReply(raw).action;
        if (act && /^skill_(ls|read)$/.test(String(act.tool).toLowerCase())) {
          let out = '';
          try { const r = await assistant.run(act.tool, act.arg); out = String((r && typeof r === 'object') ? r.text : r); }
          catch (e) { out = '失败：' + ((e && e.message) || e); }
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: '[系统] 操作结果：\n' + memory.tokens.clip(out, 500) });
          continue;
        }
        break;   // DONE / 没有可执行动作
      }
      if (wrote) { memory.skillmem.drop([it.text]); filed++; log.push('✅ ' + it.text.slice(0, 50)); }
      else log.push('⏭ 模型没写入：' + it.text.slice(0, 50));
    } catch (e) {
      log.push('❌ ' + it.text.slice(0, 40) + '：' + ((e && e.message) || e));
    }
  }
  dbg('[skills] archive filed=' + filed + '/' + items.length + ' 剩余调用预算=' + budget);
  return { ok: true, filed, total: items.length, log, budgetLeft: budget };
}
ipcMain.handle('skills:archive', () => archiveSkills());
ipcMain.handle('skills:pool', () => ({
  cand: memory.skillmem.candidates().map((c) => ({ text: c.text, weight: c.weight, hits: c.hits || 1, skill: c.skill || '' })),
  ready: memory.skillmem.ready((config.load().memory || {}).skillFileWeight || 4).length,
}));

/* ---------------- 项目文件夹（她写的小软件落这儿） ---------------- */
ipcMain.handle('proj:write', (_e, files) => {
  const tier = config.load().assistant || 'off';
  if (!assistant.allowed(tier, 'proj_open')) return { ok: false, error: '当前 AI 助手权限不允许写文件' };
  try { return { ok: true, files: projects.writeMany(files || []) }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('proj:open', async (_e, rel) => {
  try { await projects.open(rel); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('proj:openFolder', async (_e, rel) => {
  try { await projects.openFolder(rel); return { ok: true, dir: projects.rootDir() }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/* ---------------- 隐藏数值：每轮/每任务的小微调 ---------------- */
ipcMain.handle('stats:task', (_e, o) => {
  const ok = !!(o && o.ok);
  /* 【记录停止原因】照 DSH dsh-agent-loop 的做法，循环结束时带一个**显式的停止原因**
     （completed / step-budget / look-streak / no-result / no-next / aborted / error）。
     以前只知道"结束了"，查不出"为什么结束" —— 今天那次"看→又想看"自转就是因此才要翻代码找根因。
     现在落到 testlog 里，可以直接统计"她都是因为什么停的"。 */
  const reason = String((o && o.stopReason) || '');
  /* ⚠️ testlog.log 的签名是**三个位置参数** log(mod, ev, data) ——
     第一版我写成了 log({mod,ev,...})（一个对象），落盘成了 {"mod":"[object Object]","ev":"undefined"} 的垃圾条目，
     是去读日志文件才发现的（§C 那条 "看不到" 就是它）。 */
  if (reason) { try { testlog.log('loop', 'stop', { reason, ok }); } catch {} }
  const out = [];
  if (ok) {
    out.push(stats.nudge('iq', 0.3, 'task-ok', '独立办成了一件事'));
    out.push(stats.nudge('diligence', 0.3, 'task-ok', '认真办了事'));
  } else {
    out.push(stats.nudge('iq', -0.5, 'task-fail', '事情没办成'));
  }
  return { ok: true, applied: out.filter((x) => x && !x.skipped), stopReason: reason };
});
ipcMain.handle('stats:get', () => ({ all: stats.all(), hidden: stats.HIDDEN, log: stats.recentLog(40), stepBudget: stats.stepBudget() }));

/* ---------------- 测试驱动器（给 app/scripts/test-chat.js 用，界面不走这里） ----------------
 * 走**和 chat:send 完全相同的核心管线**：同一个 buildSystemPrompt、同一份记忆注入、
 * 同一套历史裁剪、同一个 genReply、同样 memory.onTurn + mood.adjust。
 * 唯一区别是不碰窗口（不出气泡、不朗读），所以测出来的行为就是真实行为。
 *
 * 这些频道**没有暴露给 preload**，应用自己的两个窗口调不到，只有明确知道频道名的
 * 测试脚本能调（脚本是 require main.js 启动真应用的，见 scripts/test-chat.js）。 */
ipcMain.handle('test:turn', async (_e, payload) => {
  const cfg = config.load();
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: '空消息' };
  const t0 = Date.now();
  const sys = buildSystemPrompt(cfg);
  const hist = memory.pickHistory();
  const messages = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }];
  const { reply, raw } = await genReply(cfg, messages);
  if (reply.en) { memory.onTurn(text, raw, reply.en); mood.adjust({ affection: 1, mood: 2 }); }
  logTurn(text, reply);
  const r = {
    ok: true, en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices,
    action: reply.action || null, ms: Date.now() - t0, sysChars: sys.length, histMsgs: hist.length,
  };
  testlog.log('test', 'turn', { in: text, en: reply.en, zh: reply.zh, ms: r.ms, sysChars: r.sysChars, histMsgs: r.histMsgs, action: r.action });
  return r;
});
/* 结束本次会话：触发真正的收尾（4 个并行 LLM 任务 + 写中期/永久/技能经验 + 判数值） */
ipcMain.handle('test:endSession', async () => {
  try { const r = await memory.onSessionEnd(); return { ok: true, r }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
/* 模拟"关掉应用再打开"（跨天测试用：推进时钟后跑一次启动流程，触发衰减/熔炼/晋升） */
ipcMain.handle('test:appStart', async () => {
  try { await memory.onAppStart(); return { ok: true, day: clock.day() }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
/* 时钟平移（不改系统时间）。传 {days:5} / {ms:...} / 0 复原 */
ipcMain.handle('test:clock', (_e, p) => ({ ok: true, ...clock.set(p) }));
/* 让位机制的当前状态（测"主人一动鼠标就暂停"用） */
ipcMain.handle('test:userinput', (_e, p) => {
  if (p && p.set) userinput.setParams(p.set);
  if (p && p.resetStats) userinput.resetStats();
  return { ok: true, state: userinput.state() };
});
/* 一次性把关键状态取出来，方便断言 */
ipcMain.handle('test:snap', () => ({
  ok: true,
  day: clock.day(),
  clockOffsetMs: clock.offset(),
  stats: stats.all(),
  statsLog: stats.recentLog(20),
  mood: mood.load(),
  session: memory.session.info(),
  persona: (() => { try { return { name: persona.load().name, char: (persona.load().character_setting || '').slice(0, 60) }; } catch { return null; } })(),
  long: (() => { try { return memory.long.list().map((d) => ({ date: d.date, turns: d.turns, summary: String(d.summary || '').slice(0, 120) })); } catch { return []; } })(),
  permanent: (() => { try { return memory.permanent.facts().map((f) => ({ text: String(f.text || '').slice(0, 80), weight: f.weight, hits: f.hits })); } catch { return []; } })(),
  medium: (() => { try { return memory.medium.list().map((m) => ({ date: m.date, id: m.id, summary: String(m.summary || '').slice(0, 100) })); } catch { return []; } })(),
  skillmem: (() => { try { return memory.skillmem.candidates().map((c) => ({ text: String(c.text || '').slice(0, 80), weight: c.weight, skill: c.skill })); } catch { return []; } })(),
  values: (() => { try { const v = require('./src/store').read('values', null); return v; } catch { return null; } })(),
}));

/* ---------------- 界面风格（从人设推导 + 记忆微调） ---------------- */
ipcMain.handle('style:get', () => ({ style: style.load(), spec: style.spec(config.load(), mood.load()) }));
ipcMain.handle('style:ensure', async (_e, force) => {
  try {
    const s = await style.ensure(llm, config.load(), loadPersona(), !!force);
    return { ok: true, style: s, spec: style.spec(config.load(), mood.load()) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('art:reset', () => {
  try { fs.unlinkSync(path.join(artDir(), 'pet-character.png')); } catch {}
  return true;
});
async function runToolWithWindows(a) {
  const tier = config.load().assistant || 'off';
  if (!assistant.allowed(tier, a && a.tool)) throw new Error('当前 AI 助手权限不允许该操作');
  /* 点/拖/滚之前：如果目标点正被**我们自己的窗口**盖着，先把它让开一会儿。
     为什么必需 —— 用户报"她点不了开始游戏的按钮"：桌宠窗是 alwaysOnTop，
     而 mouse_event 的点击只会落到**最上面那个窗口**，于是她怎么点都点在桌宠窗上。
     日志实证：她自己在任务里也发现过（"my own chat window is covering part of
     the table"），然后手动把窗口拖走了 —— 不该让她干这种活。
     只在该点确实被覆盖时才动，动作结束立刻放回来。 */
  /* 看屏幕/截图时也要让开：她自己的立绘窗是 alwaysOnTop，会盖在游戏上面。
     实测她抱怨过"屏幕上是你的对话窗把游戏盖住了"（那是外部窗口），
     而她自己的立绘同样会挡 —— 抓帧前统一藏起来，抓完放回。 */
  const LOOK_TOOLS = ['screen_look', 'screen_shot', 'watch_screen'];   // watch_screen 也要让开：实测它拍到的全是盖在游戏上的聊天窗
  let petHiddenForLook = false;
  if (LOOK_TOOLS.includes(String(a && a.tool)) && petWin && !petWin.isDestroyed() && petWin.isVisible()) {
    try { petWin.hide(); petHiddenForLook = true; markPetHidden('look'); await new Promise((r2) => setTimeout(r2, 350)); } catch {}
  }
  const yielded = yieldOwnWindowsAt(a && a.tool, a && a.arg);
  /* 【让开对话窗】用户反复强调了 4 次："以后你每次开始做事第一件事情就是最小化对话框"。
     实测她记不住（截图里全是她自己的对话窗，游戏/网页被挡着，读不到也点不准）。
     这件事不该靠她记 —— 由程序替她做：所有"看/操作屏幕"的工具，
     执行前把对话窗最小化，执行完恢复。否则她每看一眼屏幕都是看自己。 */
  const SCREEN_TOOLS = ['screen_look', 'screen_shot', 'click', 'rclick', 'dclick', 'move', 'drag', 'scroll', 'type', 'key', 'focus_window', 'watch_screen'];
  /* 【主人一动鼠标她就停手】用户要求："我动鼠标时她停止，3秒检测一次，不然她一直顶窗口"。
     机制本来就有（src/userinput.js，游戏助手早就在用），但**没接到助手的动作上** ——
     所以她做任务时会一直抢光标、反复把窗口顶到最前，跟主人抢画面。
     现在：所有会动屏幕/键鼠的动作执行前，先等主人松手（连续 userCalmMs 没动，默认改成 3000ms）。 */
  const MOVE_TOOLS = ['click', 'rclick', 'dclick', 'move', 'drag', 'scroll', 'type', 'key', 'focus_window'];
  if (MOVE_TOOLS.includes(String(a && a.tool))) {
    const t0 = Date.now();
    await userinput.waitUntilFree(30000);      // 最多等 30 秒，别把任务挂死
    const waited = Date.now() - t0;
    if (waited > 300) dbg('[pet] 主人在动鼠标，等了 ' + Math.round(waited) + 'ms 才动手（' + a.tool + '）');
  }
  let chatWasVisible = false;
  if (SCREEN_TOOLS.includes(String(a && a.tool)) && chatWin && !chatWin.isDestroyed() && chatWin.isVisible() && !chatWin.isMinimized()) {
    try {
      chatWasVisible = true;
      chatWin.hide();   // 用 hide 而不是 minimize：hide 更彻底、也不会因为还原而把焦点抢回去盖住游戏
      dbg('[pet] 屏幕操作前先最小化对话窗（' + a.tool + '）—— 免得她看屏幕时只看到自己');
      await new Promise((r2) => setTimeout(r2, 600));   // 等窗口真的让开，抓帧才干净
    } catch { chatWasVisible = false; }
  }
  let r;
  try {
    r = await assistant.run(a.tool, a.arg);
  } finally {
    if (chatWasVisible) setTimeout(() => { try { if (chatWin && !chatWin.isDestroyed()) { chatWin.showInactive(); chatWin.setAlwaysOnTop(false); } } catch {} }, 500);
    if (yielded && yielded.length) setTimeout(() => restoreOwnWindows(yielded), 350);
    if (petHiddenForLook) setTimeout(() => { try { if (petWin && !petWin.isDestroyed()) petWin.show(); } catch {} }, 500);
  }
  const text = (r && typeof r === 'object') ? String(r.text || '') : String(r || '');
  const image = (r && typeof r === 'object') ? r.image : null;
  const action = (r && typeof r === 'object') ? r.action : null;
  // 工具结果可能很长（列目录 / 抓网页 / 截屏文字），入库前先截断，别把上下文撑爆。
  // 但「读」类工具的结果**就是模型要读的内容**，按普通上限截等于没读到
  // （技能说明被砍到 250 字，模型就会说"说明被截断了"然后乱找路）——所以按工具给不同上限。
  /* ⚠️ 这些上限决定"一次工具调用能给模型多少东西"。原来的 read_file=2500 太小：
   她要查一份 21KB 的干员总表得读 9 次（每次还占一轮对话），实测体验很差。
   调大到：技能正文 12000 字符（≈6000 token，技能是"刻意加载"的，值得）、
   普通读文件 6000（≈3000 token，比历史预算略小，不至于把上下文挤爆）。
   （另一条路是让文件方拆成小片，那边也做了 —— 两条一起用最稳。） */
      const READ_CAPS = { use_skill: 12000, skill_read: 12000, proj_read: 8000, read_file: 6000, skill_ls: 3000, proj_ls: 2000, list_dir: 3000 };
  const cap = READ_CAPS[a.tool] || ((config.load().memory || {}).toolResultChars) || 500;
  /* 【大输出溢出到文件，而不是硬截断】抄自 DSH 的 dsh-spill-policy：
     原来 tokens.clip 是**就地砍掉**，模型既不知道后面还有什么、也没办法去读回来。
     现在：超过内联预算就把**完整原文**写到 userData/spill/<id>.txt，
     回执 = 头 4000 字符 + 「[... 省略 N 字节（约 X%）。完整内容已存到：<路径> ...]」+ 尾 1000 字符。
     于是模型永远知道"有东西被省略了、省略了多少、去哪读回来"。
     ⚠️ 落盘失败时 spill 会**原样返回完整内容**（fail-open）—— 宁可回执长一点，绝不丢数据。 */
  const sp = require('./src/spill').spill(text, {
    dir: path.join(app.getPath('userData'), 'spill'),
    id: String(a.tool) + '-' + Date.now(),
    maxInlineBytes: Math.max(1500, cap * 3),   // 内联预算（cap 是"偏小"的旧值，这里给 3 倍余量）
  });
  memory.session.push({ role: 'user', content: `[系统] 我刚执行了操作 ${a.tool}（${a.arg}），结果如下：\n${sp.content}` });
  return {
    ok: true, result: text, image, action,
    target: (r && typeof r === 'object') ? r.target : null,
    yielded: !!(yielded && yielded.length), spilled: !!sp.spilled, spillPath: sp.path || '',
  };
}

function assistantContext() { return { tier: config.load().assistant || 'off' }; }

ipcMain.handle('assistant:inspect', async (_e, action) => actionExecutor.inspect(action, assistantContext()));
ipcMain.handle('assistant:approve', async (_e, action) => actionExecutor.approve(action, assistantContext()));
ipcMain.handle('assistant:run', async (_e, request) => {
  const outcome = await actionExecutor.execute(request, assistantContext());
  if (!outcome.ok) return outcome;
  return Object.assign({}, outcome.value, {
    decision: outcome.decision,
    reason: outcome.reason,
    risk: outcome.risk,
    actionId: outcome.actionId,
  });
});

/* 把动作参数里的第一个 x,y 抠出来（模型空间的坐标）。 */
function actionPointOf(arg) {
  try {
    const m = String(arg || '').match(/(\d+)\s*[,，]\s*(\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch { return null; }
}
/* 目标点被自己的窗口盖住就临时藏起来，返回被藏起来的窗口数组（没藏返回 null）。 */
function yieldOwnWindowsAt(tool, arg) {
  try {
    if (!['click', 'rclick', 'dclick', 'drag', 'scroll'].includes(String(tool))) return null;
    const p = actionPointOf(arg);
    if (!p) return null;
    const d = screen.getPrimaryDisplay();
    const cap = input.space();
    const dipX = p.x / cap.w * d.size.width, dipY = p.y / cap.h * d.size.height;
    const hidden = [];
    /* 只藏桌宠窗：对话窗是她在里面汇报进度的地方，藏掉用户会以为卡住了。
       （对话窗挡住目标的场景，交给提示词里那句"先点空白处/挪开窗口"去处理。） */
    const w = petWin;
    if (w && !w.isDestroyed() && w.isVisible()) {
      const b = w.getBounds();
      if (dipX >= b.x && dipX <= b.x + b.width && dipY >= b.y && dipY <= b.y + b.height) {
        w.hide(); hidden.push(w); markPetHidden('yield');
        dbg('[pet] 目标点(' + Math.round(dipX) + ',' + Math.round(dipY) + ')被桌宠窗遮挡 → 临时让开');
      }
    }
    return hidden.length ? hidden : null;
  } catch { return null; }
}
function restoreOwnWindows(list) {
  try { for (const w of (list || [])) if (w && !w.isDestroyed() && !w.isVisible()) w.show(); } catch {}
}

/* 多步任务的"续跑"专用精简提示词：
   续跑时不需要人设全文/记忆/技能目录/项目说明 —— 那些首轮已经给过了，
   每步都重发一遍纯属浪费（这是单次最贵的开销）。这里只留：短人设 + 工具 + 输出格式。 */
/* 多步任务：执行完一步后，把结果喂回模型，让它决定下一步或收尾 */
ipcMain.handle('chat:continue', async (e, _payload) => {
  const cfg = config.load();
  const messages = [
    { role: 'system', content: buildContinuePrompt(cfg) },
    ...memory.pickHistory(),
    { role: 'user', content: buildContinueUserPrompt() }
  ];
  const { reply, raw } = await genReply(cfg, messages);
  if (reply.en) memory.onAssistant(raw, reply.en);
  logTurn('', reply);   // 中间/最终回复也要进聊天记录，否则重开窗口看不到任务结果
  // 注意：续跑几乎都是从对话窗发起的，对话窗自己会渲染 —— 再 relayToChat 就会画两遍
  if (!isFromChat(e)) relayToChat({ who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
  /* 但对话窗**最小化/隐藏**时，用户屏幕上什么都看不到（只能听到声音）。
     这时把同一条回复用气泡推到立绘上 —— 这就是"做任务时立绘也要弹气泡"。 */
  bubbleOnPetIfChatHidden(reply);
  return reply;
});

/* 对话窗最小化/隐藏 → 把回复用气泡推到立绘上。
 * 为什么需要：多步任务的中间步骤只在对话窗里渲染（见上面 chat:continue 的注释），
 * 用户一旦把对话窗最小化，整段任务过程在屏幕上就是**不可见**的。
 * silent: true —— 朗读由对话窗那边负责，这里只要气泡，否则会读两遍。 */
function bubbleOnPetIfChatHidden(reply) {
  try {
    if (!petWin || petWin.isDestroyed() || !reply || !reply.en) return false;
    if (!chatWin || chatWin.isDestroyed()) return false;            // 没开对话窗：别的路径会管
    if (chatWin.isVisible() && !chatWin.isMinimized()) return false; // 对话窗看得见 → 不重复
    petWin.webContents.send('pet:say', Object.assign({}, reply, { silent: true }));
    dbg('[pet] 对话窗不可见 → 立绘弹气泡：' + String(reply.en).slice(0, 40));
    return true;
  } catch { return false; }
}

/* ---------------- 游戏助手（持续盯屏 + 决策 + 操作） ----------------
   平时完全关闭；用户对她说"打游戏"→ 她按 play-game 技能调 game_start 才会跑。 */
gameagent.init({
  onLog: (e) => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('game:log', e); },
  onStart: () => { petHideSticky = true; if (petWin && !petWin.isDestroyed()) petWin.hide(); },   // 开打先把桌宠收起来（sticky：托管期间看门狗不抢）
  onStop: () => { petHideSticky = false; if (petWin && !petWin.isDestroyed()) petWin.show(); },  // 结束把桌宠放回来并解除 sticky
  onFinish: (r) => {
    // 这趟的过程与结论进会话，交给已有的"经验提炼"在会话结束时消化，不另外造经验
    try {
      memory.session.push({
        role: 'user',
        content: '[系统] 游戏助手这趟的结果：' + r.summary + '\n（任务：' + String(r.task || '').slice(0, 120) + '）',
      });
    } catch {}
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('game:log', { kind: 'info', text: '📘 这趟已记进会话，收尾时会提炼成经验。', at: Date.now() });
  },
});
ipcMain.handle('game:start', async (_e, o) => gameagent.start(o || {}));
ipcMain.handle('game:stop', () => gameagent.stop());
ipcMain.handle('game:status', () => Object.assign(gameagent.status(), { userinput: userinput.state() }));

/* 桌宠窗口用语音接受了任务（带 ACTION）→ 把对话窗叫出来执行，别让她的承诺落空 */
ipcMain.on('pet:action', (_e, action) => {
  if (!action || !action.tool) return;
  dbg('[pet] 语音任务转交对话窗：' + action.tool + ' ' + (action.arg || ''));
  createChat();
  const send = () => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:runAction', action); };
  setTimeout(send, 1000);
  setTimeout(send, 2500);   // 兜底：窗口加载慢时再送一次（渲染层会去重）
});

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) { petWin.show(); petWin.focus(); }
  });

  app.whenReady().then(() => {
    dbg('[boot] v' + app.getVersion() + ' electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);
    /* IPC 集成测试只需要主进程 handler + 自己创建的隐藏测试页。
       禁止它顺带创建置顶桌宠窗、释放用户键盘、启动 TTS/屏幕捕获等生产副作用。 */
    if (process.env.DAYU_TEST_HEADLESS === '1') {
      dbg('[boot] headless integration mode: production startup skipped');
      return;
    }
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    mood.startupDecay();
    /* 基线和"离线多久"都应该**立刻**算，不能放进下面那个 9 秒的 setTimeout：
       ensureBaseline 在首次运行（stats.json 还没有 inited）时会按人设**重置**成基线，
       如果拖到 9 秒后才跑，这 9 秒里已经累积的偏移会被一起抹掉
       （实测：新装的桌宠头几轮数值走 50→51，9 秒后突然跳成傲娇基线 62，那 +1 就没了）。 */
    try {
      stats.ensureBaseline(loadPersona());   // 首次 / 人设变了 → 按人设给基线
      const sb = stats.load();
      const goneH = sb.lastSeen ? (Date.now() - sb.lastSeen) / 3600000 : 0;
      sb.lastSeen = Date.now();
      stats.save(sb);
      if (goneH > 6) dbg('[stats] boot 离线 ' + goneH.toFixed(1) + 'h');
    } catch (e) { dbg('[stats] boot baseline err ' + e); }
    /* 「主人接管鼠标」让位参数（改 config.json 后重启即生效） */
    try {
      const uy = config.load();
      userinput.setParams({
        enabled: uy.userYield !== false,
        calmMs: uy.userCalmMs,
        movePx: uy.userMovePx,
        pollMs: uy.userPollMs,
      });
    } catch (e) { dbg('[userinput] 参数设置失败 ' + e); }
    /* 【键盘自救】清一次上次异常退出/被杀留下的卡键。
     * 实测旧版 input.exe 只要键名写错（key ctrl+ / key ctrl+cmd）就会把 Ctrl 卡住，
     * 用户表现："输入不了东西、键盘像错位了，只能重启一次"。
     * 现在每次启动先松一遍修饰键，等于自动治好 —— 不用再重启。
     * 放启动早期：用户很可能一开机就发现键盘不对。 */
    try { input.releaseAll(); dbg('[input] 启动时释放卡键'); } catch (e) { dbg('[input] releaseAll 失败 ' + e); }
    /* 【启动兜底】保证她自己的窗口一定是可见的。
       我加的"看屏幕时藏起立绘窗 / 最小化对话窗"如果在热重载中途被打断，
       窗口就会**一直藏着**（实测发生过：进程还在、但桌面和任务栏都找不到她）。
       启动后几秒强制 show/restore 一次，把这种状态纠正回来。 */
    setTimeout(() => {
      try { if (petWin && !petWin.isDestroyed()) { if (!petWin.isVisible()) petWin.show(); } } catch {}
      try { startPetVisibilityWatchdog(); dbg('[boot] 立绘窗可见性看门狗已启动'); } catch (e) { dbg('[boot] 看门狗启动失败 ' + e); }
      /* 顺手清理过期的 spill（大输出溢出文件）—— 保留 7 天，免得越堆越多 */
      try { const dl = require('./src/spill').prune(require('path').join(app.getPath('userData'), 'spill'), 7); if (dl) dbg('[boot] 清理了 ' + dl + ' 个过期 spill 文件'); } catch {}
      try { if (chatWin && !chatWin.isDestroyed() && chatWin.isMinimized()) chatWin.restore(); } catch {}
      dbg('[boot] 启动兜底：确认自己的窗口可见');
      /* 顺手把"被卡成永久置顶"的窗口放下来（第一版 focus_window 的遗留问题）。
         只有管理员权限的进程做得到，所以由她启动时替用户清一次。 */
      try { require('./src/focuswin').clearAllTop(); dbg('[boot] 已清理所有窗口的置顶状态'); } catch (e) { dbg('[boot] 清置顶失败 ' + e); }
    }, 6000);
    /* 【临时】对讲机：外部普通权限进程没法给她发消息（UIPI），于是让她自己进程里的小钩子读文件转发。 */
    try { require('./src/intercom').install({ chatWin: () => chatWin, createChat, dbg }); } catch (e) { dbg('[intercom] install failed ' + e); }

    memory.onAppStart().catch((e) => dbg('[memory] onAppStart err ' + e));
    // 隐藏数值：时间效应（多久没见）+ 性格慢回归，然后按需补判一次
    setTimeout(() => {
      try {
        const st0 = stats.load();
        const awayH = st0.lastSeen ? (Date.now() - st0.lastSeen) / 3600000 : 0;
        if (awayH > 20) {
          stats.nudge('dependency', 0.6, 'away', '隔了好久没见，想主人了');
          /* 心情归 mood.js 管，不在 stats.META 里 —— stats.nudge('mood', …) 只会静默 return null，
             所以这句"有点寂寞"以前永远不生效，也没有任何报错。 */
          try { mood.adjust({ mood: -0.8 }); } catch {}
        }
        else if (awayH > 6) { stats.nudge('dependency', 0.3, 'away', '半天没见'); }
        const st1 = stats.load(); st1.lastSeen = Date.now(); stats.save(st1);
        const reg = stats.regress(0.2);
        if (awayH > 6 || reg.length) dbg('[stats] away=' + awayH.toFixed(1) + 'h regress=' + reg.length);
      } catch (e) { dbg('[stats] time effect err ' + e); }
      memory.judgeStatsNow().then((r) => { if (r) dbg('[stats] catch-up judged: ' + r.reason); }).catch(() => {});
    }, 9000);
    createPet();
    // 预热屏幕流：首帧更快。不想让系统一直显示"正在捕获"就把 memory.screenWarm 设 false
    if ((config.load().memory || {}).screenWarm !== false) screenstream.warm().catch(() => {});
    // 启动几秒后，默默把攒够权重的经验归档进技能文件夹（AI 自己整理）
    if ((config.load().memory || {}).skillAutoArchive !== false) {
      setTimeout(() => { archiveSkills().catch((e) => dbg('[skills] auto archive err ' + e)); }, 8000);
    }
    // 界面风格：没有就按人设生成一次；人设改过就按新人设重推（都在后台，不打扰用户）
    setTimeout(() => {
      style.ensure(llm, config.load(), loadPersona())
        .then((s) => { if (s && s.personaChanged) dbg('[style] 人设变了 -> 已重推风格：' + s.name); })
        .catch((e) => dbg('[style] ensure err ' + e));
    }, 5000);
    if (!config.load().apiKey) createChat();
  });

  app.on('before-quit', (e) => {
    /* 不管这次退出是不是要走"会话收尾"，都先把修饰键松开 ——
       她要是正按着 ctrl+c 的中途被退出，卡键会留给用户一整天。 */
    try { input.releaseAll(); } catch {}
    if (didSummarize) return;
    e.preventDefault();
    (async () => {
      try { await web.close(); } catch {}
      try { await memory.onSessionEnd(); } catch {}
      try { input.releaseAll(); } catch {}      // 收尾期间也可能刚发过按键
      didSummarize = true;
      app.quit();
    })();
  });

  app.on('window-all-closed', () => app.quit());

  // 开发模式热更新：改渲染层自动刷新窗口；改主进程/模块自动重启（打包版不生效）
  if (!app.isPackaged) {
    const deb = (fn, ms) => { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms || 500); }; };
    const reloadAll = deb(() => { BrowserWindow.getAllWindows().forEach((w) => { try { w.webContents.reload(); } catch {} }); });
    const relaunch = deb(() => { try { app.relaunch(); } catch {} app.exit(0); });
    try { fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, reloadAll); } catch {}
    try { fs.watch(path.join(__dirname, 'src'), { recursive: true }, relaunch); } catch {}
    try { fs.watch(__dirname, (_ev, f) => { if (f === 'main.js' || f === 'preload.js' || f === 'persona.json') relaunch(); }); } catch {}
  }
}

/* ---------------- 测试专用出口 ----------------
 * 测试脚本用 `require('../main.js')` **启动真应用**（单实例锁要求先停掉正在跑的桌宠），
 * 然后直接调这些函数驱动对话 —— 比走 IPC 少一层，也拿得到内部状态。
 * 正常运行时这些导出没有任何副作用。 */
module.exports = {
  petWinForTest: () => petWin,
  markPetHiddenForTest: (w) => markPetHidden(w),
  setPetHideStickyForTest: (v) => { petHideSticky = !!v; },
  buildSystemPrompt, buildContinuePrompt, genReply, logTurn, createChat, createPet, bubbleOnPetIfChatHidden, yieldOwnWindowsAt, restoreOwnWindows, loadPosition, savePosition, posFile,
  config, llm, memory, mood, stats, persona, personatags, petactions, speak,
  assistant, skills, projects, tts, asr, testlog, clock, userinput,
  actionExecutor, actionAuthority, actionAudit,
  win: () => ({ petWin, chatWin }),
};
