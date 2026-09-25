/* 本会话的"看得见的聊天记录"
 *
 * 为什么要单独存一份：聊天窗最小化/关掉再打开时，DOM 里的消息就没了，
 * 主人回头想看"刚才说了什么"就看不到了。这里把每条消息落盘，
 * 聊天窗一打开就把它渲染回去；跟会话（session）绑定，换会话就清空。
 *
 * 只存展示需要的字段，不存 LLM 的原始消息。
 */
const store = require('./store');

const NS = 'chatlog';
const MAX = 400;

let state = null;

function blank(sessionId) { return { sessionId: sessionId || '', entries: [] }; }

function load() {
  if (!state) {
    const d = store.read(NS, null);
    state = (d && Array.isArray(d.entries)) ? { sessionId: d.sessionId || '', entries: d.entries } : blank('');
  }
  return state;
}

function write() {
  try {
    if (state.entries.length > MAX) state.entries = state.entries.slice(-MAX);
    store.write(NS, { sessionId: state.sessionId, entries: state.entries });
  } catch {}
}

/* 换会话（结束本次会话 / 重启后开了新会话）→ 记录清空重来 */
function sync(sessionId) {
  const s = load();
  if (sessionId && s.sessionId !== sessionId) {
    state = blank(sessionId);
    write();
  }
  return state;
}

function all(sessionId) {
  const s = sync(sessionId);
  return { sessionId: s.sessionId, entries: s.entries };
}

function add(sessionId, entry) {
  const s = sync(sessionId);
  if (!entry) return false;
  s.entries.push({ ...entry, at: Date.now() });
  write();
  return true;
}

function clear(sessionId) { state = blank(sessionId || ''); write(); }

module.exports = { all, add, clear, NS };
