/* 会话（原"短期记忆"）
 * 不再是一个"记忆层"，就是当前这轮对话本身。
 * 关键改动：后台防抖把草稿写到磁盘，断电/强杀不丢；
 *          下次启动把草稿恢复成"还没结束的会话"接着聊。
 */
const store = require('../store');
const bus = require('../bus');
const fmt = require('../sessionfmt');
const surf = require('../surface');

const NS = 'session';
const MAX_DRAFT_MSGS = 300;   // 草稿最多留多少条，防文件无限大

let state = null;
let surface = null;          // 只追加的事件日志（真相）。投影 = 模型看到的东西，由它算出来。
/* 磁盘上那个会话文件的版本比本程序还新 → 拒绝加载。此时**绝不能写盘**：
   否则会用空会话覆盖掉用户那个"更高版本"的文件，而那是不可逆的数据丢失。
   （照 DSH dsh-session-format:134 的语义：旧程序不猜新格式。） */
let readOnly = false;

function newId() { return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function blank() { return { id: newId(), startedAt: Date.now(), resumed: false, migratedFrom: null }; }
function ensure() {
  if (!state) state = blank();
  if (!surface) surface = surf.create();
  return state;
}

/* 把事件日志投影成"模型/界面看到的消息"，形状和以前完全一样（{role, content|compact}），
   所以 context.js 的 pickHistory、以及界面都不用改。 */
function all() {
  ensure();
  return surface.project().map((n) => {
    const m = { role: n.role };
    if (n.compact != null) m.compact = n.compact; else m.content = n.content == null ? '' : n.content;
    return m;
  });
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!state) return;
  if (readOnly) return;          // 见上面 readOnly 的说明：拒绝加载期间一律不写
  try {
    /* v2：存**事件日志**（真相），不再存"当时看到的东西"。
       只追加、永不改写 —— 于是任何时候都能重算"她当时看到了什么"。 */
    let evs = surface ? surface.events() : [];
    if (evs.length > MAX_DRAFT_MSGS) evs = evs.slice(-MAX_DRAFT_MSGS);
    store.write(NS, fmt.wrap({ id: state.id, startedAt: state.startedAt, savedAt: Date.now(), events: evs }));
  } catch {}
}

/* 启动时恢复：有草稿 → 当成还没结束的会话继续；没有 → 开新会话。
 * 读出来的数据**先过迁移**（老格式 → 当前格式），迁移失败就拒绝加载并保护原文件。 */
function restore() {
  const d = store.read(NS, null);
  if (d != null) {
    const m = fmt.migrate(d);
    if (!m.ok) {
      /* 迁移不了（例如文件是更高版本写的）→ 开新会话，但**只读**，绝不覆盖原文件 */
      readOnly = true;
      try { console.error('[session] 拒绝加载会话草稿：' + m.error); } catch {}
      state = blank();
      surface = surf.create();
      bus.emit('session:start', info());
      return state;
    }
    const v = m.data;
    /* v2：把事件重放进一个新的 surface（可回放 —— 这也是 surface 的测试 §3 验证过的性质） */
    const evs = (v && Array.isArray(v.events)) ? v.events : [];
    surface = surf.create();
    for (const e of evs) surface.append(e);
    const vis = all();
    if (vis.length) {
      state = { id: v.id || newId(), startedAt: v.startedAt || Date.now(), resumed: true, migratedFrom: m.migrated ? m.from : null };
      /* 迁移过就立刻用新格式写回一次（别等下次保存，免得中途崩了又回到老格式） */
      if (m.migrated) saveNow();
      bus.emit('session:start', info());
      return state;
    }
  }
  state = blank();
  surface = surf.create();
  bus.emit('session:start', info());
  return state;
}

function push(...msgs) {
  ensure();
  for (const m of msgs) {
    if (!m) continue;
    /* 只追加（绝不改写已有事件）—— 存的是事件，投影按需算 */
    const e = { kind: 'msg', role: m.role || 'user' };
    if (m.compact != null) e.compact = m.compact; else e.content = m.content == null ? '' : m.content;
    if (m.tool) e.tool = m.tool;
    surface.append(e);
  }
  scheduleSave();
  return state;
}

/* 剪枝：把太长的历史条目折叠成摘要节点（**追加一条替代事件**，原文仍在日志里）
   —— 照 DSH dsh-compaction-tool-result-pruner。返回剪了几条。 */
function pruneLong(extra) {
  ensure();
  const r = surface.pruneAll(extra);
  if (r.count) scheduleSave();
  return r;
}

function stats() {
  ensure();
  return { session: info(), surface: surface.stats() };
}

/* 收尾成功后清空草稿，避免下次被当成未结束会话重复记账 */
function clear() { state = blank(); surface = surf.create(); clearTimeout(saveTimer); if (!readOnly) store.write(NS, null); }

function info() {
  const s = ensure();
  const cnt = surface ? surface.project().length : 0;
  return {
    id: s.id, startedAt: s.startedAt, count: cnt, resumed: !!s.resumed,
    readOnly: readOnly, migratedFrom: s.migratedFrom == null ? null : s.migratedFrom,
    version: fmt.CURRENT,
    events: surface ? surface.events().length : 0,
  };
}

module.exports = { restore, push, all, clear, info, saveNow, pruneLong, stats, NS };
