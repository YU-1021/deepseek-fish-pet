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
const screenstream = require('./src/screenstream');
const gameagent = require('./src/gameagent');
const skills = require('./src/skills');
const style = require('./src/style');
const projects = require('./src/projects');
const stats = require('./src/stats');
const persona = require('./src/persona');

const dbg = (msg) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {} };

let petWin = null;
let chatWin = null;
let didSummarize = false;
let allowChatClose = false;

const posFile = () => path.join(app.getPath('userData'), 'position.json');
const loadPosition = () => { try { return JSON.parse(fs.readFileSync(posFile(), 'utf8')); } catch { return null; } };
const savePosition = (x, y) => { try { fs.writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {} };
const loadPersona = () => persona.load();   // 人设现在放在 userData（AI 要能改它）

/* 记忆系统：依赖注入（记忆层不硬依赖 llm/config/persona，方便以后替换或单测） */
memory.init({ llm, config, persona: loadPersona, skillCatalog: () => skills.catalog() });
/* 存储层出错（读坏文件、写失败）必须留痕：以前这些全是静默的，出事了完全查不到 */
memory.bus.on('store:error', (e) => dbg('[store] ' + ((e && e.msg) || '')));

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
    let tools = '- open_url|https://...  (open a web page in the user\'s browser)\n- open_path|C:\\...  (open a file or app)\n- list_dir|C:\\...  (list a folder)\n- read_file|C:\\...  (read a text file)\n- use_skill|<skill id>  (load a skill\'s full instructions before doing the task)\n';
    if (tier === 'web' || tier === 'full') {
      tools += '- web_open|<url>  (open a page in a controlled browser and read its content)\n- web_click|<CSS selector>  (click an element on the current page)\n- web_type|<selector>||<text>  (type text into an input)\n- web_read  (read the current page content again)\n';
    }
    if (tier === 'full') {
      tools += '- screen_shot  (capture the user\'s screen and read any text on it — use this to "see" what is on screen before helping)\n';
      tools += '- screen_look|<question>  (send a screenshot to a vision model to actually see the layout/buttons/icons and get coordinates; falls back to reading text if no vision model is configured)\n';
      tools += '- click|x,y  (left-click; x,y are pixels in the 1280x720 screenshot, 0,0 = top-left)\n- rclick|x,y  (right-click)\n- dclick|x,y  (double-click)\n- move|x,y  (move mouse without clicking)\n- drag|x1,y1|x2,y2  (hold left button and drag from point 1 to point 2)\n- scroll|x,y|delta  (scroll wheel at position; +120 = up, -120 = down)\n- type|<text>  (type text into the currently focused field)\n- key|<name>  (press a key: enter / esc / tab / space / backspace / delete / up / down / left / right / home / end / f1..f12 / ctrl+c etc.)\n';
      tools += '- game_start|<game name + goal + strategy>  (ONLY when the user explicitly asks you to play a game for them — start the game assistant; it watches the screen and plays. Append ||<maxSteps> to cap steps. Read the play-game skill first.)\n- game_stop  (stop the game assistant immediately)\n- game_status  (check whether it is still playing)\n';
    }
    const auto = (tier === 'full') ? 'You are fully trusted: your actions run automatically without asking each time.' : 'The user must approve before it runs.';
    actionSec = '\n# Computer actions (AI assistant)\nYou may request ONE computer action per reply by adding a final line to your reply:\nACTION: <tool>|<argument>\nTools:\n' + tools + 'Only add the ACTION line when the user explicitly asks you to do something on their computer. ' + auto + ' Otherwise omit the line entirely.\nYou can do a multi-step task: give ONE action per reply; the system runs it, shows you the result, and asks you to continue until the task is done.\n';
  }
  const memCtx = memory.buildContext();
  const statSpec = stats.behaviorSpec();   // 隐藏数值 → 行为描述（不含数字）
  // 技能：只常驻一份"短目录"，命中时模型自己用 use_skill 把完整说明 load 进来（渐进式披露）
  let skillSec = '';
  if (tier !== 'off') {
    const cat = skills.catalog();
    if (cat) {
      skillSec = '\n# Skills (load on demand)\nYou have these skills. Here you only see names + one-line descriptions — you do NOT know their details yet.\n'
        + cat
        + '\nWhen the current request matches one of them, FIRST load it with a line:\nACTION: use_skill|<skill id>\nand then follow the loaded instructions. If nothing matches, just answer normally without loading anything.\n'
        + '\n# Managing the skill folders yourself\nA skill is a FOLDER under the skills directory. Its SKILL.md is the entry point; you may add sub-folders and files to organise accumulated experience.\n'
        + 'Keep SKILL.md as a short overview + index, and file detailed experience into sub-folders (e.g. <skill>/<mode>/<level>.md) instead of growing one file forever.\n'
        + 'Tools (paths are relative to the skills folder, e.g. arknights/集成战略/3-1.md):\n'
        + '- skill_ls|<path>            list a folder\n- skill_read|<path>          read a file\n- skill_write|<path>||<text> create or overwrite a file (folders are created automatically; write \\n for line breaks)\n- skill_rm|<path>            delete a file\n'
        + 'Only write when you actually learned something worth keeping, and keep entries short.\n';
    }
  }
  // 项目文件夹：她写的小软件落这儿（多行代码用 WRITE 块，前端确认后落盘）
  let projSec = '';
  if (tier !== 'off' && assistant.allowed(tier, 'proj_open')) {
    projSec = '\n# Project folder (where you build small apps)\nYou can write real code files into your project folder; the user can then open and use them.\n'
      + 'To create files, put one or more blocks anywhere in your reply:\n'
      + '<<<WRITE: <project>/index.html\n<the complete file content, real line breaks>\n>>>\n'
      + '(several blocks = several files; nothing is written until the user approves)\n'
      + 'Tools (paths are relative to the project folder): proj_ls|<path>  proj_read|<path>  proj_rm|<path>  proj_open|<path>  proj_run|<path>\n'
      + 'proj_run actually EXECUTES a file and returns its stdout/stderr — use it to test and debug your own scripts (.py .js .mjs .cjs .bat .cmd .ps1) and then fix them. For .html use proj_open (browser) instead.\n'
      + 'proj_open opens a file with the default app — for .html that is the browser, which is how you "run" a web app.\n'
      + 'Whenever you build an interface, follow your 「界面风格」 skill. Keep apps self-contained: one HTML file when possible, no CDN, no external images.\n';
  }
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

# 你的内在状态（内部参考。绝不要复述这些描述、也绝不要提数字，只要"就是这样"）
${statSpec}
${memCtx}${skillSec}${projSec}${actionSec}
# Output format — reply with EXACTLY these lines, no markdown, no extra text:
EN: <your English reply, 1-3 short sentences>
ZH: <完整中文翻译>
WORDS: <word1>=<IPA1>=<中文意思1>, <word2>=<IPA2>=<中文意思2>
C1: <a short English reply the user could say next>
C1ZH: <中文翻译 of C1>
C2: <another short English reply the user could say next>
C2ZH: <中文翻译 of C2>
MOOD: <2-6个字，你现在说这句话时的心情。这一行是隐藏的：用户看不到、也不会被读出来，只留给你下一轮参考自己当时什么情绪>

Rules:
- Each line must start with its exact label (EN:/ZH:/WORDS:/C1:/C1ZH:/C2:/C2ZH:).
- **每一条回复都必须写全这些行**（至少 EN + ZH + WORDS + C1 + C2），哪怕回复很短、只是"嗯一声"也一样。绝对不许只写 EN 就结束。
- 历史里带 "(earlier reply, abridged)" 前缀的是**旧记录的摘要**，不是回复范例，不要学它的格式。
- WORDS: 3-6 notable words from your EN reply, each as word=IPA=中文意思, comma separated.
- Do not use markdown, code fences, or anything else.
- **报错/失败/卡住的时候，语气可以照旧（傲娇、俏皮都行），但绝对不许为了卖萌把关键信息糊掉。** 这种时候 EN 仍然短，但 **ZH 那一行必须讲清三件事**：
  ① 到底哪一步没做成（比如"读文件"、"运行脚本"）；
  ② **真实原因**，照实说（找不到文件 / 路径不存在 / 没权限 / 缺某个程序没装 / 参数写错了…），不要含糊成"出了点小问题"；
  ③ 需要主人做什么（装个东西？给个正确路径？还是要你自己换个做法重试）。
  这种回复不受"1-3 句"限制，讲清楚优先。`;
}

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
ipcMain.handle('persona:set', (_e, patch) => persona.patch(patch || {}));   // 用户改：所有字段都能改
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
  });
  if (!j || !j.changed || !Object.keys(j.fields || {}).length) { dbg('[persona] 这次不需要改'); return null; }
  const r = persona.applyAI(j.fields);
  dbg('[persona] 演化 applied=[' + r.applied.join(',') + '] skipped=[' + r.skipped.join(',') + '] 因为：' + j.reason);
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
  const out = [];
  if (ok) {
    out.push(stats.nudge('iq', 0.3, 'task-ok', '独立办成了一件事'));
    out.push(stats.nudge('diligence', 0.3, 'task-ok', '认真办了事'));
  } else {
    out.push(stats.nudge('iq', -0.5, 'task-fail', '事情没办成'));
  }
  return { ok: true, applied: out.filter((x) => x && !x.skipped) };
});
ipcMain.handle('stats:get', () => ({ all: stats.all(), hidden: stats.HIDDEN, log: stats.recentLog(40), stepBudget: stats.stepBudget() }));

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
ipcMain.handle('assistant:run', async (_e, a) => {
  const tier = config.load().assistant || 'off';
  if (!assistant.allowed(tier, a && a.tool)) throw new Error('当前 AI 助手权限不允许该操作');
  const r = await assistant.run(a.tool, a.arg);
  const text = (r && typeof r === 'object') ? String(r.text || '') : String(r || '');
  const image = (r && typeof r === 'object') ? r.image : null;
  const action = (r && typeof r === 'object') ? r.action : null;
  // 工具结果可能很长（列目录 / 抓网页 / 截屏文字），入库前先截断，别把上下文撑爆。
  // 但「读」类工具的结果**就是模型要读的内容**，按普通上限截等于没读到
  // （技能说明被砍到 250 字，模型就会说"说明被截断了"然后乱找路）——所以按工具给不同上限。
  const READ_CAPS = { use_skill: 5000, skill_read: 5000, proj_read: 5000, read_file: 2500, skill_ls: 1200, proj_ls: 1200, list_dir: 2000 };
  const cap = READ_CAPS[a.tool] || ((config.load().memory || {}).toolResultChars) || 500;
  const cut = memory.tokens.clip(text, cap);
  memory.session.push({ role: 'user', content: `[系统] 我刚执行了操作 ${a.tool}（${a.arg}），结果如下：\n${cut}` });
  return { ok: true, result: text, image, action };
});

/* 多步任务的"续跑"专用精简提示词：
   续跑时不需要人设全文/记忆/技能目录/项目说明 —— 那些首轮已经给过了，
   每步都重发一遍纯属浪费（这是单次最贵的开销）。这里只留：短人设 + 工具 + 输出格式。 */
function buildContinuePrompt(cfg) {
  const p = loadPersona();
  const tier = cfg.assistant || 'off';
  let tools = '- open_url|https://...   - open_path|C:\\...   - list_dir|C:\\...   - read_file|C:\\...   - use_skill|<skill id>\n';
  tools += '- skill_ls|<path>   - skill_read|<path>   - skill_write|<path>||<text>   - skill_rm|<path>\n';
  tools += '- proj_ls|<path>   - proj_read|<path>   - proj_rm|<path>   - proj_open|<path>   - proj_run|<path>\n';
  if (tier === 'web' || tier === 'full') tools += '- web_open|<url>   - web_click|<css selector>   - web_type|<selector>||<text>   - web_read\n';
  if (tier === 'full') tools += '- screen_shot   - screen_look|<question>   - click|x,y   - rclick|x,y   - dclick|x,y   - move|x,y   - drag|x1,y1|x2,y2   - scroll|x,y|delta   - type|<text>   - key|<name>   - game_start|<game+goal+strategy>   - game_stop   - game_status\n';
  return `You are "${p.name || '大肥鱼'}", a desktop pet (${p.personality || '傲娇、温柔、嘴硬'}). Stay in character.
You are IN THE MIDDLE of a multi-step task the user asked for. Keep every line short.

# Computer actions
Add a final line: ACTION: <tool>|<argument>
Tools:
${tools}
# Output format
EN: <short English line>
ZH: <中文>
WORDS: <word=IPA=中文意思, ...>
MOOD: <2-6字心情>
(EN and ZH are always required, even for a one-word reply. "(earlier reply, abridged)" in the history is an old record, not a format example.)
Add "ACTION: <tool>|<argument>" as the LAST line only if you still need to do something; if the task is done, answer normally with no ACTION line.`;
}

/* 多步任务：执行完一步后，把结果喂回模型，让它决定下一步或收尾 */
ipcMain.handle('chat:continue', async (e, _payload) => {
  const cfg = config.load();
  const messages = [
    { role: 'system', content: buildContinuePrompt(cfg) },
    ...memory.pickHistory(),
    { role: 'user', content: '请继续。规则：\n① 如果上一步**失败或报错**了：先自己分析原因（参数/路径写错？环境缺东西？没权限？），能换个做法解决就再给一行 ACTION: <工具>|<参数> 重试（同一条路最多撞两次，别死磕）；确实解决不了，就用正常格式（EN/ZH/WORDS/C1/C2）上报——语气照旧，但 **ZH 必须照实讲清**：哪一步失败了、真实原因是什么（把报错的关键信息说出来，别只说"出错了"）、需要主人做什么。\n② 如果还没做完、还需要操作，就再给一行 ACTION: <工具>|<参数>（并在 EN: 里用一句简短说明）。\n③ 如果已经完成，直接按正常格式回答（EN/ZH/WORDS/C1/C2），不要带 ACTION。' }
  ];
  const { reply, raw } = await genReply(cfg, messages);
  if (reply.en) memory.onAssistant(raw, reply.en);
  logTurn('', reply);   // 中间/最终回复也要进聊天记录，否则重开窗口看不到任务结果
  // 注意：续跑几乎都是从对话窗发起的，对话窗自己会渲染 —— 再 relayToChat 就会画两遍
  if (!isFromChat(e)) relayToChat({ who: 'pet', en: reply.en, zh: reply.zh, words: reply.words, choices: reply.choices });
  return reply;
});

/* ---------------- 游戏助手（持续盯屏 + 决策 + 操作） ----------------
   平时完全关闭；用户对她说"打游戏"→ 她按 play-game 技能调 game_start 才会跑。 */
gameagent.init({
  onLog: (e) => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('game:log', e); },
  onStart: () => { if (petWin && !petWin.isDestroyed()) petWin.hide(); },   // 开打先把桌宠收起来，免得挡住点击
  onStop: () => { if (petWin && !petWin.isDestroyed()) petWin.show(); },    // 循环自己结束时把桌宠放回来
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
ipcMain.handle('game:status', () => gameagent.status());

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
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    mood.startupDecay();
    memory.onAppStart().catch((e) => dbg('[memory] onAppStart err ' + e));
    // 隐藏数值：时间效应（多久没见）+ 性格慢回归，然后按需补判一次
    setTimeout(() => {
      try {
        stats.ensureBaseline(loadPersona());   // 首次 / 人设变了 → 按人设给基线
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
