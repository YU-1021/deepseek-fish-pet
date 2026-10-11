const $ = (id) => document.getElementById(id);

let cfg = {};
let busy = false;
let ttsOn = true;
let slowPlay = false;      // 慢速朗读（init 阶段就要用，必须声明在顶部）
/* 🔊 一个按钮三态：常速 → 慢速 → 关闭 */
function paintTtsBtn() {
  const b = $('ttsBtn');
  if (!b) return;
  b.textContent = ttsOn ? (slowPlay ? '🐢' : '🔊') : '🔇';
  b.classList.toggle('on', ttsOn);
  b.title = ttsOn
    ? (slowPlay ? '朗读：慢速（点一下关闭）' : '朗读：常速（点一下切慢速）')
    : '朗读：已关闭（点一下开常速）';
}
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
  paintTtsBtn();
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
    $('model').value = cfg.model || 'deepseek-flash';
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

/* ---------------- 生词本 + 进步曲线 ---------------- */
let vocabData = [];
async function renderTrend() {
  const box = $('vocabTrend');
  if (!box) return;
  try {
    const t = await window.petAPI.speakTrend(14);
    if (!t || !t.total) { box.innerHTML = '<div class="trendline">还没有练习记录 —— 对着麦克风说几句英语就会记下来。</div>'; return; }
    const max = Math.max.apply(null, t.days.map((d) => d.avg).concat([0.01]));
    box.innerHTML = '<div class="trendline">近 14 天：练了 <b>' + t.total + '</b> 次　平均 <b>'
      + Math.round(t.avg * 100) + '</b>　最好 <b>' + Math.round(t.best * 100) + '</b></div>'
      + t.days.map((d) => '<div class="tbar"><span class="tday">' + d.date.slice(5) + '</span>'
        + '<span class="tfill s-' + (d.avg >= 0.8 ? 'good' : d.avg >= 0.55 ? 'ok' : 'poor')
        + '" style="width:' + Math.max(3, Math.round(d.avg / max * 100)) + '%"></span>'
        + '<span class="tval">' + Math.round(d.avg * 100) + ' ×' + d.n + '</span></div>').join('');
  } catch {}
}
async function renderVocab() {
  vocabData = await window.petAPI.vocabList();
  renderTrend();
  try {
    const a = await window.petAPI.speakAutoAdd();
    if (a && $('vocabAuto')) $('vocabAuto').checked = a.on !== false;
    /* 发音评测开关：读一次 config，回填勾选状态（不做成独立 IPC，少一个渠道） */
    try {
      const c = await window.petAPI.configGet();
      if (c && c.pron && $('pronOn')) $('pronOn').checked = c.pron.enabled !== false;
    } catch {}
  } catch {}
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
if ($('vocabAuto')) $('vocabAuto').addEventListener('change', async (e) => {
  const r = await window.petAPI.speakAutoAdd(e.target.checked);
  addSys((r && r.on) ? '📒 已开启：读得含糊的词自动收进生词本' : '📒 已关闭自动收录');
});
/* 「像不像」评测开关（写进 config.pron.enabled，参数都在 config.json 里，随时可调） */
if ($('pronOn')) $('pronOn').addEventListener('change', async (e) => {
  try { await window.petAPI.configSet({ pron: { enabled: !!e.target.checked } }); } catch {}
  addSys(e.target.checked
    ? '🎯 已开启「像不像」评测：跟读时用 DTW 对比母语者 TTS，可疑的词会加下划线（实验性，阈值在 config.pron 里）'
    : '🎯 已关闭「像不像」评测');
});
/* 🐢 慢速朗读已经并进 🔊 的三态里了，原来单独的按钮不再需要 */

// 单词 Shift+点 → 收藏进生词本（普通点击是朗读，见上面的处理器）
document.addEventListener('click', async (e) => {
  const el = e.target.closest('#msgs .w');
  if (!el || !e.shiftKey) return;
  const w = el.textContent.trim();
  if (!w) return;
  await window.petAPI.vocabAdd({ w, ipa: el.dataset.ipa || '', zh: el.dataset.zh || '' });
  addSys(`📒 已加入生词本：${w}　（直接点=朗读，Shift+点=收藏）`);
});

/* ---------------- 消息渲染 ---------------- */
function scroll() { const m = $('msgs'); m.scrollTop = m.scrollHeight; }
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z']/g, '');

/* 用户说过的英文：逐词上色（清晰度）+ 悬停音标 + 点击朗读
   颜色含义 = "这个词读得清不清楚"（whisper token 概率的代理），**不是语法评分**。 */
function renderScored(text, score, ipaMap) {
  const words = (score && score.words) || [];
  const map = ipaMap || {};
  let wi = 0;
  return String(text || '').split(/(\s+)/).map((tok) => {
    const m = tok.match(/^([A-Za-z']+)([^A-Za-z']*)$/);
    if (!m) return esc(tok);
    /* 同一次识别结果，顺序必然一致 → 优先按序对上；对不上再全局找一次 */
    let sw = null;
    if (wi < words.length && norm(words[wi].w) === norm(m[1])) { sw = words[wi]; wi++; }
    else sw = words.find((x) => norm(x.w) === norm(m[1])) || null;
    if (!sw) return esc(tok);
    const info = map[norm(sw.w)] || {};
    return '<span class="w s-' + sw.band + '" data-w="' + esc(sw.w) + '" data-p="' + sw.p + '"'
      + (info.ipa ? ' data-ipa="' + esc(info.ipa) + '"' : '')
      + (info.zh ? ' data-zh="' + esc(info.zh) + '"' : '')
      + ' title="清晰度 ' + Math.round(sw.p * 100) + '｜点一下听发音">' + esc(m[1]) + '</span>' + esc(m[2]);
  }).join('');
}
function addUser(text, opts) {
  const d = document.createElement('div');
  d.className = 'msg user';
  const score = opts && opts.score;
  if (score && score.words && score.words.length) {
    d.innerHTML = renderScored(text, score, (opts && opts.ipa) || {});
    d.dataset.words = JSON.stringify(score.words.map((x) => x.w));
    const head = document.createElement('div');
    head.className = 'scoreline';
    const n = score.counts || {};
    head.innerHTML = '清晰度 <b class="s-' + score.band + '">' + Math.round(score.overall * 100) + '</b>'
      + '<span class="hint">🟩清晰 ' + (n.good || 0) + ' · 🟨一般 ' + (n.ok || 0) + ' · 🟥含糊 ' + (n.poor || 0)
      + '　（颜色=读得清不清楚，不是语法评分）</span>'
      + ((opts && opts.autoAdded && opts.autoAdded.length)
        ? '<span class="hint">📒 已自动收录：' + opts.autoAdded.map((w) => esc(w)).join(', ') + '</span>' : '');
    d.insertBefore(head, d.firstChild);
  } else {
    d.textContent = text;
  }
  $('msgs').appendChild(d); scroll();
  return d;
}

/* 点用户消息 / 翻译器里的单词 → 朗读这个词（慢速模式会放慢）
   注意：slowPlay 声明在文件顶部（init 阶段就要用，放这里会踩 TDZ） */
const playRate = () => (slowPlay ? 0.62 : undefined);
document.addEventListener('click', async (e) => {
  const el = e.target.closest('#msgs .w, .tropt .w');
  if (!el) return;
  if (e.shiftKey) return;                      // Shift+点是"收藏生词"，交给下面的处理器
  const w = el.dataset.w || el.textContent;
  if (!w) return;
  el.classList.add('playing');
  setTimeout(() => el.classList.remove('playing'), 1200);
  try { await window.petAPI.ttsSpeak({ text: String(w).replace(/[^A-Za-z'\- ]/g, ''), force: true, rate: playRate() }); } catch {}
});
function addPet(en, zh, words) {
  const d = document.createElement('div');
  d.className = 'msg pet';
  d.innerHTML = `<div class="en">${renderEn(en, words)}</div>` + (zh ? `<div class="zh">${esc(zh)}</div>` : '');
  /* 跟读入口：她说了完整一句就挂个按钮（省略号是"正在说"的占位，不给） */
  if (en && en !== '…' && /[A-Za-z]{3}/.test(en)) {
    const acts = document.createElement('div');
    acts.className = 'petacts';
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = '🎤 跟读这句';
    b.addEventListener('click', () => startRepeat(en));
    acts.appendChild(b);
    d.appendChild(acts);
  }
  $('msgs').appendChild(d); scroll();
  return d;
}

/* ---------------- 跟读：她说一句 → 你读一遍 → 对比打分 ----------------
 * 跟读时 ASR 结果**不进对话**，只做对比：目标词覆盖率 + 逐词清晰度。 */
let repeatTarget = '';
function startRepeat(en) {
  repeatTarget = String(en || '').trim();
  addSys('🎤 跟读模式：照着她那句话读一遍，说完自动对比（不想跟读就再说一句别的）');
  try { if (!recording) startTalk(); } catch { addSys('麦克风没起来？点输入框左边的 🎤 手动开始'); }
}
/* ---------------- 发音评测（"像不像"）----------------
 * 只在**跟读**里跑：跟读有明确的目标句，才能合成"母语者参考音频"来对比。
 * 依据 发音评测可行性-20261001.md：
 *   · 只用逐词**相对分** S = 该词代价 / 其它词均值；绝对分会被音色差异淹没（换音色 4.014 > 换词 3.033）
 *   · 阈值等全部参数来自主进程返回的 cfg.pron，**这里不写死任何数字**
 *   · 它是独立于"清晰度"的第二条色带：清晰度测"读清楚了没"，S 测"像不像母语者" */
/* 把解码后的音频重采样成 **16kHz 单声道** 并封成 WAV。
 * 为什么必须做这一步：Edge TTS 给的是 48kHz mp3，直接把 mp3 喂 whisper-cli 虽然能出文字，
 * 但 **token 时间戳是坏的**（实测 'answer' 的 offsets 是 {from:7100,to:7100} 零长，
 * 段级还报 0~30000ms 而音频只有 7 秒）。逐词归因全靠这组时间戳，坏了就全错位。
 * OfflineAudioContext 顺带就完成了重采样，WAV 头自己封。 */
async function toWav16k(audioBuffer) {
  const sr = 16000;
  const n = Math.max(1, Math.ceil(audioBuffer.duration * sr));
  const off = new OfflineAudioContext(1, n, sr);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const ab = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return { wav: ab, pcm, sampleRate: sr };
}
async function pronScore(userWav, targetText) {
  const P = window.PetDTW;
  if (!P || !userWav) return null;
  let ref = null;
  try { ref = await window.petAPI.pronRef(targetText); } catch (e) { return { error: (e && e.message) || String(e) }; }
  if (!ref || !ref.ok) return { error: (ref && ref.error) || '拿不到参考音频' };
  const params = ref.params || {};
  if (params.enabled === false) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    /* decodeAudioData 会把 ArrayBuffer「拿走」，所以用户音频要 copy 一份再解 */
    const [uBuf, rBuf] = await Promise.all([
      ctx.decodeAudioData(userWav.slice ? userWav.slice(0) : userWav),
      fetch(ref.dataUrl).then((x) => x.arrayBuffer()).then((ab) => ctx.decodeAudioData(ab)),
    ]);
    /* 参考音频统一用重采样后的 16k，和 whisper 的时间戳同一时间轴 */
    const r16 = await toWav16k(rBuf);
    let words = ref.words;
    if (!words || !words.length) {
      const t = await window.petAPI.pronTiming(targetText, r16.wav);
      if (!t || !t.ok) return { error: (t && t.error) || '拿不到参考词级时间戳' };
      words = t.words;
    }
    const out = P.score(uBuf.getChannelData(0), uBuf.sampleRate, r16.pcm, r16.sampleRate, words, params);
    out.threshold = Number(params.threshold);
    return out;
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  } finally { try { ctx.close(); } catch {} }
}
/* 把「像不像」渲染成独立一行 + 在"她说的"那句里给可疑词加下划线 */
function paintPron(box, res) {
  const line = document.createElement('div');
  line.className = 'rline';
  if (!res) { line.innerHTML = '<span class="rlab">像不像</span><span class="pdim">（没跑评测）</span>'; box.appendChild(line); return; }
  if (res.error) { line.innerHTML = '<span class="rlab">像不像</span><span class="pdim">评测失败：' + esc(res.error) + '</span>'; box.appendChild(line); return; }
  const th = Number(res.threshold);
  /* 只认 reliable 的词：dtw.js 会给"帧数不足 minWordFrames"和"时间戳全缺(timingDegenerate)"
     打上 reliable:false —— 那些位置的 S 是等分时间轴算出来的，不可信，宁可漏报也不能乱指认 */
  const ws = (res.words || []).filter((x) => Number.isFinite(x.S) && x.reliable !== false);
  const sus = ws.filter((x) => x.S > th).sort((a, b) => b.S - a.S);
  line.innerHTML = '<span class="rlab">像不像</span>'
    + (sus.length
      ? sus.map((x) => '<b class="psus">' + esc(x.w) + '</b> <span class="pval">' + x.S.toFixed(2) + '</span>').join('　')
        + '<span class="pdim">　（S &gt; ' + th + ' 判为可疑；只看相对值，不给绝对分）</span>'
      : '<span class="pok">没发现明显可疑的词</span><span class="pdim">（最高 S=' + (res.maxS != null ? Number(res.maxS).toFixed(2) : '-') + '）</span>');
  box.appendChild(line);
  /* 在"她说的"那句里把最可疑的词标出来，让对照更直观 */
  if (sus.length) {
    const first = box.querySelector('.rline .rlab');
    const targetLine = first && first.parentElement;
    if (targetLine) {
      const words = new Set(sus.map((x) => String(x.w).toLowerCase().replace(/[^a-z']/g, '')));
      targetLine.innerHTML = targetLine.innerHTML.replace(/([A-Za-z']+)/g, (m) => (words.has(m.toLowerCase()) ? '<span class="psus">' + m + '</span>' : m));
    }
  }
}
function showRepeat(target, text, score, userWav) {
  const tw = (target.toLowerCase().match(/[a-z']+/g) || []);
  const uw = (text.toLowerCase().match(/[a-z']+/g) || []);
  const uset = new Set(uw);
  const missing = tw.filter((w) => !uset.has(w));
  const cover = tw.length ? Math.round(((tw.length - missing.length) / tw.length) * 100) : 0;
  const d = document.createElement('div');
  d.className = 'msg user repeat';
  d.innerHTML = '<div class="scoreline">跟读对比　覆盖 <b>' + cover + '%</b>　清晰度 <b class="s-'
    + (score ? score.band : 'ok') + '">' + (score ? Math.round(score.overall * 100) : '--') + '</b></div>'
    + '<div class="rline"><span class="rlab">她说的</span>' + esc(target) + '</div>'
    + '<div class="rline"><span class="rlab">你说的</span>' + (score ? renderScored(text, score, {}) : esc(text)) + '</div>'
    + (missing.length
      ? '<div class="rmiss">没听到或没读清：' + missing.map((w) => esc(w)).join(', ') + '</div>'
      : '<div class="rok">整句都对上了 👍</div>');
  $('msgs').appendChild(d); scroll();
  /* 「像不像」要合成 TTS + 跑 DTW，比上面慢，所以异步补一行进来 */
  pronScore(userWav, target).then((res) => { paintPron(d, res); scroll(); }).catch(() => {});
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

/* ★★ 过程气泡（照 DSH 的设计做）★★
   用户诉求："现在做一次任务这输出太多了，得像你这样的显示"。
   根因：原来多步任务的**每个中间步骤**都是 addPet —— 一整条中英双语消息 + 一排选项，
   一个 8 步任务刷 8 条长消息 ✗。
   DSH 的做法（我读它的 client.js 学到的）：**一个过程气泡装一组调用**，
   标题按【种类】聚合（「已读取文件，运行了命令」），运行中显示「正在运行命令」，
   细节收在里面可展开 —— 而不是一条调用一条消息。
   这里的实现刻意**极简、零新增风险**：
     · 不引入新消息类型、不加新 CSS 类、不动任何初始化路径
     · 只复用已经能正常工作的 addSys()（它做的就是 appendChild 一个 div.msg.sys）
     · 全程维护**同一个元素**，只改它的 textContent
   → 最坏情况也只是这一行文字不对，绝不可能像前两次那样把整个聊天窗弄空白 ✗✓。 */
let PROC = null;
const PROC_KIND = {
  look: '看屏幕', commands: '操作', window: '找窗口', web: '网页', write: '写入', other: '操作',
};
/* 把工具名映射成 DSH 那种"种类" */
function procKind(tool) {
  const t = String(tool || '');
  if (/^(screen_look|screen_shot|screen_diff|watch_screen)$/.test(t)) return 'look';
  if (/^(click|rclick|dclick|move|drag|scroll|type|key)$/.test(t)) return 'commands';
  if (/^(focus_window|windows_list|find_text|find_template|find_template_scroll|uia_find|uia_dump)$/.test(t)) return 'window';
  if (/^(web_open|web_read|web_click|web_type)$/.test(t)) return 'web';
  if (/^(skill_write|proj_run|memory_)/.test(t)) return 'write';
  return 'other';
}
/* 刷新那一行的文字（聚合摘要，照 DSH 的 processTitle 思路） */
function procRender(live) {
  try {
    if (!PROC || !PROC.el) return;
    const cnt = {};
    for (const it of PROC.items) cnt[it.kind] = (cnt[it.kind] || 0) + 1;
    const kinds = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 3)
      .map((k) => (PROC_KIND[k] || k) + (cnt[k] > 1 ? '×' + cnt[k] : ''));
    const summary = kinds.length ? kinds.join(' · ') : '准备';
    const more = Object.keys(cnt).length > 3 ? ' 等 ' + Object.keys(cnt).length + ' 类' : '';
    const failN = PROC.items.filter((x) => x.ok === false).length;
    PROC.el.textContent = live
      ? '⏳ 进行中：' + summary + more + '　（' + String(live).slice(0, 60) + '）'
      : '✅ 已完成：' + summary + more + (failN ? '　（其中 ' + failN + ' 步失败）' : '');
    if (typeof scroll === 'function') scroll();
  } catch (e) { /* ★ 绝不外抛 ★ */ }
}
/* 开始/继续一个过程（一个任务只有一个气泡） */
function procAdd(tool, detail, ms, ok) {
  try {
    if (!PROC) {
      addSys('⏳ 开始…');
      const box = $('msgs');
      PROC = { el: box.lastElementChild, items: [] };
    }
    PROC.items.push({ kind: procKind(tool), tool: String(tool || ''), text: String(detail || ''), ms: ms || 0, ok });
    procRender(String(tool || '') + ' ' + String(detail || ''));
    return PROC.el;
  } catch (e) { PROC = null; return null; }
}
/* 任务收尾：把同一行改成总结 */
function procDone() {
  try { if (PROC) { procRender(''); PROC = null; } } catch (e) { PROC = null; }
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
  /* 把**显式的停止原因**一并上报（completed / step-budget / look-streak / no-result / no-next / aborted / error）。
     以前只知道"任务结束了"，查不出为什么 —— 今天那次自转就是因此才要翻代码找根因。 */
  try { window.petAPI.statsTask({ ok: !taskFailed, stopReason: taskStopReason }); } catch {}
  refreshBudget();
}

// 多步任务：执行 → 把结果喂回模型 → 看下一步，直到收尾或到步数上限
/* 【只看不动的自转闸门】实测事故：用户看到她一秒回两次、连回十几条
   "好，先不瞎点了，老老实实看一眼屏幕…"，而她自己都说"我卡住了、现在什么都不做" ——
   但循环没停。根因在下面第 786 行：视觉工具（screen_look）会**直接给出下一步动作**并
   跳过文本模型，如果那个动作又是 screen_look，就形成"看屏幕→又想看屏幕"的自转；
   而唯一的闸门是 depth > stepBudget —— 用户刚把步数上限调到 400，于是空转 400 次
   （按每 0.6 秒一次算，能刷好几分钟、同时飞快烧 token）。
   这里的闸门跟"工具是否真的改变了什么"无关，只看**连续多少次都只是在看**：
   连续 LOOK_STREAK_MAX 次没有实际动作（点击/按键/输入/滚轮这类），就停下来。 */
const LOOK_ONLY_TOOLS = ['screen_look', 'screen_shot', 'windows_list', 'template_list', 'find_template', 'find_text', 'find_template_scroll'];
const LOOK_STREAK_MAX = 6;
let lookStreak = 0;
/* 【主循环驱动器】停止条件的判定收进 renderer/loop.js（照 DSH dsh-agent-loop 的显式停止原因）。
   上面那两个旧变量保留：lookStreak 仍用于显示/兼容，判定则统一走 LOOP。
   每次任务开始时重建 —— 这样步数预算（stepBudget 会随 IQ 变化）能按当前值生效。 */
let LOOP = null;
let taskStopReason = null;
/* 【防"只承诺不动作"冻死】她说过"我这就去排""找到了"却**没给 ACTION**时，
   原来这里直接判 completed 收尾 → 任务静默死掉（实测 4 次，用户两次问"她怎么不动了"）。
   现在最多把循环续 2 次、催她要 ACTION。 */
let promiseNudge = 0;
/* ★ 收尾核对（铁律 3 的程序强制）★
   TASK_TARGET = 这一轮任务里"要找到的那个东西"（只认带引号的目标名 ✓）
   targetChecked = 是否已经催过她一次（★只催一次，绝不无限循环 ✗★） */
let lastUserText = "";
let TASK_TARGET = null;
let targetChecked = false;
/* 从任务原文里提取"带引号的目标名"——★只认引号，避免把"所有干员"当目标 ✗★ */
function extractTarget(text) {
  const t = String(text || "");
  const m = t.match(/找[出到]?[^「『"\']{0,6}[「『"\']([^「」『』"\']{1,14})[」』"\']/);
  if (m && m[1]) return m[1].trim();
  const m2 = t.match(/[「『"\']([^「」『』"\']{1,14})[」』"\']\s*(?:在哪|在什么位置|的位置)/);
  return (m2 && m2[1]) ? m2[1].trim() : null;
}
/* 收尾里算不算"交代了目标" */
function targetAddressed(said) {
  if (!TASK_TARGET) return true;
  const s2 = String(said || "");
  if (s2.indexOf(TASK_TARGET) >= 0) return true;
  return /没找到|找不到|没有找到|没看到|没看见|没有它|不在这|不在屏幕|无法找到|未见/.test(s2);
}

function newLoop() {
  if (!window.PetLoop) return null;
  return window.PetLoop.create({ lookOnlyTools: LOOK_ONLY_TOOLS, lookStreakMax: LOOK_STREAK_MAX, stepBudget: stepBudget });
}
async function runTask(msgEl, action, depth) {
  if (depth === 1) {
    taskFailed = false; lookStreak = 0; taskStopReason = null; promiseNudge = 0; LOOP = newLoop();
    /* ★ 首轮：从这一轮任务的原文里取出"要找到的目标"★ */
    targetChecked = false;
    try { TASK_TARGET = extractTarget((lastUserText || "")); } catch (e) { TASK_TARGET = null; }
    if (TASK_TARGET) addSys("🎯 这一轮的目标词是「" + TASK_TARGET + "」—— 收尾时我必须交代它找到了没有 ✓");
  }
  if (LOOP) {
    const d = LOOP.beforeStep({ tool: action.tool });
    if (d.kind === 'stop') {
      taskStopReason = d.reason;
      addSys(d.message);
      reportTask();
      return;
    }
    lookStreak = LOOP.stats().lookStreak;   // 仅用于界面显示，判定已在 LOOP 里
  } else if (depth > stepBudget) {
    /* 兜底：万一 loop.js 没加载上，仍然保留旧的步数闸门（宁可保守，也不能无限跑） */
    taskStopReason = 'step-budget';
    addSys('⏸ 已达到本次任务的步数上限（' + stepBudget + '），先停下来');
    reportTask();
    return;
  }
  /* ★ 过程气泡：这一小步开始（沿用 DSH"一个气泡装一组调用"的思路）★ */
  const _pt0 = Date.now();
  procAdd(action.tool, action.arg, 0, null);
  const r = await execAction(action);
  /* ★ 标成完成/失败 —— 仍然是同一个气泡，只更新文字 ★ */
  try {
    const _txt = (r && (r.result || r.text)) ? String(r.result || r.text) : '';
    const _bad = /^(❌|⚠️|✗)/.test(_txt.trim()) || /失败|错误|FAIL|被拦|不支持/.test(_txt.slice(0, 120));
    procAdd(action.tool, action.arg, Date.now() - _pt0, !_bad);
  } catch (e) {}
  if (!r) { if (LOOP) taskStopReason = LOOP.finish('no-result').reason; procDone(); reportTask(); return; }
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
  } catch (e) { if (LOOP) taskStopReason = LOOP.fail(e).reason; addErr('模型继续失败：' + e.message); reportTask(); return; }
  if (!next || !next.en) { if (LOOP) taskStopReason = LOOP.finish('no-next').reason; reportTask(); return; }
  /* ★★ 关键：中间步骤不再生成整条中英双语消息（用户："输出太多了"）★★
     有下一步动作 → 只更新那个过程气泡（一行摘要）；
     没有动作（=收尾）→ 才 addPet 完整渲染 + 朗读。 */
  if (next.action) {
    const holder = document.createElement('div');
    holder.className = 'msg step-holder';
    holder.style.display = 'none';
    $('msgs').appendChild(holder);
    renderAction(holder, next.action, () => runTask(holder, next.action, depth + 1), () => {});
  } else {
    procDone();
    const pe = addPet(next.en, next.zh, next.words);
    renderChoices(next.choices);
    /* ★ 她这条只说话、没给 ACTION —— 以前直接当"做完了"收尾，任务就静默冻死。
       如果她那句话**听起来还在继续做**（"我这就去/找到了/再看一眼/稍等"），
       就把循环续上、明确催她要 ACTION（最多 2 次，避免死循环）。 */
    const said = String(next.zh || '') + ' ' + String(next.en || '');
    const PROMISE = /这就|马上|稍等|我去|我先|继续|接下来|现在去|正在|让我|再看|再找|再滚|再看一眼|我去看|I'll|I will|let me|on it|continuing|next I|give me a (sec|moment)|hold on/i;
    if (promiseNudge < 2 && PROMISE.test(said)) {
      promiseNudge++;
      addSys('⏳ 你这条只说了话、**没给 ACTION** —— 循环会以为你做完了。我替你续上：请立刻给出下一步 ACTION。');
      try {
        const nn = await window.petAPI.chatContinue({
          tool: 'screen_look', arg: '（续）',
          result: '⏳ 你上一条回复里**没有 ACTION**，任务还没做完。请**立刻给出下一步 ACTION**（不要只说"我去做/稍等/找到了"）。如果确实全部做完并回读验证过了，就把结果说清楚。',
        });
        if (nn && nn.en) {
          const ne = addPet(nn.en, nn.zh, nn.words);
          renderChoices(nn.choices);
          if (nn.action) { renderAction(ne, nn.action, () => runTask(ne, nn.action, depth + 1), () => {}); return; }
          speak(nn.en);
        }
      } catch {}
    }
    /* ★★★ 铁律 3 的程序强制：收尾必须交代"用户要的那个东西"★★★
       ★只催一次★（targetChecked ✓）—— 误判可以接受，把她卡死不行 ✗ */
    const _said = String(next.zh || "") + " " + String(next.en || "");
    if (TASK_TARGET && !targetChecked && !targetAddressed(_said)) {
      targetChecked = true;
      addSys("🎯 停一下 —— 主人要的是「" + TASK_TARGET + "」，"
        + "但你这条收尾里**既没提到它、也没说没找到** ✗。\n"
        + "★请明确回答一句：找到了还是没找到？★"
        + "（如果没找到，就说清试过什么、需要主人做什么 ✓ —— 这是允许的，比含糊过去好得多 ✓）");
      try {
        const _nn = await window.petAPI.chatContinue({
          tool: "screen_look", arg: "（收尾核对）",
          result: "🎯 主人这一轮要你找的是「" + TASK_TARGET + "」。你上一条收尾里"
            + "既没有提到它、也没有说没找到 ✗。请**明确回答**："
            + "① 找到了就说它在哪；② 没找到就直说\"我没找到 " + TASK_TARGET + "\"，"
            + "并说清试过哪几种办法、需要主人做什么。★不要用别的观察来含糊过去 ✗★",
        });
        if (_nn && _nn.en) {
          const _ne = addPet(_nn.en, _nn.zh, _nn.words);
          renderChoices(_nn.choices);
          if (_nn.action) { renderAction(_ne, _nn.action, () => runTask(_ne, _nn.action, depth + 1), () => {}); return; }
          speak(_nn.en);
          if (LOOP) taskStopReason = LOOP.finish("completed").reason;
          reportTask();
          return;
        }
      } catch (e) {}
    }
    if (LOOP) taskStopReason = LOOP.finish('completed').reason;
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

/* 音标是后台补的（缓存里没有的新词才会去问模型）：到了就把用户消息里的词补上，
   之后鼠标悬停就能看到音标。不阻塞识别，也不用等。 */
if (window.petAPI.onSpeakIpa) window.petAPI.onSpeakIpa((d) => {
  const map = (d && d.ipa) || {};
  document.querySelectorAll('#msgs .msg.user .w, .tropt .w').forEach((el) => {
    const info = map[norm(el.dataset.w || el.textContent)];
    if (!info) return;
    if (info.ipa && !el.dataset.ipa) el.dataset.ipa = info.ipa;
    if (info.zh && !el.dataset.zh) el.dataset.zh = info.zh;
  });
});

/* ---------------- 翻译器：想说什么但不知道英文怎么讲 ---------------- */
$('transBtn').addEventListener('click', () => {
  $('trMsg').textContent = '';
  $('translator').classList.remove('hidden');
  setTimeout(() => { try { $('trInput').focus(); } catch {} }, 50);
});
$('trCancel').addEventListener('click', () => $('translator').classList.add('hidden'));
async function doTranslate() {
  const text = $('trInput').value.trim();
  if (!text) { $('trMsg').textContent = '先写点中文吧'; return; }
  $('trGo').disabled = true; $('trMsg').textContent = '翻译中…'; $('trOut').innerHTML = '';
  try {
    const r = await window.petAPI.speakTranslate(text);
    if (!r || !r.ok) { $('trMsg').textContent = '失败：' + ((r && r.error) || '?'); return; }
    $('trMsg').textContent = '';
    $('trOut').innerHTML = r.options.map((o, i) =>
      '<div class="tropt" data-i="' + i + '">'
      + '<div class="en">' + renderEn(o.en, o.words || []) + '</div>'
      + (o.zh ? '<div class="zh">' + esc(o.zh) + '</div>' : '')
      + (o.note ? '<div class="note">' + esc(o.note) + '</div>' : '')
      + '<div class="acts"><button class="ghost play">🔊 整句朗读</button><button class="ghost use">用它回答</button></div>'
      + '</div>').join('');
    $('trOut').querySelectorAll('.tropt').forEach((box) => {
      const o = r.options[+box.dataset.i];
      box.querySelector('.play').addEventListener('click', () => { try { window.petAPI.ttsSpeak({ text: o.en, force: true }); } catch {} });
      box.querySelector('.use').addEventListener('click', () => {
        $('translator').classList.add('hidden');
        try { send(o.en); } catch {}
      });
    });
  } catch (e) { $('trMsg').textContent = '失败：' + ((e && e.message) || e); }
  finally { $('trGo').disabled = false; }
}
$('trGo').addEventListener('click', doTranslate);
$('trInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTranslate(); } });

/* ---------------- 对话 ---------------- */
async function send(text, opts) {
  try { lastUserText = String(text || ""); } catch (e) {}
  text = String(text || '').trim();
  if (!text || busy) return;
  busy = true;
  $('input').value = ''; $('choices').innerHTML = '';
  addUser(text, opts);
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
  /* 一个按钮三态：常速 → 慢速 → 关闭（原来 🔊 和 🐢 两个图标太占地方） */
  if (!ttsOn) { ttsOn = true; slowPlay = false; }
  else if (!slowPlay) { slowPlay = true; }
  else { ttsOn = false; slowPlay = false; stopSpeech(); }
  paintTtsBtn();
  await window.petAPI.configSet({ ttsEnabled: ttsOn });
});
/* ⋯ 更多：把不常用的收进下拉。元素没删、id 还在，原来的绑定照旧生效 */
const moreMenu = $('moreMenu');
function closeMore() { if (moreMenu) moreMenu.classList.add('hidden'); }
if ($('moreBtn')) $('moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle('hidden');
});
if (moreMenu) moreMenu.addEventListener('click', () => closeMore());
document.addEventListener('click', (e) => {
  if (!moreMenu || moreMenu.classList.contains('hidden')) return;
  if (e.target.closest('#moreMenu') || e.target.closest('#moreBtn')) return;
  closeMore();
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
  ttsOn = true; paintTtsBtn();
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
    /* 跟读中 → 不进对话，只做对比；否则带上逐词清晰度 + 音标发出去 */
    if (r.text) {
      if (repeatTarget) { const t = repeatTarget; repeatTarget = ''; showRepeat(t, r.text, r.score, wav); }
      else send(r.text, { score: r.score, ipa: r.ipa, autoAdded: r.autoAdded });
    } else addErr('没听清，再说一次？');
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

/* VAD（静音检测）模型：可选，但实测免幻觉 + 快 53% */
$('micPermVad') && $('micPermVad').addEventListener('click', async () => {
  const btn = $('micPermVad');
  btn.disabled = true;
  $('micPermMsg').textContent = '正在下载 VAD 静音检测模型 …（约 0.9MB，很快）';
  try {
    const r = await window.petAPI.asrDownload('vad');
    $('micPermMsg').textContent = (r && r.ok)
      ? '✅ VAD 已就绪：以后识别只处理语音段 —— 静音段不再产生幻觉词，而且快一半。'
      : ('❌ VAD 下载失败：' + ((r && r.error) || '未知') + '\n→ 三个源都试过了；网络恢复后再点一次即可，不影响现有识别。');
  } catch (e) {
    $('micPermMsg').textContent = '❌ VAD 下载失败：' + ((e && e.message) || e);
  } finally { btn.disabled = false; }
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
