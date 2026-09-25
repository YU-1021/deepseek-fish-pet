const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const REACTIONS = [
  { en: 'Hmph! I am NOT a freeloader fat fish!', zh: '哼！我才不是吃白饭的大肥鱼！' },
  { en: 'H-hey, stop poking me...', zh: '喂、喂，别乱戳我……' },
  { en: 'W-what? I did not hear anything!', zh: '什么？我什么都没听见！' },
  { en: 'You worked hard today... n-not that I care.', zh: '你今天很努力……才、才不是关心你呢。' },
  { en: 'Poke me again and I will get angry!', zh: '再戳我我可要生气了！' }
];

const PAT_LINES = [
  { en: 'H-hey! I am not a child... but fine, a little longer.', zh: '喂！我可不是小孩子……算了，再摸一会儿。' },
  { en: 'Mm... that is... acceptable. D-do not stop.', zh: '唔……还、还可以，别停下。' },
  { en: 'Dummy. You are messing up my hair.', zh: '笨蛋，把我头发都弄乱了。' }
];
const FEED_LINES = [
  { en: 'F-fish treats?! ...I-I will take them. Not because I like them!', zh: '小、小鱼干？！……我、我收下了，才不是因为我喜欢！' },
  { en: 'Hmph, finally something decent. Give me more.', zh: '哼，总算有点像样的东西。再来一条。' },
  { en: 'Mmph... salty. ...I said it is fine, alright?!', zh: '唔……好咸。……我说了还行啦！' }
];
const FULL_LINE = { en: 'I-I am full! Stop stuffing me!', zh: '吃、吃撑了！别再塞了！' };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
try { window.petAPI.logErr('pet boot SR=' + !!SR + ' lang=' + navigator.language); } catch {}

let hideTimer = null;
let listening = true, chatOpen = false, rec = null, busy = false, curUtter = null;
let clickCount = 0, clickTimer = null, lastMicErr = 0, pokeCount = 0, pokeTimer = null;
let petting = false, petAccum = 0, lastPetX = 0, patCd = 0, patFired = false, feedCount = 0, feedTimer = null, holding = false;

/* ---------------- 互动特效 ---------------- */
function fx(emoji, x, y, cls) {
  try {
    const d = document.createElement('div');
    d.className = 'fx ' + (cls || 'floatUp');
    d.textContent = emoji;
    d.style.left = Math.round(x) + 'px';
    d.style.top = Math.round(y) + 'px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  } catch {}
}

function pokeBody() {
  const r = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
  showReply({ en: r.en, zh: r.zh }, 6000);
  pokeCount++;
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => { pokeCount = 0; }, 8000);
  if (window.petAPI.moodAdjust) window.petAPI.moodAdjust({ mood: pokeCount >= 5 ? -3 : 1 });
}

function patTrigger(x, y) {
  fx('💗', x, y);
  setTimeout(() => fx('💕', x - 26 + Math.random() * 52, y - 4), 150);
  patFired = true;
  const now = Date.now();
  if (now - patCd < 4000) return; // 冷却：连着摸不重复刷 API
  patCd = now;
  if (window.petAPI.moodAdjust) window.petAPI.moodAdjust({ mood: 3, affection: 1 });
  const fb = () => {
    const r = PAT_LINES[Math.floor(Math.random() * PAT_LINES.length)];
    showReply({ en: r.en, zh: r.zh }, 6000);
  };
  // 反应由模型按当前人设生成；不可用时退回本地台词
  if (window.petAPI.chatReact) window.petAPI.chatReact('pat').catch(fb);
  else fb();
}

function feedFish() {
  fx('🐟', 48, window.innerHeight - 70, 'flyIn');
  setTimeout(() => {
    const r = pet.getBoundingClientRect();
    fx('✨', r.left + r.width / 2, r.top + r.height * 0.32);
  }, 800);
  feedCount++;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => { feedCount = 0; }, 60000);
  const full = feedCount > 3;
  if (window.petAPI.moodAdjust) window.petAPI.moodAdjust(full ? { mood: -1 } : { mood: 6, affection: 2 });
  setTimeout(() => {
    const fb = () => {
      const line = full ? FULL_LINE : FEED_LINES[Math.floor(Math.random() * FEED_LINES.length)];
      showReply({ en: line.en, zh: line.zh }, 7000);
    };
    if (window.petAPI.chatReact) window.petAPI.chatReact('feed').catch(fb);
    else fb();
  }, full ? 400 : 850);
}

/* ---------------- 悬停音标提示 ---------------- */
let tip = null;
function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'tip';
  document.body.appendChild(tip);
  return tip;
}
function hideTip() { if (tip) tip.classList.remove('show'); }
function positionTip(e) {
  const r = tip.getBoundingClientRect();
  const pad = 12;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight) y = e.clientY - r.height - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function renderEn(text, words) {
  const map = {};
  (words || []).forEach((w) => { const k = (w.w || '').toLowerCase().replace(/[^a-z']/g, ''); if (k) map[k] = w; });
  return String(text || '').split(/(\s+)/).map((tok) => {
    const m = tok.match(/^([A-Za-z']+)([^A-Za-z']*)$/);
    if (m) {
      const w = map[m[1].toLowerCase()];
      if (w) return `<span class="w" data-ipa="${esc(w.ipa)}" data-zh="${esc(w.zh)}">${esc(m[1])}</span>${esc(m[2])}`;
      return esc(tok);
    }
    return esc(tok);
  }).join('');
}

/* ---------------- 气泡 ---------------- */
function showReply(reply, hold) {
  let html = `<div class="en">${renderEn(reply.en, reply.words)}</div>`;
  if (reply.zh) html += `<div class="zh">${esc(reply.zh)}</div>`;
  if (reply.choices && reply.choices.length) {
    html += `<div class="choices">` + reply.choices.map((c, i) =>
      `<button data-i="${i}" title="${esc(c.ipa)}"><span class="en">${esc(c.en)}</span><span class="meta">${esc(c.zh)}</span></button>`
    ).join('') + `</div>`;
  }
  bubble.innerHTML = html;
  bubble.classList.add('show');
  fitWindow();
  pet.classList.add('bounce');
  setTimeout(() => pet.classList.remove('bounce'), 600);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { bubble.classList.remove('show'); fitWindow(); }, hold || 10000);

  bubble.querySelectorAll('.choices button').forEach((b) => {
    b.addEventListener('click', () => {
      const c = reply.choices[+b.dataset.i];
      if (c && c.en) sendText(c.en);
    });
  });
  if (reply.silent) { stopSpeech(); busy = false; resumeListening(); }
  else speak(reply.en);
}

bubble.addEventListener('mouseover', (e) => {
  const el = e.target.closest('.w');
  if (!el) { hideTip(); return; }
  const ipa = el.dataset.ipa, zh = el.dataset.zh;
  if (!ipa && !zh) return;
  const t = ensureTip();
  t.innerHTML = (ipa ? `<div class="ipa">${esc(ipa)}</div>` : '') + (zh ? `<div class="zh">${esc(zh)}</div>` : '');
  t.classList.add('show');
  positionTip(e);
});
bubble.addEventListener('mousemove', (e) => { if (tip && tip.classList.contains('show')) positionTip(e); });
bubble.addEventListener('mouseleave', hideTip);

/* ---------------- TTS（Edge 神经音色，失败时退回系统语音） ---------------- */
let curAudio = null;
let speakSeq = 0;

function stopSpeech() {
  speakSeq++;
  if (curAudio) { try { curAudio.pause(); } catch {} curAudio = null; }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
}

function speakFallback(text, seq, done) {
  if (seq !== speakSeq || !window.speechSynthesis) { done(); return; }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.95; u.pitch = 1.15;
    curUtter = u;
    const fin = () => { if (curUtter === u) curUtter = null; done(); };
    u.onend = fin; u.onerror = fin;
    window.speechSynthesis.speak(u);
  } catch { done(); }
}

async function speak(text) {
  if (!text) { busy = false; resumeListening(); return; }
  pauseListening();
  stopSpeech();
  const seq = speakSeq;
  const done = () => { if (seq === speakSeq) { busy = false; resumeListening(); } };
  let ok = false;
  try {
    const cfg = await window.petAPI.configGet();
    if (cfg && cfg.ttsEnabled === false) { done(); return; }
    const res = await window.petAPI.ttsSpeak({ text });
    if (seq !== speakSeq) return;
    if (res && res.ok && res.dataUrl) {
      try {
        const a = new Audio(res.dataUrl);
        curAudio = a;
        a.onended = () => { if (curAudio === a) curAudio = null; done(); };
        a.onerror = () => { if (curAudio === a) curAudio = null; done(); };
        await a.play();
        ok = true;
      } catch (e) { console.warn('[TTS]', e); }
    } else if (res && res.error) console.warn('[TTS]', res.error);
  } catch (e) { console.warn('[TTS]', e); }
  if (ok || seq !== speakSeq) return;
  speakFallback(text, seq, done);
}

async function sendText(text) {
  text = String(text || '').trim();
  if (!text || busy) return;
  busy = true;
  pauseListening();
  const safety = setTimeout(() => { if (busy) { busy = false; resumeListening(); } }, 30000);
  try {
    await window.petAPI.chatSend({ text });
    // 回复通过 onSay 展示，busy 在 speak 结束时清除
  } catch (e) {
    showReply({ en: 'Sorry, something went wrong: ' + e.message, zh: '' }, 6000);
    busy = false;
    resumeListening();
  } finally {
    clearTimeout(safety);
  }
}

/* ---------------- 持续收音：优先本地 whisper（离线，不依赖网络） ----------------
   本地模型在就直接常驻听 + 能量 VAD 切句；不在就退回浏览器在线识别。 */
let listenMode = '';          // 'whisper' | 'web'
let listenStarting = false;
let asrCfg = null, asrCfgAt = 0;
let asrBusy = false;

async function asrStatusCached() {
  if (asrCfg && Date.now() - asrCfgAt < 20000) return asrCfg;
  try { asrCfg = await window.petAPI.asrStatus(); asrCfgAt = Date.now(); } catch {}
  return asrCfg;
}

async function startListening() {
  if (!listening || chatOpen || busy || listenStarting || rec) return;
  if (listenMode === 'whisper' && window.PetASR && window.PetASR.isOpen()) return;
  if (window.PetASR && window.PetASR.supported()) {
    listenStarting = true;
    const st = await asrStatusCached();
    listenStarting = false;
    if (!listening || chatOpen || busy) return;
    if (st && st.binary && st.hasModel) {
      try {
        await window.PetASR.startAlwaysOn(onUtterance);
        listenMode = 'whisper';
        try { window.petAPI.logErr('pet listen: whisper ' + st.model); } catch {}
        return;
      } catch (e) {
        try { window.petAPI.logErr('pet whisper start fail: ' + ((e && e.message) || e)); } catch {}
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          try { window.petAPI.micNeedPermission(e.name); } catch {}
          return;
        }
      }
    }
  }
  startWebListening();
}

/* 本地识别：VAD 切出一段话 → 送 whisper → 直接进对话（不弹窗、不用确认） */
async function onUtterance(wav) {
  if (!wav || asrBusy || busy || chatOpen) return;
  asrBusy = true;
  try {
    const r = await window.petAPI.asrTranscribe(wav);
    if (r && r.ok && r.text) {
      try { window.petAPI.logErr('pet asr OK(len=' + r.text.length + '): ' + r.text.slice(0, 80)); } catch {}
      sendText(r.text);
    } else if (r && !r.ok) {
      try { window.petAPI.logErr('pet asr fail: ' + r.error); } catch {}
    }
  } catch (e) {
    try { window.petAPI.logErr('pet asr throw: ' + ((e && e.message) || e)); } catch {}
  } finally { asrBusy = false; }
}

function startWebListening() {
  listenMode = 'web';
  if (!SR || !listening || chatOpen || rec) return;
  try {
    rec = new SR();
    rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = false;
    rec.onresult = (e) => { const t = (e.results?.[0]?.[0]?.transcript || '').trim(); if (t) { try { window.petAPI.logErr('pet asr OK len=' + t.length); } catch {} sendText(t); } };
    rec.onend = () => { rec = null; if (listening && !chatOpen && !busy) setTimeout(startListening, 300); };
    rec.onerror = (e) => {
      rec = null;
      const err = (e && e.error) || '';
      try { window.petAPI.logErr('pet asr fail: ' + err + ' SR=' + !!SR + ' lang=' + navigator.language); } catch {}
      // 没授权 / 没设备 → 弹对话窗的授权面板，让用户去开权限
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
        try { window.petAPI.micNeedPermission(err); } catch {}
      }
      const now = Date.now();
      if (now - lastMicErr > 30000) {
        lastMicErr = now;
        const msg = {
          'not-allowed': '麦克风未授权，我弹出授权界面了',
          'audio-capture': '没有检测到麦克风设备',
          'network': '在线识别连不上网，去对话窗下载本地语音模型就能离线识别',
        }[err];
        if (msg) showReply({ en: 'Mic: ' + msg, zh: '麦克风：' + msg }, 6000);
      }
      if (err === 'network') {
        // 别再高频重试，等 30 秒（期间用户可以去下载离线模型）
        setTimeout(() => { if (listening && !chatOpen && !busy) startListening(); }, 30000);
        return;
      }
      if (listening && !chatOpen && !busy && err !== 'not-allowed') setTimeout(startListening, 1500);
    };
    rec.start();
  } catch {}
}
function pauseListening() {
  listening = false;
  try { window.PetASR && window.PetASR.stopAlwaysOn(); } catch {}
  try { rec?.stop(); } catch {}
  rec = null;
}
function resumeListening() { if (chatOpen || busy) return; listening = true; startListening(); }

/* ---------------- 拖拽 / 摸头 / 戳（全区域） ----------------
   拖拽：mousemove 只当触发器，主进程读真实光标坐标来算目标位置，
   所以窗口移动不会影响坐标（不会漂移）。 */
let dragging = false, dragMoved = 0;

pet.addEventListener('mousedown', (e) => {
  holding = true;
  try { window.petAPI.hold(true); } catch {}   // 按住期间强制窗口可交互，别拖到一半被穿透打断
  const r = pet.getBoundingClientRect();
  if ((e.clientY - r.top) / Math.max(1, r.height) < 0.42) {
    petting = true; petAccum = 0; lastPetX = e.clientX; patFired = false;   // 头部：左右滑 = 摸头
  } else {
    dragging = true; dragMoved = 0;                                          // 身体：按住拖窗口
    window.petAPI.dragStart();
  }
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  updateHit(e.clientX, e.clientY);   // 先决定窗口要不要接鼠标 + 记下摸到哪个部位
  if (petting) {
    petAccum += Math.abs(e.clientX - lastPetX);
    lastPetX = e.clientX;
    if (petAccum >= 55) { petAccum = 0; patTrigger(e.clientX, e.clientY); }
    return;
  }
  if (!dragging) return;
  dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
  window.petAPI.dragTick();
});
window.addEventListener('mouseup', () => {
  holding = false;
  try { window.petAPI.hold(false); } catch {}
  if (petting) {
    petting = false;
    if (!patFired) pokeBody();          // 头部点一下 = 戳
    return;
  }
  if (!dragging) return;
  dragging = false;
  window.petAPI.dragEnd();
  if (dragMoved < 6) pokeBody();        // 身体点一下 = 戳
});
window.addEventListener('mouseleave', () => { try { updateHit(-1, -1); } catch {} });

// 连点 15 下才打开对话窗口（避免误触）
pet.addEventListener('click', () => {
  clickCount++;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clickCount = 0; }, 2500);
  if (clickCount >= 15) { clickCount = 0; window.petAPI.openChat(); }
});

/* ---------------- 跨窗口 ---------------- */
if (window.petAPI.onSay) window.petAPI.onSay((reply) => { if (reply && reply.en) showReply(reply); });
if (window.petAPI.onChatState) window.petAPI.onChatState((open) => { chatOpen = open; if (open) pauseListening(); else resumeListening(); });
if (window.petAPI.onFeed) window.petAPI.onFeed(() => feedFish());
if (window.petAPI.onPat) window.petAPI.onPat(() => {
  const r = pet.getBoundingClientRect();
  patTrigger(r.left + r.width / 2, r.top + r.height * 0.22);
});
/* 右键菜单「🎤 麦克风检测」：先快速测权限，不行就打开对话窗的语音自检面板 */
if (window.petAPI.onMicCheck) window.petAPI.onMicCheck(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    try { window.petAPI.logErr('pet mic check: granted'); } catch {}
    showReply({ en: 'Mic works. Go ahead, talk to me.', zh: '麦克风正常，可以跟我说话了。（想查得更细：右键 → 打开对话 → 点顶部 🎤）' }, 8000);
  } catch (e) {
    const name = (e && e.name) || 'not-allowed';
    try { window.petAPI.logErr('pet mic check: ' + name); } catch {}
    showReply({ en: 'Mic is blocked (' + name + '). Opening the panel…', zh: '麦克风被挡住了（' + name + '），我把语音自检打开。' }, 8000);
    try { window.petAPI.micNeedPermission(name); } catch {}
  }
});

/* ---------------- DSH 会话联动 ---------------- */
const DSH_LINES = {
  start: { en: 'Master is working on a DSH task... I will keep quiet.', zh: '主人开始忙 DSH 任务了……我安静看着。' },
  done: { en: 'The task looks finished. Good job... n-not that I was watching!', zh: '任务好像完成了。干得不错……才、才没有一直盯着看呢！' }
};
let dshPrev = { active: false, state: 'idle' };
setInterval(async () => {
  if (chatOpen || busy) return;
  let s;
  try { s = await window.petAPI.dshState(); } catch { return; }
  if (!s || !s.ok) return;
  const was = dshPrev;
  dshPrev = { active: s.active, state: s.state };
  if (!s.active && was.active) showReply(DSH_LINES.done, 8000);
  else if (s.active && s.state === 'working' && !(was.active && was.state === 'working')) showReply(DSH_LINES.start, 6000);
}, 6000);

/* ---------------- 启动 ---------------- */
function hardGreet() {
  showReply({
    en: "Hmph! I am NOT a freeloader fat fish. ...Anyway, good morning, Master.",
    zh: '哼！我才不是吃白饭的大肥鱼。……总之，早上好，主人。',
    words: [
      { w: 'freeloader', ipa: '/ˈfriːləʊdə/', zh: '白吃白喝的人' },
      { w: 'anyway', ipa: '/ˈeniweɪ/', zh: '总之' }
    ],
    choices: [
      { en: 'Good morning! I slept great.', zh: '早上好！我睡得很好。', ipa: '/ɡʊd ˈmɔːnɪŋ! aɪ slept ɡreɪt/' },
      { en: 'Morning! A bit sleepy though.', zh: '早！不过还有点困。', ipa: '/ˈmɔːnɪŋ! ə bɪt ˈsliːpi ðəʊ/' }
    ]
  });
}

(async function init() {
  const cfg = await window.petAPI.configGet();
  // 如果上次是断电/强杀，这里会把"还没结束的会话"接上，就不要再重复打招呼了
  let resumed = false;
  try {
    const s = await window.petAPI.memorySession();
    resumed = !!(s && s.resumed && s.count > 0);
  } catch {}
  if (resumed) {
    // 接着上次聊：安静等着，不刷问候
  } else if (cfg.apiKey) {
    try { showReply(await window.petAPI.chatGreet()); }
    catch { hardGreet(); }
  } else {
    hardGreet();
  }
  startListening();
})();

/* ---------------- 立绘缩放（摁住鼠标左键 + 滚轮：上=变大 / 下=变小） ---------------- */
const MIN_SIZE = 120, MAX_SIZE = 350;
function fitWindow() {
  try {
    const wrap = document.getElementById('wrap');
    window.petAPI.resize(wrap.offsetHeight + 4);
  } catch {}
}
let petSize = Number(localStorage.getItem('petSize')) || 350;
petSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, petSize));
function applySize() {
  pet.style.width = petSize + 'px';
  fitWindow();
  setTimeout(() => { try { buildHitCanvas(); } catch {} }, 60);   // 等布局稳定后重建命中图
}
function setSize(v) {
  petSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(v)));
  applySize();
  localStorage.setItem('petSize', String(petSize));
}
applySize();
window.addEventListener('wheel', (e) => {
  if (!holding) return;
  e.preventDefault();
  if (!e.deltaY) return;
  setSize(petSize + (e.deltaY < 0 ? 16 : -16));
}, { passive: false });
window.addEventListener('blur', () => {
  holding = false;
  if (petting) petting = false;
});

/* ---------------- 外部立绘热更新（免打包换图） ---------------- */
let artMtime = -1;
let artFallback = false;
async function loadArt() {
  try {
    const a = await window.petAPI.artGet();
    // 一律用 dataUrl：file:// 的图会把 canvas 标记为不可读，像素级命中就做不了
    if (a && a.ok && a.dataUrl && a.mtime !== artMtime) {
      artMtime = a.mtime;
      pet.src = a.dataUrl;
    } else if ((!a || !a.ok) && !artFallback) {
      artFallback = true;
      pet.src = '../assets/pet-character.png';
    }
  } catch {}
}

/* ---------------- 命中判定（透明区点穿 + 命名区块） ----------------
 * 实测：Electron 的 setIgnoreMouseEvents(true, {forward:true}) 在本机并不把
 * mousemove 转发进来（渲染层一条都收不到），所以"要不要接鼠标"的判定不能放这里。
 * 方案：把立绘 alpha 压成 1bit 小掩码 → 交给主进程；主进程按全局光标轮询决定穿透。
 * 命名区块仍在这里算（窗口可交互时才需要知道摸到哪个部位），给以后交互系统用。
 */
let hitCanvas = null, hitCtx = null, hitReady = false;
let curRegion = null;            // 当前命中的部位

function buildHitCanvas() {
  try {
    const w = pet.offsetWidth, h = pet.offsetHeight;
    if (!w || !h || !pet.naturalWidth) return;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(pet, 0, 0, w, h);
    g.getImageData(0, 0, 1, 1);      // canvas 被污染时这里会抛
    hitCanvas = c; hitCtx = g; hitReady = true;
    sendHitMask();
  } catch { hitReady = false; }
}

/* 把 alpha 压成 64xN 的 1bit 掩码发给主进程（约 0.7KB，缩放/换图时重发） */
function sendHitMask() {
  try {
    if (!hitReady) return;
    const MW = 64;
    const MH = Math.max(8, Math.round(MW * hitCanvas.height / hitCanvas.width));
    const img = hitCtx.getImageData(0, 0, hitCanvas.width, hitCanvas.height);
    const bits = new Uint8Array(Math.ceil((MW * MH) / 8));
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const sx = Math.min(hitCanvas.width - 1, Math.floor((x + 0.5) * hitCanvas.width / MW));
        const sy = Math.min(hitCanvas.height - 1, Math.floor((y + 0.5) * hitCanvas.height / MH));
        if (img.data[(sy * hitCanvas.width + sx) * 4 + 3] > 16) {
          const i = y * MW + x;
          bits[i >> 3] |= (1 << (i & 7));
        }
      }
    }
    let bin = '';
    for (let i = 0; i < bits.length; i++) bin += String.fromCharCode(bits[i]);
    const r = pet.getBoundingClientRect();
    window.petAPI.hitMask({
      w: MW, h: MH, mask: btoa(bin),
      left: r.left, top: r.top, width: r.width, height: r.height,
    });
  } catch {}
}

/* 归一化多边形点内测试 */
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

let regions = [];
(async () => {
  try { const r = await window.petAPI.artRegions(); regions = (r && r.regions) || []; } catch {}
})();

function regionAt(cx, cy) {
  if (!regions.length) return null;
  const r = pet.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const nx = (cx - r.left) / r.width, ny = (cy - r.top) / r.height;
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
  let best = null;
  for (const rg of regions) {
    if (!rg.poly || !rg.poly.length) continue;
    if (!pointInPoly(nx, ny, rg.poly)) continue;
    if (!best || (rg.priority || 0) > (best.priority || 0)) best = rg;
  }
  return best ? { id: best.id, name: best.name, en: best.en, group: best.group } : null;
}

/* 窗口能收到鼠标时，记录当前摸到的部位 */
function updateHit(cx, cy) {
  curRegion = regionAt(cx, cy);
  window.__petRegion = curRegion;
  return true;
}

pet.addEventListener('load', () => { try { applySize(); buildHitCanvas(); } catch {} });
loadArt();
setInterval(loadArt, 3000);

