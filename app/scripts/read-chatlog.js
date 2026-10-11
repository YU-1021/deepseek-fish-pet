// 读最近的聊天记录（看她的回复）
const fs = require('fs'), path = require('path');
const f = path.join(process.env.APPDATA, 'dayu-pet', 'memory', 'chatlog.json');
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
const e = j.entries || [];
console.log('total entries: ' + e.length);
console.log('--- last 12 ---');
for (const x of e.slice(-12)) {
  const t = x.at ? new Date(x.at).toTimeString().slice(0, 8) : '';
  const en = String(x.en || x.text || '').replace(/\n/g, ' ').slice(0, 150);
  const zh = String(x.zh || '').replace(/\n/g, ' ').slice(0, 110);
  console.log('[' + t + '] ' + (x.who || '?') + ': ' + en);
  if (zh && zh !== en) console.log('        中: ' + zh);
}
