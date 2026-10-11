/* 看她这一轮的工具回执原文（从会话事件日志里挖）
 * v2 之后历史是只追加的事件日志 —— 正好用得上：能精确回放"她当时到底看到了什么"。
 * 跑法：node app/scripts/peek-session.js [关键词]
 */
const fs = require('fs');
const path = require('path');

const kw = process.argv[2] || '';
const p = path.join(process.env.APPDATA, 'dayu-pet', 'memory', 'session.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const evs = Array.isArray(j.events) ? j.events : [];
console.log('会话 v' + j.version + '，事件 ' + evs.length + ' 条；关键词「' + kw + '」');
console.log('');

/* 只追加的事件日志：从后往前找最近的相关事件 */
const hits = [];
for (let i = evs.length - 1; i >= 0 && hits.length < 12; i--) {
  const e = evs[i];
  const text = String(e.content != null ? e.content : (e.compact != null ? e.compact : ''));
  if (kw && text.indexOf(kw) < 0) continue;
  hits.push({ i, role: e.role, kind: e.kind, tool: e.tool, text });
}
hits.reverse();
for (const h of hits) {
  console.log('  ── #' + (h.i + 1) + ' [' + (h.role || h.kind || '?') + (h.tool ? ' ' + h.tool : '') + '] ──');
  const t = h.text.replace(/\n/g, '\n     ');
  console.log('     ' + t.slice(0, 900));
  console.log('');
}
