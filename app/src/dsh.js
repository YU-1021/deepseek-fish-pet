// DSH 会话联动：读取 DSH 的会话记录（zstd 多帧 JSONL），推断当前状态
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESS = path.join(HOME, '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function findLatest() {
  let best = null;
  try {
    for (const ws of fs.readdirSync(SESS)) {
      const dir = path.join(SESS, ws);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        const f = path.join(dir, e, 'session.v3.jsonl.zstd');
        try {
          const st = fs.statSync(f);
          if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
        } catch {}
      }
    }
  } catch {}
  return best;
}

function tailRecords(file, want) {
  const buf = fs.readFileSync(file);
  const pos = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { pos.push(i); i += 4; }
  const recs = [];
  for (let k = Math.max(0, pos.length - want - 1); k < pos.length; k++) {
    const start = pos[k];
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try {
      const txt = zlib.zstdDecompressSync(buf.slice(start, end)).toString('utf8');
      for (const l of txt.split(/\r?\n/)) if (l.trim()) recs.push(l);
    } catch {}
  }
  return recs;
}

function state() {
  const latest = findLatest();
  if (!latest) return { ok: false, state: 'none', active: false, tool: '' };
  let last = null;
  for (const l of tailRecords(latest.file, 5)) { try { last = JSON.parse(l); } catch {} }
  if (!last) return { ok: false, state: 'none', active: false, tool: '' };

  const agoMs = Date.now() - latest.mtimeMs;
  const active = agoMs < 15000;

  let st = 'idle';
  if (last.type === 'tool/call') st = 'working';
  else if (last.type === 'tool/result' || last.type === 'step/start' || last.type === 'step/end' || last.type === 'assistant/message') st = 'thinking';

  /* 工具名在 data.name 里，不在顶层：实测 session.v3 的 tool/call 记录顶层键只有
     type / seq / time / data，以前读 last.name 恒为 undefined → "DSH · 工具名" 永远空白。 */
  const tool = (last.data && last.data.name) || last.name || '';
  return { ok: true, state: st, active, tool, agoMs };
}

module.exports = { state };
