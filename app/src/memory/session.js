/* 会话（原"短期记忆"）
 * 不再是一个"记忆层"，就是当前这轮对话本身。
 * 关键改动：后台防抖把草稿写到磁盘，断电/强杀不丢；
 *          下次启动把草稿恢复成"还没结束的会话"接着聊。
 */
const store = require('../store');
const bus = require('../bus');

const NS = 'session';
const MAX_DRAFT_MSGS = 300;   // 草稿最多留多少条，防文件无限大

let state = null;

function newId() { return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function blank() { return { id: newId(), startedAt: Date.now(), messages: [], resumed: false }; }
function ensure() { if (!state) state = blank(); return state; }

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!state) return;
  try {
    const msgs = state.messages.slice(-MAX_DRAFT_MSGS);
    store.write(NS, { id: state.id, startedAt: state.startedAt, savedAt: Date.now(), messages: msgs });
  } catch {}
}

/* 启动时恢复：有草稿 → 当成还没结束的会话继续；没有 → 开新会话 */
function restore() {
  const d = store.read(NS, null);
  if (d && Array.isArray(d.messages) && d.messages.length) {
    // 老草稿的 compact 是 'EN: ...'（看起来像正常回复，会把模型教坏）→ 就地改成历史标记
    for (const m of d.messages) {
      if (m && typeof m.compact === 'string' && /^EN\s*[:：]/.test(m.compact)) {
        m.compact = '(earlier reply, abridged) ' + m.compact.replace(/^EN\s*[:：]\s*/, '');
      }
    }
    state = { id: d.id || newId(), startedAt: d.startedAt || Date.now(), messages: d.messages, resumed: true };
    bus.emit('session:start', info());
    return state;
  }
  state = blank();
  bus.emit('session:start', info());
  return state;
}

function push(...msgs) {
  ensure();
  for (const m of msgs) if (m) state.messages.push(m);
  scheduleSave();
  return state;
}

function all() { return ensure().messages; }

/* 收尾成功后清空草稿，避免下次被当成未结束会话重复记账 */
function clear() { state = blank(); clearTimeout(saveTimer); store.write(NS, null); }

function info() {
  const s = ensure();
  return { id: s.id, startedAt: s.startedAt, count: s.messages.length, resumed: !!s.resumed };
}

module.exports = { restore, push, all, clear, info, saveNow, NS };
