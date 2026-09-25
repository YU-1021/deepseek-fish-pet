const $ = (id) => document.getElementById(id);

let cfg = {};
let busy = false;
let ttsOn = true;
let stepBudget = 6;      // 任务步数上限，由 IQ 决定（隐藏数值真的影响办事效率）
let taskFailed = false;  // 本次任务里有没有失败过

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- 悬停音标 ---------------- */
let tip = null;
function ensureTip() { if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip); } return tip; }
function hideTip() { if (tip) tip.classList.remove('show'); }
function positionTip(e) {
  const r = tip.getBoundingClientRect(), pad = 12;
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

/* ---------------- 聊天记录：最小化 / 关掉再打开也能看到之前说过什么 ---------------- */
async function loadLog() {
  try {
    const h = await window.petAPI.chatLog();
    const entries = (h && h.entries) || [];
    if (!entries.length) return false;
    $('msgs').innerHTML = '';
    for (const it of entries) {
      if (it.who === 'me') addUser(it.text);
      else if (it.who === 'pet') addPet(it.en, it.zh, it.words);
    }
    const last = [...entries].reverse().find((x) => x.who === 'pet' && x.choices && x.choices.length);
    if (last) renderChoices(last.choices);
    return true;
  } catch { return false; }
}

/* ---------------- 初始化 ---------------- */
(async function init() {
  cfg = await window.petAPI.configGet();
  ttsOn = cfg.ttsEnabled !== false;
  $('ttsBtn').classList.toggle('on', ttsOn);
  if (!cfg.apiKey) showSetup(true);
  else {
    showMain();
    const had = await loadLog();
    if (!had) greet();      // 有历史记录就别再重复开场白了
  }
  refreshMood();
  refreshBudget();
})();

async function refreshMood() {
  try {
    const m = await window.petAPI.moodGet();
    $('moodBar').textContent = `❤️ ${m.affection} · 😊 ${m.mood}`;
  } catch {}
}

async function refreshDsh() {
  try {
    const s = await window.petAPI.dshState();
    if (!s || !s.ok) { $('dshBar').textContent = ''; return; }
    const map = { working: '执行中', thinking: '思考中', idle: '空闲' };
    $('dshBar').textContent = `🖥 DSH ${map[s.state] || ''}${s.tool ? ' · ' + s.tool : ''}${s.active ? '' : '（已停）'}`;
  } catch {}
}
setInterval(refreshDsh, 5000);

function showSetup(prefill) {
  $('setup').classList.remove('hidden');
  ['persona', 'diary', 'voice', 'micPerm'].forEach((x) => $(x).classList.add('hidden'));
  $('main').classList.add('hidden');
  if (prefill) {
    $('apiBase').value = cfg.apiBase || 'https://api.deepseek.com/v1';
    $('apiKey').value = cfg.apiKey || '';
    $('model').value = cfg.model || 'deepseek-chat';
    $('vocabLevel').value = cfg.vocabLevel || 'high_school';
    $('assistant').value = cfg.assistant || 'off';
    $('visionOn').checked = !!cfg.visionEnabled;
    $('visionBase').value = cfg.visionBase || '';
    $('visionKey').value = cfg.visionKey || '';
    $('visionModel').value = cfg.visionModel || 'deepseek-flash';
    $('provider').value = 'custom';
  }
}
function showMain() {
  ['setup', 'persona', 'diary', 'voice'].forEach((x) => $(x).classList.add('hidden'));
  $('main').classList.remove('hidden');
  $('input').focus();
}

/* ---------------- 绑定 API ---------------- */
$('provider').addEventListener('change', (e) => {
  if (e.target.value === 'custom') return;
  const [base, model] = e.target.value.split('|');
  $('apiBase').value = base; $('model').value = model;
});
$('save').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim(), apiKey = $('apiKey').value.trim(), model = $('model').value.trim();
  if (!apiBase || !apiKey || !model) { $('setupMsg').textContent = '接口地址 / API Key / 模型名 都要填哦'; return; }
  $('save').disabled = true; $('setupMsg').textContent = '正在测试连接…';
  try {
    await window.petAPI.configTest({ apiBase, apiKey, model });
    cfg = await window.petAPI.configSet({ apiBase, apiKey, model, vocabLevel: $('vocabLevel').value, assistant: $('assistant').value, visionEnabled: $('visionOn').checked, visionBase: $('visionBase').value.trim(), visionKey: $('visionKey').value.trim(), visionModel: $('visionModel').value.trim() });
    $('setupMsg').textContent = '';
    showMain(); greet();
  } catch (e) { $('setupMsg').textContent = '连接失败：' + e.message; }
  finally { $('save').disabled = false; }
});
$('skip').addEventListener('click', () => { showMain(); greet(); });
$('settingsBtn').addEventListener('click', () => showSetup(true));

/* ---------------- 立绘文件夹（免打包换图） ---------------- */
$('artOpen').addEventListener('click', async () => {
  try { const d = await window.petAPI.artOpen(); $('setupMsg').textContent = '已打开：' + d; }
  catch (e) { $('setupMsg').textContent = '打开失败：' + e.message; }
});
$('artReset').addEventListener('click', async () => {
  try { await window.petAPI.artReset(); $('setupMsg').textContent = '已恢复默认立绘'; }
  catch (e) { $('setupMsg').textContent = '失败：' + e.message; }
});

/* ---------------- 📘 技能文件夹 ---------------- */
$('skillsOpen').addEventListener('click', async () => {
  try { const d = await window.petAPI.skillsOpen(); $('skillsMsg').textContent = '已打开：' + d; }
  catch (e) { $('skillsMsg').textContent = '打开失败：' + e.message; }
});
$('skillsRefresh').addEventListener('click', async () => {
  try {
    const list = await window.petAPI.skillsList();
    const pool = await window.petAPI.skillsPool();
    const line = (list && list.length)
      ? ('已装 ' + list.length + ' 个技能：' + list.map((s) => s.id).join('、'))
      : '还没有技能，点「打开技能文件夹」丢一个进去';
    const p = pool && pool.cand ? pool.cand.length : 0;
    $('skillsMsg').textContent = line + '\n经验池：' + p + ' 条' + (pool && pool.ready ? ('（其中 ' + pool.ready + ' 条已够权重，等归档）') : '');
  } catch (e) { $('skillsMsg').textContent = '读取失败：' + e.message; }
});
$('skillsArchive').addEventListener('click', async () => {
  const btn = $('skillsArchive');
  btn.disabled = true;
  $('skillsMsg').textContent = '正在让 AI 整理归档…（会花一点 token）';
  try {
    const r = await window.petAPI.skillsArchive();
    if (!r || !r.ok) { $('skillsMsg').textContent = '❌ ' + ((r && r.error) || '整理失败'); return; }
    $('skillsMsg').textContent = r.total
      ? ('✅ 归档 ' + r.filed + ' / ' + r.total + ' 条\n' + (r.log || []).join('\n'))
      : '经验池里还没有攒够权重的经验（多跟它一起做点事，权重够了就会自动归档）';
  } catch (e) { $('skillsMsg').textContent = '❌ ' + e.message; }
  finally { btn.disabled = false; }
});
$('projOpen').addEventListener('click', async () => {
  try {
    const r = await window.petAPI.projOpenFolder();
    $('skillsMsg').textContent = r && r.ok ? ('已打开项目文件夹：' + r.dir) : ('打开失败：' + ((r && r.error) || ''));
  } catch (e) { $('skillsMsg').textContent = '打开失败：' + e.message; }
});

/* ---------------- 📦 她写的小软件：回复里带的代码文件，确认后落盘 ---------------- */
async function doWriteFiles(files) {
  try {
    const r = await window.petAPI.projWrite(files);
    if (!r || !r.ok) { addErr('写入失败：' + ((r && r.error) || '未知')); return; }
    addSys('📦 已写进项目文件夹：\n' + r.files.map((f) => '· ' + f.path + '（' + f.bytes + ' 字节）').join('\n'));
    const html = files.find((f) => /\.html?$/i.test(f.path));
    if (html) {
      const o = await window.petAPI.projOpen(html.path);
      if (o && o.ok) addSys('🌐 已用浏览器打开：' + html.path);
      else addErr('打开失败：' + ((o && o.error) || ''));
    }
  } catch (e) { addErr('写入失败：' + e.message); }
}
function renderFiles(msgEl, files) {
  if (cfg.assistant === 'full') { doWriteFiles(files); return; }   // 完全权限：直接写
  const bar = document.createElement('div');
  bar.className = 'actionbar';
  bar.innerHTML = '<span class="atool">📦 她想写 ' + files.length + ' 个文件</span>'
    + '<span class="aarg" title="' + esc(files.map((f) => f.path).join('\n')) + '">' + esc(files.map((f) => f.path).join('、')) + '</span>';
  const allow = document.createElement('button'); allow.textContent = '写入'; allow.className = 'allow';
  const deny = document.createElement('button'); deny.textContent = '跳过'; deny.className = 'deny';
  bar.appendChild(allow); bar.appendChild(deny);
  msgEl.appendChild(bar);
  scroll();
  allow.addEventListener('click', () => { bar.remove(); doWriteFiles(files); });
  deny.addEventListener('click', () => { bar.remove(); addSys('已跳过写入'); });
}

/* 她的人设随经历演化了 → 告诉你一声 */
const PERSONA_LABELS = { name: '名字', world_setting: '世界观', character_setting: '人物设定', personality: '性格', catchphrase: '口头禅', hidden_setting: '隐藏设定' };
if (window.petAPI.onPersonaChanged) window.petAPI.onPersonaChanged((d) => {
  if (!d || !d.applied || !d.applied.length) return;
  try {
    addSys('🌱 她的人设悄悄变了：' + d.applied.map((f) => PERSONA_LABELS[f] || f).join('、') + (d.reason ? '\n（' + d.reason + '）' : ''));
  } catch {}
});

/* 桌宠那边用语音交代的任务转过来执行（主进程会兜底重发一次，这里做去重） */
let lastRunAt = 0, lastRunKey = '';
if (window.petAPI.onRunAction) window.petAPI.onRunAction((a) => {
  if (!a || !a.tool) return;
  const key = a.tool + '|' + (a.arg || '');
  if (key === lastRunKey && Date.now() - lastRunAt < 8000) return;
  lastRunKey = key; lastRunAt = Date.now();
  const box = document.createElement('div');
  box.className = 'msg sys';
  box.textContent = '🎤 你刚才用语音交代的事：' + a.tool + (a.arg ? ' ' + a.arg : '');
  $('msgs').appendChild(box); scroll();
  renderAction(box, a, () => runTask(box, a, 1), () => {});
});

/* ---------------- 🎮 游戏助手 ---------------- */
const GAME_PRESET = [
  '这是《明日方舟》的战斗关卡。请观察屏幕，判断当前该做什么，一步一步帮我把这关打过去。',
  '',
  '要点：',
  '- 右下角是待部署的干员头像：先点一下头像选中，再点地图上可以放置的格子完成部署',
  '- 底部是已选中干员的技能按钮，需要时点击释放技能',
  '- 左上角显示剩余敌人数量，注意还有多少没打完',
  '- 画面上的数字是部署费用，费用不够就先等一等，别硬点',
  '- 如果战斗已经结束（出现结算 / 继续 / 返回按钮），就输出 DONE',
].join('\n');

function gLogLine(kind, text) {
  const box = $('gLog');
  const d = document.createElement('div');
  d.className = 'gline ' + (kind || 'info');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0'), ss = String(t.getSeconds()).padStart(2, '0');
  d.textContent = '[' + hh + ':' + mm + ':' + ss + '] ' + text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
}

function setGameRunning(on) {
  $('gStart').disabled = on;
  $('gStop').disabled = !on;
}

$('gameBtn').addEventListener('click', async () => {
  $('game').classList.remove('hidden');
  $('gMsg').textContent = '';
  try {
    const s = await window.petAPI.gameStatus();
    setGameRunning(!!(s && s.running));
  } catch {}
});
$('gClose').addEventListener('click', () => $('game').classList.add('hidden'));
$('gPreset').addEventListener('click', () => { $('gTask').value = GAME_PRESET; });
$('gStart').addEventListener('click', async () => {
  $('gMsg').textContent = '';
  $('gStart').disabled = true;
  try {
    const r = await window.petAPI.gameStart({
      task: $('gTask').value.trim(),
      intervalMs: Math.round(Number($('gInterval').value || 4) * 1000),
      maxSteps: Number($('gMax').value || 30),
      dryRun: $('gDry').checked,
    });
    if (r && r.ok) { setGameRunning(true); }
    else { $('gMsg').textContent = '❌ ' + ((r && r.error) || '启动失败'); setGameRunning(false); }
  } catch (e) { $('gMsg').textContent = '❌ ' + e.message; setGameRunning(false); }
});
$('gStop').addEventListener('click', async () => {
  try { await window.petAPI.gameStop(); } catch {}
  setGameRunning(false);
});
/* 游戏助手在对话里开的"实况卡"：它由技能启动时游戏面板是关着的，
   所以把实况直接贴进对话，用户不点任何按钮也看得到它每一步在干什么。 */
let gameCard = null;
function gameCardLine(kind, text) {
  if (!$('game').classList.contains('hidden')) return;   // 面板开着就只看面板，别重复刷屏
  if (!gameCard || !gameCard.isConnected) {
    const d = document.createElement('div');
    d.className = 'msg sys gamecard';
    d.innerHTML = '<div class="gchead">🎮 游戏助手实况</div><div class="gcbody"></div>';
    $('msgs').appendChild(d);
    gameCard = d.querySelector('.gcbody');
    scroll();
  }
  const line = document.createElement('div');
  line.className = 'gline ' + (kind || 'info');
  line.textContent = text;
  gameCard.appendChild(line);
  while (gameCard.childElementCount > 400) gameCard.removeChild(gameCard.firstChild);
  scroll();
}

if (window.petAPI.onGameLog) window.petAPI.onGameLog((e) => {
  if (!e) return;
  gLogLine(e.kind, e.text);
  if (String(e.text).indexOf('🎮 启动') === 0) gameCard = null;   // 新的一趟，换一张卡
  gameCardLine(e.kind, e.text);
  if (/已停止|收手了/.test(String(e.text))) setGameRunning(false);
});

/* ---------------- 人设（含逐字段锁：锁住 = AI 不能改，你随时能改） ---------------- */
function paintLocks(locks, userOnly) {
  document.querySelectorAll('#persona .locksym').forEach((el) => {
    const f = el.dataset.field;
    const fixed = (userOnly || []).indexOf(f) >= 0;
    const locked = fixed || !!(locks && locks[f]);
    el.textContent = locked ? '🔒' : '🔓';
    el.classList.toggle('locked', locked);
    el.classList.toggle('fixed', fixed);
    el.title = fixed ? '这个世界观只有你能改，AI 永远不能动'
      : (locked ? '已锁住：AI 自己不能改这里（你随时能改）。点一下解锁' : '未锁：AI 可能随经历慢慢修改这里。点一下锁住');
  });
}
$('personaBtn').addEventListener('click', async () => {
  const p = await window.petAPI.personaGet();
  $('pName').value = p.name || ''; $('pWorld').value = p.world_setting || '';
  $('pChar').value = p.character_setting || ''; $('pPersonality').value = p.personality || '';
  $('pCatch').value = p.catchphrase || ''; $('pHidden').value = p.hidden_setting || '';
  paintLocks(p.locks, p.userOnly);
  $('pMsg').textContent = '';
  $('persona').classList.remove('hidden');
});
document.querySelectorAll('#persona .locksym').forEach((el) => {
  el.addEventListener('click', async () => {
    if (el.classList.contains('fixed')) { $('pMsg').textContent = '世界观只有你能改，AI 永远不能动它'; return; }
    const next = !el.classList.contains('locked');
    try {
      const r = await window.petAPI.personaLock({ field: el.dataset.field, locked: next });
      paintLocks(r && r.locks, []);
      $('pMsg').textContent = next ? '已锁住 —— AI 不能再改这一项了' : '已解锁 —— AI 可以随经历慢慢修改这一项';
    } catch (e) { $('pMsg').textContent = '操作失败：' + e.message; }
  });
});
$('pSave').addEventListener('click', async () => {
  $('pSave').disabled = true; $('pMsg').textContent = '保存中…';
  try {
    await window.petAPI.personaSet({
      name: $('pName').value.trim(), world_setting: $('pWorld').value.trim(),
      character_setting: $('pChar').value.trim(), personality: $('pPersonality').value.trim(),
      catchphrase: $('pCatch').value.trim(), hidden_setting: $('pHidden').value.trim()
    });
    $('pMsg').textContent = '已保存 ✅（锁的状态也一起保留了）';
    setTimeout(() => $('persona').classList.add('hidden'), 700);
  } catch (e) { $('pMsg').textContent = '保存失败：' + e.message; }
  finally { $('pSave').disabled = false; }
});
$('pCancel').addEventListener('click', () => $('persona').classList.add('hidden'));

/* ---------------- 记忆日记（只展示长期记忆，中期记忆隐藏） ---------------- */
async function renderDiary() {
  const m = await window.petAPI.memoryGet();
  const body = $('diaryBody');
  const long = [...(m.long || [])].reverse();
  const ses = m.session || {};
  let html = `<div class="dstat">📚 日记 <b>${long.length}</b> 天 · 本次会话 <b>${ses.count || 0}</b> 条对话</div>`;
  if (!long.length) html += '<div class="dempty">还没有日记。多聊几天，我就会把它们写成日记啦。</div>';
  for (const e of long) {
    html += `<div class="dentry"><div class="dhead"><span>🗓 ${esc(e.date)}</span><button class="ddel" data-kind="long" data-ts="${e.ts}">删除</button></div><div class="dtext">${esc(e.diary)}</div></div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('.ddel').forEach((b) => b.addEventListener('click', async () => {
    await window.petAPI.memoryDelete({ kind: 'long', ts: Number(b.dataset.ts) });
    renderDiary();
  }));
}

$('diaryBtn').addEventListener('click', () => { $('diary').classList.remove('hidden'); renderDiary(); });
$('diaryClose').addEventListener('click', () => $('diary').classList.add('hidden'));

/* ---------------- 结束本次会话 ---------------- */
let endBusy = false;
$('endBtn').addEventListener('click', async () => {
  if (endBusy) return;                      // 连点保护：每次点击都会跑一遍 4 个模型调用 + 记账
  const ok = confirm('结束本次会话？\n\n我会把这段对话收进记忆（写摘要 + 抽取长期要点），然后关掉对话窗。\n（平时点右上角 × 只会最小化，不会丢会话）');
  if (!ok) return;
  endBusy = true;
  const btn = $('endBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳';
  /* 失败必须说出来：以前 catch 是空的、而且 main 那边是 return {ok:false} 而不是抛错，
     于是"写摘要 + 抽要点"实际没做，窗口照样关掉，用户以为已经保存了。 */
  const fail = (why) => {
    endBusy = false; btn.disabled = false; btn.textContent = old;
    try { alert('收尾失败：' + why + '\n\n这段对话还在，没有丢。可以再试一次。'); } catch {}
  };
  try {
    const r = await window.petAPI.memoryEndSession();
    if (r && r.ok === false) return fail(r.error || '未知原因');
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
  window.petAPI.chatClose();
});

/* ---------------- 生词本 ---------------- */
let vocabData = [];
async function renderVocab() {
  vocabData = await window.petAPI.vocabList();
  const body = $('vocabBody');
  if (!vocabData.length) {
    body.innerHTML = '<div class="dempty">生词本还是空的。点对话里带虚线的单词，或跟读时读错的红词，就能收藏进来。</div>';
    return;
  }
  body.innerHTML = vocabData.map((v, i) => {
    const rate = v.review ? Math.round(((v.good || 0) / v.review) * 100) : null;
    return `<div class="vitem"><div class="vmain"><b>${esc(v.w)}</b><span class="vipa">${esc(v.ipa || '')}</span><span class="vzh">${esc(v.zh || '')}</span></div><div class="vmeta">${v.review ? `复习 ${v.review} 次 · 掌握 ${rate}%` : '未复习'}<button class="vdel" data-i="${i}">删除</button></div></div>`;
  }).join('');
  body.querySelectorAll('.vdel').forEach((b) => b.addEventListener('click', async () => {
    await window.petAPI.vocabDel(vocabData[+b.dataset.i].w);
    renderVocab();
  }));
}

let reviewQueue = [], reviewIdx = 0, reviewShown = false;
async function startReview() {
  vocabData = await window.petAPI.vocabList();
  if (!vocabData.length) { $('vocabBody').innerHTML = '<div class="dempty">还没有生词可复习。</div>'; return; }
  reviewQueue = vocabData.slice().sort((a, b) => {
    const ra = a.review ? (a.good || 0) / a.review : 0;
    const rb = b.review ? (b.good || 0) / b.review : 0;
    return ra - rb;
  });
  reviewIdx = 0; reviewShown = false; renderCard();
}
function renderCard() {
  const body = $('vocabBody');
  if (reviewIdx >= reviewQueue.length) { body.innerHTML = '<div class="dempty">本轮复习完成 ✅</div>'; return; }
  const v = reviewQueue[reviewIdx];
  body.innerHTML = `<div class="vcard"><div class="vword">${esc(v.w)}</div>` +
    `<div class="vipa2">${reviewShown ? esc(v.ipa || '') : '&nbsp;'}</div>` +
    (reviewShown ? `<div class="vzh2">${esc(v.zh || '（无释义）')}</div>` : '') +
    `<div class="vbtns">${reviewShown ? '<button id="vGood" class="primary">认识 ✓</button><button id="vBad" class="ghost">不认识 ✗</button>' : '<button id="vShow" class="primary">显示释义</button>'}</div>` +
    `<div class="vprog">${reviewIdx + 1} / ${reviewQueue.length}</div></div>`;
  const show = $('vShow'); if (show) show.addEventListener('click', () => { reviewShown = true; renderCard(); });
  const good = $('vGood'); if (good) good.addEventListener('click', () => markReview(true));
  const bad = $('vBad'); if (bad) bad.addEventListener('click', () => markReview(false));
}
let reviewBusy = false;
async function markReview(ok) {
  /* 连点保护：await 期间按钮既没禁用也没重绘，快速双击会把同一个单词记两次复习、
     reviewIdx 自增两次，下一张卡直接被跳过。 */
  if (reviewBusy) return;
  reviewBusy = true;
  try {
    await window.petAPI.vocabReview(reviewQueue[reviewIdx].w, ok);
    reviewIdx++; reviewShown = false; renderCard();
  } finally {
    reviewBusy = false;
  }
}

$('vocabBtn').addEventListener('click', () => { $('vocab').classList.remove('hidden'); renderVocab(); });
$('vocabClose').addEventListener('click', () => $('vocab').classList.add('hidden'));
$('vocabReview').addEventListener('click', startReview);

// 点对话里的单词 → 收藏进生词本
document.addEventListener('click', async (e) => {
  const el = e.target.closest('#msgs .w');
  if (!el) return;
  const w = el.textContent.trim();
  if (!w) return;
  await window.petAPI.vocabAdd({ w, ipa: el.dataset.ipa || '', zh: el.dataset.zh || '' });
  addSys(`📒 已加入生词本：${w}`);
});

/* ---------------- 消息渲染 ---------------- */
function scroll() { const m = $('msgs'); m.scrollTop = m.scrollHeight; }
function addUser(text) {
  const d = document.createElement('div');
  d.className = 'msg user'; d.textContent = text;
  $('msgs').appendChild(d); scroll();
}
function addPet(en, zh, words) {
  const d = document.createElement('div');
  d.className = 'msg pet';
  d.innerHTML = `<div class="en">${renderEn(en, words)}</div>` + (zh ? `<div class="zh">${esc(zh)}</div>` : '');
  $('msgs').appendChild(d); scroll();
  return d;
}
function addErr(text) {
  const key = String(text);
  const last = $('msgs').lastElementChild;
  if (last && last.dataset.err === key) return; // 去重，避免重复刷屏
  const d = document.createElement('div');
  d.className = 'msg err'; d.dataset.err = key; d.textContent = text;
  $('msgs').appendChild(d); scroll();
}

function addSys(text) {
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.textContent = text;
  $('msgs').appendChild(d); scroll();
}

// 共享屏幕：把助手看到的截图直接贴进对话
function addShot(dataUrl) {
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.innerHTML = `<img class="shot" src="${dataUrl}" alt="屏幕截图">`;
  $('msgs').appendChild(d); scroll();
}

// 执行一个动作：显示结果 + 截图，返回结果对象。
// 关键：工具抛异常时**不中断任务**，而是把报错当成"结果"交回给她，让她自己分析、自己修、修不了再上报。
async function execAction(action) {
  try {
    const r = await window.petAPI.assistantRun(action);
    if (r && r.image) addShot(r.image);
    addSys('🤖 ' + ((r && r.result) ? r.result : '（已执行）'));
    // 工具没抛异常、但结果本身是失败（脚本退出码非 0、超时、被拒绝…）也算这一趟没办成
    if (r && /^(❌|⏱|⚠️)|失败|出错|超时|不被允许/.test(String(r.result || ''))) taskFailed = true;
    return r;
  } catch (e) {
    taskFailed = true;
    const msg = '操作 `' + action.tool + '` 失败：' + ((e && e.message) || e);
    addSys('⚠️ ' + msg);    return {
      ok: false,
      result: msg + '\n（请你自己分析原因：是参数/路径写错了，还是环境缺东西、没权限？能自己换做法解决就重试；解决不了就用正常格式告诉主人问题在哪、需要他做什么。）',
    };
  }
}

const MAX_STEPS_DEFAULT = 6;
async function refreshBudget() {
  try { const s = await window.petAPI.statsGet(); if (s && s.stepBudget) stepBudget = s.stepBudget; } catch {}
}
function reportTask() {
  try { window.petAPI.statsTask({ ok: !taskFailed }); } catch {}
  refreshBudget();
}

// 多步任务：执行 → 把结果喂回模型 → 看下一步，直到收尾或到步数上限
async function runTask(msgEl, action, depth) {
  if (depth === 1) taskFailed = false;
  if (depth > stepBudget) { addSys('⏸ 已达到本次任务的步数上限（' + stepBudget + '），先停下来'); reportTask(); return; }
  const r = await execAction(action);
  if (!r) { reportTask(); return; }   // 视觉一步到位：工具（如 screen_look）直接给出了下一步动作，就跳过文本模型，直接执行
  if (r.action) {
    const box = document.createElement('div');
    box.className = 'msg sys';
    box.textContent = '🤖 下一步：' + r.action.tool + (r.action.arg ? ' ' + r.action.arg : '');
    $('msgs').appendChild(box); scroll();
    renderAction(box, r.action, () => runTask(box, r.action, depth + 1), () => {});
    return;
  }
  let next;
  try {
    next = await window.petAPI.chatContinue({ tool: action.tool, arg: action.arg, result: r.result });
  } catch (e) { addErr('模型继续失败：' + e.message); reportTask(); return; }
  if (!next || !next.en) { reportTask(); return; }
  const pe = addPet(next.en, next.zh, next.words);
  renderChoices(next.choices);
  if (next.action) {
    // 中间步骤：只显示不朗读，继续下一步
    renderAction(pe, next.action, () => runTask(pe, next.action, depth + 1), () => {});
  } else {
    speak(next.en);   // 最后一句才朗读
    reportTask();
  }
}

// AI 助手操作请求：允许 / 拒绝；「完全权限」档自动执行
function renderAction(msgEl, action, onApprove, onDeny) {
  if (cfg.assistant === 'full') {
    addSys('🤖 自动执行：' + action.tool + (action.arg ? ' ' + action.arg : ''));
    if (onApprove) onApprove(); else execAction(action);
    return;
  }
  const bar = document.createElement('div');
  bar.className = 'actionbar';
  bar.innerHTML = `<span class="atool">🤖 ${esc(action.tool)}</span><span class="aarg" title="${esc(action.arg)}">${esc(action.arg)}</span>`;
  const allow = document.createElement('button'); allow.textContent = '允许'; allow.className = 'allow';
  const deny = document.createElement('button'); deny.textContent = '拒绝'; deny.className = 'deny';
  bar.appendChild(allow); bar.appendChild(deny);
  msgEl.appendChild(bar);
  scroll();
  allow.addEventListener('click', () => { bar.remove(); if (onApprove) onApprove(); else execAction(action); });
  deny.addEventListener('click', () => { bar.remove(); addSys('已拒绝该操作'); if (onDeny) onDeny(); });
}
function renderChoices(choices) {
  const box = $('choices');
  box.innerHTML = '';
  (choices || []).forEach((c) => {
    if (!c?.en) return;
    const b = document.createElement('button');
    b.className = 'choice';
    b.title = c.ipa || '';
    b.innerHTML = `<div class="en">${esc(c.en)}</div><div class="meta">${esc(c.zh)}</div>`;
    b.addEventListener('click', () => send(c.en));
    box.appendChild(b);
  });
}

// 悬停音标（消息区 + 预制回复）
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('.w');
  if (!el) { hideTip(); return; }
  const ipa = el.dataset.ipa, zh = el.dataset.zh;
  if (!ipa && !zh) return;
  const t = ensureTip();
  t.innerHTML = (ipa ? `<div class="ipa">${esc(ipa)}</div>` : '') + (zh ? `<div class="zh">${esc(zh)}</div>` : '');
  t.classList.add('show'); positionTip(e);
});
document.addEventListener('mousemove', (e) => { if (tip && tip.classList.contains('show')) positionTip(e); });

/* ---------------- 对话 ---------------- */
async function send(text) {
  text = String(text || '').trim();
  if (!text || busy) return;
  busy = true;
  $('input').value = ''; $('choices').innerHTML = '';
  addUser(text);
  const pending = addPet('…', '', []);
  pendingEl = pending; partialSpoken = false;
  try {
    const reply = await window.petAPI.chatSend({ text });
    pending.remove(); pendingEl = null;
    const pe = addPet(reply.en, reply.zh, reply.words);
    renderChoices(reply.choices);
    refreshMood();
    if (reply.files && reply.files.length) renderFiles(pe, reply.files);
    if (reply.action) {
      // 有动作：进入多步任务循环（首句由流式 partial 读，中间只显示，最后一句再读）
      renderAction(pe, reply.action, () => runTask(pe, reply.action, 1), () => {});
    } else {
      if (!partialSpoken) speak(reply.en);
    }
  } catch (e) {
    pending.remove(); pendingEl = null; addErr(e.message || String(e));
  } finally {
    busy = false; $('input').focus();
  }
}
$('send').addEventListener('click', () => send($('input').value));
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('input').value); }
});

/* 流式：英文一出来就先填进占位气泡并开始朗读 */
let pendingEl = null, partialSpoken = false;
if (window.petAPI.onChatPartial) window.petAPI.onChatPartial((d) => {
  if (!d || !d.en) return;
  partialSpoken = true;
  try {
    if (pendingEl) {
      const en = pendingEl.querySelector('.en');
      if (en) en.textContent = d.en;
    }
  } catch {}
  speak(d.en);
});

/* ---------------- TTS（Edge 神经音色，失败时退回系统语音） ---------------- */
let curAudio = null;
let speakSeq = 0;

function stopSpeech() {
  speakSeq++;
  if (curAudio) { try { curAudio.pause(); } catch {} curAudio = null; }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
}

async function speak(text) {
  if (!ttsOn || !text) return;
  stopSpeech();
  const seq = speakSeq;
  try {
    const res = await window.petAPI.ttsSpeak({ text, force: true });
    if (seq !== speakSeq) return;
    if (res && res.ok && res.dataUrl) {
      const a = new Audio(res.dataUrl);
      curAudio = a;
      const fin = () => { if (curAudio === a) curAudio = null; };
      a.onended = fin; a.onerror = fin;
      await a.play();
      return;
    }
    if (res && res.error) console.warn('[TTS]', res.error);
  } catch (e) { console.warn('[TTS]', e); }
  if (seq !== speakSeq || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.95; u.pitch = 1.15;
    window.speechSynthesis.speak(u);
  } catch {}
}
$('ttsBtn').addEventListener('click', async () => {
  ttsOn = !ttsOn;
  $('ttsBtn').classList.toggle('on', ttsOn);
  if (!ttsOn) stopSpeech();
  await window.petAPI.configSet({ ttsEnabled: ttsOn });
});

/* ---------------- 音色选择 ---------------- */
let voiceMeta = { voices: [], styles: [] };
async function openVoice() {
  voiceMeta = await window.petAPI.ttsVoices();
  const vv = $('vVoice'), vs = $('vStyle');
  vv.innerHTML = (voiceMeta.voices || []).map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('');
  vs.innerHTML = (voiceMeta.styles || []).map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  vv.value = cfg.ttsVoice || voiceMeta.defaultVoice || 'zh-CN-XiaoxiaoNeural';
  vs.value = cfg.ttsStyle || voiceMeta.defaultStyle || 'tsundere';
  $('vRate').value = Number(cfg.ttsRate) || 1;
  $('vPitch').value = Number(cfg.ttsPitch) || 1;
  $('vMsg').textContent = '';
  $('voice').classList.remove('hidden');
}
$('voiceBtn').addEventListener('click', openVoice);
$('vStyle').addEventListener('change', () => {
  const s = (voiceMeta.styles || []).find((x) => x.id === $('vStyle').value);
  if (s && Number(s.rate) > 0) $('vRate').value = s.rate;
  if (s && Number(s.pitch) > 0) $('vPitch').value = s.pitch;
});
$('vCancel').addEventListener('click', () => $('voice').classList.add('hidden'));
$('vPreview').addEventListener('click', async () => {
  const text = 'Hey! I am NOT a freeloader fat fish! Do you want to play with me?';
  $('vMsg').textContent = '正在合成…（第一次慢一点）';
  stopSpeech();
  try {
    const res = await window.petAPI.ttsSpeak({
      text, force: true,
      voice: $('vVoice').value, style: $('vStyle').value,
      rate: Number($('vRate').value), pitch: Number($('vPitch').value),
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '合成失败');
    $('vMsg').textContent = res.cached ? '试听中（缓存）' : '试听中…';
    const a = new Audio(res.dataUrl);
    curAudio = a;
    a.onended = () => { if (curAudio === a) curAudio = null; };
    a.onerror = a.onended;
    await a.play();
  } catch (e) { $('vMsg').textContent = '失败：' + (e.message || e); }
});
$('vSave').addEventListener('click', async () => {
  cfg = await window.petAPI.configSet({
    ttsVoice: $('vVoice').value, ttsStyle: $('vStyle').value,
    ttsRate: Number($('vRate').value), ttsPitch: Number($('vPitch').value), ttsEnabled: true,
  });
  ttsOn = true; $('ttsBtn').classList.add('on');
  $('vMsg').textContent = '已保存 ✅ 试试跟我说话';
  setTimeout(() => $('voice').classList.add('hidden'), 700);
});

/* ---------------- 麦克风：点击发送 / 上滑后点任意位置取消 ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recCanceled = false, recFinal = '', recInterim = '', recStartY = 0, recording = false, cancelMode = false, finalized = false;
let recStarting = false;   // 正在启动录音（getUserMedia/pushStart 还没返回）
let recAbort = false;      // 启动期间就被要求停止
let recMode = '';        // whisper = 本地离线识别 / web = 浏览器在线识别
let asrBusy = false;     // 正在送本地识别（避免重复触发）

function setRecUI(on) {
  $('recStatus').classList.toggle('hidden', !on);
  $('input').classList.toggle('hidden', on);
  $('send').classList.toggle('hidden', on);
  $('mic').classList.toggle('rec', on);
}

/* 麦克风状态：能不能录、授没授权 */
let micState = 'unknown';   // granted / denied / error / unknown
let micFails = 0;           // 连续失败次数：连败两次就弹授权面板，避免"悄悄录不了"

function setMicBadge() {
  const el = $('micState');
  if (!el) return;
  const map = { granted: '🎤 正常', denied: '🎤 未授权', error: '🎤 异常', unknown: '🎤 未检测' };
  el.textContent = map[micState] || '';
  el.dataset.state = micState;
}

async function checkMic(quiet) {
  $('micState') && ($('micState').textContent = '🎤 检测中…');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    micState = 'granted'; micFails = 0; setMicBadge();
    if (!quiet) addErr('✅ 麦克风正常，可以说话了');
    return 'granted';
  } catch (e) {
    const name = (e && e.name) || '';
    micState = (name === 'NotAllowedError' || name === 'SecurityError') ? 'denied' : 'error';
    setMicBadge();
    if (!quiet) showMicPerm(name);
    return micState;
  }
}

/* 彻底释放识别器：先摘掉回调再 abort，避免 abort 触发的事件被当成新一次失败 */
function releaseRec() {
  const r = rec;
  rec = null;
  if (!r) return;
  try { r.onerror = null; r.onend = null; r.onresult = null; } catch {}
  try { r.abort(); } catch {}
}

function finalize() {
  if (finalized) return;
  finalized = true;
  const t = (recFinal + ' ' + recInterim).replace(/\s+/g, ' ').trim();
  releaseRec();
  recording = false; cancelMode = false;
  setRecUI(false);
  if (t && !recCanceled) send(t);
}

function recFailed(err) {
  finalized = true;
  releaseRec();
  recording = false; cancelMode = false;
  setRecUI(false);
  micFails++;
  try { window.petAPI.logErr('chat asr fail: ' + (err || '?') + ' fails=' + micFails + ' SR=' + !!SR + ' lang=' + navigator.language); } catch {}
  if (String(err).startsWith('whisper')) {   // 本地识别报错跟麦克风权限无关，别误报成"未授权"
    micState = 'error'; setMicBadge();
    addErr('本地识别失败：' + String(err).replace(/^whisper:/, '') + '（可在自检里看引擎状态）');
    return;
  }
  const hard = (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture');
  micState = hard ? 'denied' : 'error';
  setMicBadge();
  if (hard || micFails >= 2) showMicPerm(err || ('连续 ' + micFails + ' 次失败'));
  else addErr('语音识别失败：' + (err || '未知'));
}

function startRec() {
  if (!SR) { showMicPerm('这个环境没有提供语音识别接口'); return; }
  releaseRec();   // 关键：先把上一次彻底 abort，否则麦克风一直被旧实例占着，连败后就起不来
  recCanceled = false; recFinal = ''; recInterim = ''; cancelMode = false; finalized = false;
  rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
  rec.onresult = (e) => {
    if (finalized) return;
    micFails = 0; if (micState !== 'granted') { micState = 'granted'; setMicBadge(); }
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) recFinal += r[0].transcript + ' ';
      else recInterim = r[0].transcript;
    }
  };
  rec.onend = () => finalize();
  rec.onerror = (ev) => { if (!finalized) recFailed((ev && ev.error) || ''); };
  try { rec.start(); } catch (e) { recFailed('start:' + ((e && e.message) || e)); return; }
  recording = true;
  setRecUI(true);
  $('recHint').textContent = '再点一次发送 · 上滑取消';
}

/* ---------------- 统一入口：优先本地 whisper（离线，不依赖网络） ---------------- */
async function asrInfo() {
  try { return await window.petAPI.asrStatus(); } catch { return null; }
}
async function startTalk() {
  /* 启动中标志：`recording` 只能在 await 之后才置 true，所以两个并发调用
     （快速连按空格 / 双击 🎤）以前都能穿过守卫，创建两条 MediaStream + AudioContext，
     被覆盖的那条既不 disconnect 也不 stop → 麦克风常驻、AudioContext 泄漏。 */
  if (recording || asrBusy || recStarting) return;
  recStarting = true;
  recAbort = false;
  try {
    if (window.PetASR && window.PetASR.supported()) {
      const st = await asrInfo();
      if (recAbort) return;                       // 启动期间已经松手 → 别再开录音
      if (st && st.hasModel && st.binary) {
        try {
          await window.PetASR.pushStart();
          /* 关键：启动（getUserMedia）期间用户就松手了 → 这里必须自己把录音关掉。
             以前 stopTalk 会因为 recording 还是 false 直接 return，而紧接着这里把
             recording 置 true —— 录音就永久开着，而且空格再也停不下来（spaceRec 已消费、
             keydown 又被 recording 挡住），只能去点 🎤。 */
          if (recAbort) {
            // 启动期间就被要求停：把刚开的流关掉，并把 UI 复位干净（别留上一次的提示文字）
            try { window.PetASR.pushStop(); } catch {}
            try { setRecUI(false); $('recHint').textContent = ''; } catch {}
            return;
          }
          recording = true; recMode = 'whisper'; cancelMode = false; finalized = false;
          setRecUI(true);
          $('recHint').textContent = '松开发送 · 本地识别（离线）';
          return;
        } catch (e) {
          try { window.petAPI.logErr('whisper pushStart fail: ' + ((e && e.message) || e)); } catch {}
        }
      } else if (st && st.binary && !st.hasModel) {
        showMicPerm('');
        $('micPermMsg').textContent = '本地语音模型还没下载（点「⬇ 下载语音模型」，约 75MB，只需一次）。这次先用在线识别。';
      }
    }
    if (recAbort) return;
    recMode = 'web';
    startRec();
    if (recording) $('recHint').textContent = '松开发送 · 在线识别';
  } finally {
    recStarting = false;
  }
}
async function stopTalk(cancel) {
  /* 启动还没完成就松手：只打取消标记，由 startTalk 自己收尾（pushStop 关掉刚开的流）。
     以前这里直接 return，于是"轻点空格"必然把录音留成永久开启。 */
  if (recStarting) { recAbort = true; return; }
  if (!recording || asrBusy) return;
  if (recMode !== 'whisper') { recCanceled = !!cancel; finalize(); return; }
  let wav = null;
  try { wav = window.PetASR.pushStop(); } catch {}
  if (cancel || !wav) { recording = false; setRecUI(false); $('recHint').textContent = ''; return; }
  asrBusy = true;
  $('recHint').textContent = '识别中…';
  const r = await window.petAPI.asrTranscribe(wav);
  asrBusy = false;
  recording = false; cancelMode = false;
  setRecUI(false);
  $('recHint').textContent = '';
  if (r && r.ok) {
    if (r.text) send(r.text);
    else addErr('没听清，再说一次？');
  } else {
    recFailed('whisper:' + ((r && r.error) || '?'));
  }
}

/* ---------------- 麦克风权限面板 ---------------- */
function showMicPerm(reason) {
  try {
    $('micPermReason').textContent = reason ? ('系统返回：' + reason) : '';
    $('micPermMsg').textContent = '';
    if ($('main').classList.contains('hidden')) showMain();
    $('micPerm').classList.remove('hidden');
  } catch {}
}
$('micPermOpen').addEventListener('click', async () => {
  $('micPermMsg').textContent = '已打开系统设置，把麦克风权限打开后回来点「我已授权」';
  try { await window.petAPI.micOpenSettings(); } catch {}
});
$('micPermRetry').addEventListener('click', async () => {
  $('micPermMsg').textContent = '正在检测…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $('micPermMsg').textContent = '✅ 麦克风可用，按住空格就能说话了';
    setTimeout(() => $('micPerm').classList.add('hidden'), 1300);
  } catch (e) {
    $('micPermMsg').textContent = '还是不行：' + ((e && e.name) || e) + '，确认系统设置里这一项已允许。';
  }
});
$('micPermClose').addEventListener('click', () => $('micPerm').classList.add('hidden'));

/* 下载本地语音模型（只需一次，之后完全离线） */
$('micPermDl') && $('micPermDl').addEventListener('click', async () => {
  const btn = $('micPermDl');
  const st = await asrInfo();
  const name = (st && st.model) || 'tiny.en';
  btn.disabled = true;
  $('micPermMsg').textContent = '正在下载 ' + name + ' …（约 75MB，中途别关窗口）';
  try {
    const r = await window.petAPI.asrDownload(name);
    $('micPermMsg').textContent = (r && r.ok)
      ? ('✅ 语音模型已就绪（' + name + '），现在可以完全离线识别了，按住空格试试。')
      : ('❌ 下载失败：' + ((r && r.error) || '未知') + '\n→ 可重试；或手动把 ggml-' + name + '.bin 放进数据目录的 asr 文件夹。');
  } catch (e) {
    $('micPermMsg').textContent = '❌ 下载失败：' + ((e && e.message) || e);
  } finally { btn.disabled = false; }
});
if (window.petAPI.onAsrProgress) window.petAPI.onAsrProgress((p) => {
  try {
    const mb = (n) => (n / 1048576).toFixed(1);
    const pct = p && p.total ? Math.round((p.got / p.total) * 100) : null;
    $('micPermMsg').textContent = '正在下载语音模型：' + mb((p && p.got) || 0) + ' / ' + (p && p.total ? mb(p.total) + ' MB' : '…') + (pct != null ? '（' + pct + '%）' : '');
  } catch {}
});

/* 语音自检：不需要说话，直接判定问题出在哪一环 */
async function runAsrSelfTest(render) {
  const say = (t) => { try { render(t); } catch {} };
  say('① 检查麦克风权限…');
  let mic = 'granted';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { mic = (e && e.name) || 'error'; }
  if (mic !== 'granted') {
    say('❌ 麦克风权限：' + mic + '\n→ 点「打开系统麦克风设置」把权限打开');
    try { window.petAPI.logErr('asr selftest mic=' + mic); } catch {}
    return { mic, verdict: 'mic-denied' };
  }

  const st = await asrInfo();
  if (st) {
    const engTxt = st.binary ? '✅ 已就绪' : '❌ 缺少 whisper-cli.exe';
    const modTxt = st.hasModel ? ('✅ ' + st.model + ' 已就绪') : '❌ 未下载（点「⬇ 下载语音模型」）';
    say('② 本地识别引擎（离线，不走网络）\n引擎文件：' + engTxt + '\n语音模型：' + modTxt);
    try { window.petAPI.logErr('asr selftest whisper binary=' + st.binary + ' model=' + st.model + ' hasModel=' + st.hasModel); } catch {}
    if (st.binary && st.hasModel) {
      say('✅ 本地识别可用（离线）\n按住空格说话，松开即识别；不依赖任何在线服务。');
      return { mic, whisper: true, model: st.model, verdict: 'ok-local' };
    }
    if (!st.binary) {
      say('❌ 本地引擎文件缺失（whisper-cli.exe）\n→ 程序文件不完整，需要重新安装/解压完整的应用目录。');
      return { mic, whisper: false, verdict: 'no-binary' };
    }
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    say('❌ 本地模型没下载，而且这个环境也没有在线识别接口\n→ 点「⬇ 下载语音模型」补上本地模型即可。');
    try { window.petAPI.logErr('asr selftest no-SR'); } catch {}
    return { mic, sr: false, verdict: 'no-api' };
  }

  say('③ 检查在线识别服务（约 10 秒，**不用说话**）…');
  const reason = await new Promise((resolve) => {
    let r;
    try { r = new SR(); } catch (e) { return resolve('ctor:' + ((e && e.message) || e)); }
    r.lang = 'en-US'; r.continuous = false; r.interimResults = true;
    let done = false;
    const fin = (x) => { if (!done) { done = true; resolve(x); } };
    r.onresult = () => { try { r.stop(); } catch {} fin('got-result'); };
    r.onerror = (e) => fin('error:' + ((e && e.error) || ''));
    r.onend = () => fin('ended');
    try { r.start(); } catch (e) { fin('start-throw:' + ((e && e.message) || e)); }
    setTimeout(() => { try { r.stop(); } catch {} fin('timeout'); }, 10000);
  });

  let verdict;
  if (reason === 'error:network' || reason === 'error:service-not-allowed') {
    verdict = '❌ 语音识别**服务连不上**（network）\n→ 这是识别引擎依赖在线服务导致的，国内网络常见。需要换识别方案。';
  } else if (reason === 'error:not-allowed') {
    verdict = '❌ 语音识别**权限被拒**\n→ 去系统设置给麦克风权限。';
  } else if (reason === 'error:audio-capture') {
    verdict = '❌ **没有可用的麦克风**（或已被其它程序占用）\n→ 检查录音设备 / 关掉占用麦克风的程序。';
  } else if (reason === 'error:no-speech' || reason === 'timeout' || reason === 'ended' || reason === 'got-result') {
    verdict = '✅ **引擎正常**（刚才只是没听到人说话）\n→ 可以正常录音。如果还是录不进去，多半是麦克风设备/音量问题。';
  } else {
    verdict = '⚠️ 结果：' + reason;
  }
  say('麦克风：' + mic + '\n语音识别：' + reason + '\n\n' + verdict);
  try { window.petAPI.logErr('asr selftest mic=' + mic + ' reason=' + reason); } catch {}
  return { mic, reason, verdict };
}

$('micPermTest').addEventListener('click', async () => {
  const btn = $('micPermTest');
  btn.disabled = true;
  $('micPermMsg').textContent = '';
  try { await runAsrSelfTest((t) => { $('micPermMsg').textContent = t; }); }
  finally { btn.disabled = false; }
});
if (window.petAPI.onMicPermission) window.petAPI.onMicPermission((r) => showMicPerm(r));
if (window.petAPI.onEndAsk) window.petAPI.onEndAsk(() => { try { $('endBtn').click(); } catch {} });

/* 桌宠那边（语音/投喂/摸摸头）说的话实时同步进来；不发声，它自己已经在读了 */
if (window.petAPI.onChatLog) window.petAPI.onChatLog((msg) => {
  if (!msg) return;
  try {
    if (msg.who === 'me') addUser(msg.text);
    else if (msg.who === 'pet') {
      if (!msg.en) return;
      addPet(msg.en, msg.zh, msg.words);
      if (msg.choices && msg.choices.length) renderChoices(msg.choices);
    }
  } catch {}
});

/* 点状态标签 = 重新检测并打开面板（里面有「🔍 语音自检」） */
$('micState').addEventListener('click', async () => {
  await checkMic(true);
  showMicPerm(micState === 'granted' ? '' : micState);
});
// 打开就静默检测一次，让用户一眼看出授没授权
setTimeout(() => { checkMic(true); }, 800);

/* ---------------- 按住空格说话（松开结束，像语音输入） ---------------- */
let spaceRec = false;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (e.repeat) return;
  const t = e.target;
  const tag = t && t.tagName;
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || !!(t && t.isContentEditable);
  const chatInput = !!(t && t.id === 'input');
  /* 只有在"没落在输入框"或"落在聊天输入框且没在打字"时，空格才是按住说话。
     以前是 `if (typing && t.value) return;` —— 只判有没有内容，于是设置/人设/音色/游戏任务
     那些**空**输入框里按空格会被 preventDefault 吞掉并开始录音，空格打不进去还发出一条消息。 */
  if (editable && !chatInput) return;
  if (chatInput && t.value) return;      // 聊天框里正在打字 → 空格就是空格
  if (recording || asrBusy || recStarting) return;
  e.preventDefault();
  spaceRec = true;
  startTalk();
}, true);
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (!spaceRec) return;
  spaceRec = false;
  e.preventDefault();
  stopTalk(false);
}, true);

// 点一下开始；再点一下立即发送（不等识别器收尾）
$('mic').addEventListener('click', (e) => {
  if (!recording && !asrBusy) { recStartY = e.clientY; startTalk(); }
  else { stopTalk(cancelMode); }
});

window.addEventListener('mousemove', (e) => {
  if (!recording) return;
  cancelMode = recStartY - e.clientY > 60;
  $('recHint').textContent = cancelMode ? '点击任意位置取消' : (recMode === 'whisper' ? '松开发送 · 本地识别（离线）' : '再点一次发送 · 上滑取消');
});

window.addEventListener('mousedown', (e) => {
  if (!recording || !cancelMode) return;
  if (e.target.closest('#mic')) return; // 点麦克风走上面的发送逻辑
  recCanceled = true;
  stopTalk(true);
});

/* ---------------- 欢迎语 ---------------- */
function greet() {
  if ($('msgs').childElementCount) return;
  const hello = {
    en: "Hmph! I am NOT a freeloader fat fish. ...Anyway, good morning, Master.",
    zh: '哼！我才不是吃白饭的大肥鱼。……总之，早上好，主人。',
    words: [
      { w: 'freeloader', ipa: '/ˈfriːləʊdə/', zh: '白吃白喝的人' },
      { w: 'anyway', ipa: '/ˈeniweɪ/', zh: '总之' }
    ]
  };
  addPet(hello.en, hello.zh, hello.words);
  speak(hello.en);
  renderChoices([
    { en: 'Good morning! I slept great.', zh: '早上好！我睡得很好。', ipa: '/ɡʊd ˈmɔːnɪŋ! aɪ slept ɡreɪt/' },
    { en: 'Morning! A bit sleepy though.', zh: '早！不过还有点困。', ipa: '/ˈmɔːnɪŋ! ə bɪt ˈsliːpi ðəʊ/' }
  ]);
}
