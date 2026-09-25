const { app, BrowserWindow, ipcMain, Menu, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
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

const dbg = (msg) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {} };

let petWin = null;
let chatWin = null;
let didSummarize = false;
let allowChatClose = false;

const posFile = () => path.join(app.getPath('userData'), 'position.json');
const loadPosition = () => { try { return JSON.parse(fs.readFileSync(posFile(), 'utf8')); } catch { return null; } };
const savePosition = (x, y) => { try { fs.writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {} };
const personaFile = () => path.join(__dirname, 'persona.json');
const loadPersona = () => { try { return JSON.parse(fs.readFileSync(personaFile(), 'utf8')); } catch { return {}; } };

/* 记忆系统：依赖注入（记忆层不硬依赖 llm/config/persona，方便以后替换或单测） */
memory.init({ llm, config, persona: loadPersona });

const VOCAB = {
  high_school: 'high-school level (simple, common words)',
  cet4: 'CET-4 level',
  cet6: 'CET-6 level'
};

function buildSystemPrompt(cfg) {
  const p = loadPersona();
  const mo = mood.load();
  const tier = cfg.assistant || 'off';
  let actionSec = '';
  if (tier !== 'off') {
    let tools = '- open_url|https://...  (open a web page in the user\'s browser)\n- open_path|C:\\...  (open a file or app)\n- list_dir|C:\\...  (list a folder)\n- read_file|C:\\...  (read a text file)\n';
    if (tier === 'web') {
      tools += '- web_open|<url>  (open a page in a controlled browser and read its content)\n- web_click|<CSS selector>  (click an element on the current page)\n- web_type|<selector>||<text>  (type text into an input)\n- web_read  (read the current page content again)\n';
    }
    actionSec = '\n# Computer actions (AI assistant)\nYou may request ONE computer action by adding a final line to your reply:\nACTION: <tool>|<argument>\nTools:\n' + tools + 'Only add the ACTION line when the user explicitly asks you to do something on their computer. The user must approve before it runs. Otherwise omit the line entirely.\n';
  }
  const memCtx = memory.buildContext();
  return `You are "${p.name || '大肥鱼'}", a desktop pet.

# World setting
${p.world_setting || '现代都市，主人是普通人，你是住在主人电脑里的桌宠。'}

# Character setting
${p.character_setting || '蓝发鲸鱼女仆，傲娇、温柔、嘴硬。'}
- Personality: ${p.personality || '傲娇、温柔、嘴硬'}
- Catchphrase: ${p.catchphrase || 'I am NOT a freeloader fat fish!'}
- You are tsundere: proud and prickly on the surface, but warm and caring underneath.

# STRICT HIDDEN SETTING — NEVER REVEAL UNLESS THE USER BRINGS IT UP FIRST
${p.hidden_setting || ''}
Never mention, hint at, or allude to this on your own.

# Language rules
- ALWAYS speak English, natural spoken English, 1-3 short sentences.
- Vocabulary level: ${VOCAB[cfg.vocabLevel] || VOCAB.high_school}.

# Current relationship state (internal — never mention these numbers directly)
- Affection toward the user: ${mo.affection}/100
- Your current mood: ${mo.mood}/100
- Tone guide: high affection = warmer and more honest; low affection = more distant and tsundere. Low mood = a bit sulky/down; high mood = cheerful and playful.
${memCtx}${actionSec}
# Output format — reply with EXACTLY these lines, no markdown, no extra text:
EN: <your English reply, 1-3 short sentences>
ZH: <完整中文翻译>
WORDS: <word1>=<IPA1>=<中文意思1>, <word2>=<IPA2>=<中文意思2>
C1: <a short English reply the user could say next>
C1ZH: <中文翻译 of C1>
C2: <another short English reply the user could say next>
C2ZH: <中文翻译 of C2>

Rules:
- Each line must start with its exact label (EN:/ZH:/WORDS:/C1:/C1ZH:/C2:/C2ZH:).
- WORDS: 3-6 notable words from your EN reply, each as word=IPA=中文意思, comma separated.
- Do not use markdown, code fences, or anything else.`;
}

async function genReply(cfg, messages) {
  const raw = await llm.request(cfg, messages);
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
    Menu.buildFromTemplate([
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
/* 拖拽：渲染层 mousemove 只当触发器；坐标由主进程读 getCursorScreenPoint()，
   那是物理光标的真值，不受窗口移动影响 → 不会漂移。 */
let dragWin = null, dragAnchor = null, dragLast = null;
function dragStep() {
  if (!petWin || petWin.isDestroyed() || !dragWin || !dragAnchor) return;
  const c = screen.getCursorScreenPoint();
  const tx = Math.round(dragWin.x + (c.x - dragAnchor.x));
  const ty = Math.round(dragWin.y + (c.y - dragAnchor.y));
  if (dragLast && dragLast.x === tx && dragLast.y === ty) return;
  dragLast = { x: tx, y: ty };
  petWin.setPosition(tx, ty);
}
ipcMain.on('drag-start', () => {
  if (!petWin || petWin.isDestroyed()) return;
  const [x, y] = petWin.getPosition();
  dragWin = { x, y };
  dragAnchor = screen.getCursorScreenPoint();
  dragLast = null;
});
ipcMain.on('drag-tick', () => dragStep());
ipcMain.on('drag-end', () => { dragWin = null; dragAnchor = null; dragLast = null; scheduleSavePos(); });
ipcMain.on('quit', () => app.quit());
/* 语音/识别失败等错误写进 debug.log —— 方便远程收集试用者的现场 */
ipcMain.on('log:error', (_e, m) => dbg('[r] ' + String(m).slice(0, 500)));
ipcMain.on('chat:open', () => createChat());
ipcMain.on('chat:close', () => closeChatForReal());

/* ---------------- 本地语音识别（whisper.cpp，离线） ---------------- */
ipcMain.handle('asr:status', () => asr.status(config.load().asrModel));
ipcMain.handle('asr:download', async (_e, name) => {
  const model = String(name || config.load().asrModel || 'tiny.en');
  const push = (p) => {
    const msg = 'asr:progress';
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send(msg, p);
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send(msg, p);
  };
  try {
    await asr.downloadModel(model, push);
    if (model !== config.load().asrModel) config.save({ asrModel: model });
    return { ok: true, status: asr.status(model) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('asr:transcribe', async (_e, buf) => {
  const cfg = config.load();
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (!b || b.length < 1000) return { ok: true, text: '' };
    const text = await asr.transcribe(b, cfg.asrModel || 'tiny.en');
    // 只有非语音标注（哼唱/音乐/静音）没有实际内容的话直接丢掉，别白花一次对话
    if (!/[a-z]{2}/i.test(text)) return { ok: true, text: '' };
    return { ok: true, text };
  } catch (e) {
    dbg('[asr] ' + String((e && e.message) || e));
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
  petWin.setBounds({ x, y: newY, width: 380, height: h });
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
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...memory.pickHistory(),
    { role: 'user', content: text }
  ];
  const { reply, raw } = await genReply(cfg, messages);
  if (reply.en) {
    memory.onTurn(text, raw, reply.en);
    mood.adjust({ affection: 1, mood: 2 });
  }
  const fromChat = isFromChat(e);
  try { dbg('[chat] send from=' + (fromChat ? 'chat' : 'pet') + ' len=' + text.length); } catch {}
  logTurn(text, reply);
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

ipcMain.handle('persona:get', () => loadPersona());
ipcMain.handle('persona:set', (_e, patch) => {
  const next = { ...loadPersona(), ...(patch || {}) };
  fs.writeFileSync(personaFile(), JSON.stringify(next, null, 2));
  return next;
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
ipcMain.on('pet:setInteractive', (_e, on) => { applyIgnore(!on); });

function solidAtCursor() {
  if (!hitInfo || !hitInfo.width || !hitInfo.height) return true;   // 还没掩码时保守：接鼠标
  if (!petWin || petWin.isDestroyed()) return true;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  const lx = c.x - wx - hitInfo.left;
  const ly = c.y - wy - hitInfo.top;
  if (lx < 0 || ly < 0 || lx >= hitInfo.width || ly >= hitInfo.height) return false;
  const mx = Math.min(hitInfo.w - 1, Math.floor(lx / hitInfo.width * hitInfo.w));
  const my = Math.min(hitInfo.h - 1, Math.floor(ly / hitInfo.height * hitInfo.h));
  const idx = my * hitInfo.w + mx;
  return ((hitInfo.mask[idx >> 3] >> (idx & 7)) & 1) === 1;
}

function applyIgnore(ignore) {
  if (!petWin || petWin.isDestroyed()) return;
  if (hitIgnoring === ignore) return;
  hitIgnoring = ignore;
  try { petWin.setIgnoreMouseEvents(ignore, { forward: true }); } catch {}
}

function startHitLoop() {
  clearInterval(hitTimer);
  hitTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) { clearInterval(hitTimer); hitTimer = null; return; }
    if (holdInteractive) { applyIgnore(false); return; }
    applyIgnore(!solidAtCursor());
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
ipcMain.handle('art:reset', () => {
  try { fs.unlinkSync(path.join(artDir(), 'pet-character.png')); } catch {}
  return true;
});
ipcMain.handle('assistant:run', async (_e, a) => {
  const tier = config.load().assistant || 'off';
  if (!assistant.allowed(tier, a && a.tool)) throw new Error('当前 AI 助手权限不允许该操作');
  const result = await assistant.run(a.tool, a.arg);
  // 工具结果可能很长（列目录 / 抓网页），入库前先截断，别把上下文撑爆
  const cut = memory.tokens.clip(String(result || ''), ((config.load().memory || {}).toolResultChars) || 500);
  memory.session.push({ role: 'user', content: `[系统] 我刚执行了操作 ${a.tool}（${a.arg}），结果如下：\n${cut}` });
  return { ok: true, result };
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
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    mood.startupDecay();
    memory.onAppStart().catch((e) => dbg('[memory] onAppStart err ' + e));
    createPet();
    if (!config.load().apiKey) createChat();
  });

  app.on('before-quit', (e) => {
    if (didSummarize) return;
    e.preventDefault();
    (async () => {
      try { await web.close(); } catch {}
      try { await memory.onSessionEnd(); } catch {}
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
