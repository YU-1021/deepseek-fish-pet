/* probe-stoplog-min.js —— 快速验证"停止原因真的进了**会话日志**"（补回 session.mark 之后）
   跑法：cd app && electron.exe --no-sandbox scripts\probe-stoplog-min.js
   ⚠️ userData 放工作区里（本会话沙箱不许写 %APPDATA%）；不开可见窗口；跑完 exit */
'use strict';
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TMP = 'C:/deepseek/tmp-stoplast';
fs.mkdirSync(TMP, { recursive: true });
try { fs.rmSync(path.join(TMP, 'memory'), { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', TMP);
const L = (s) => { try { process.stdout.write(s + '\n'); } catch (e) {} };

app.whenReady().then(() => {
  const session = require('../src/memory/session');
  const stoplog = require('../src/stoplog');
  session.restore();
  session.push({ role: 'user', content: '（探针）' });
  const known = stoplog.KNOWN || [];
  L('stoplog.KNOWN = ' + known.join('/'));
  const r = stoplog.noteStop({ stopReason: 'look-streak', ok: false, steps: 3 });
  session.saveNow();
  const p = path.join(TMP, 'memory', 'session.json');
  const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  const ev = j && (j.events || []).find((e) => e.kind === 'stop' && e.reason === 'look-streak');
  L('noteStop → ' + JSON.stringify(r));
  L('会话日志事件 → ' + JSON.stringify(ev));
  L('模型投影里有没有它 → ' + JSON.stringify(session.all().map((m) => String(m.content || '').slice(0, 10))));
  const good = !!(ev && ev.reason === 'look-streak') && session.all().length === 1;
  L(good ? '通过：会话日志里能查到 stop reason，且不进模型投影 ✓' : '失败 ✗');
  process.exit(good ? 0 : 1);
});
