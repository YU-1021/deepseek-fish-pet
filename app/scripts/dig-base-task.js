/* 从聊天记录里挖出"基建排班"那件事的上下文
 * node app\scripts\dig-base-task.js [--last=200]
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.env.APPDATA, 'dayu-pet', 'memory', 'chatlog.json');
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const all = j.entries || [];
const KEYS = /基建|排班|243|换班|干员|制造站|贸易站|发电站|会客|宿舍|控制中枢|办公|训练|加工|PRTS|排版|班次|无人机/i;
const hits = [];
for (let i = 0; i < all.length; i++) {
  const e = all[i];
  const t = String(e.en || '') + '\n' + String(e.zh || '');
  if (KEYS.test(t)) hits.push({ i, e });
}
console.log('=== 聊天记录共 ' + all.length + ' 条，命中"基建/排班"关键词 ' + hits.length + ' 条 ===');
console.log('');
if (!hits.length) { console.log('（没有命中 —— 那件事可能不在当前 chatlog 里）'); process.exit(0); }
/* 按命中位置切成若干"话题块"，每块打印前后各 2 条，便于看清上下文 */
const shown = new Set();
for (const h of hits) {
  for (let k = Math.max(0, h.i - 2); k <= Math.min(all.length - 1, h.i + 2); k++) {
    if (shown.has(k)) continue;
    shown.add(k);
  }
}
const idx = Array.from(shown).sort((a, b) => a - b);
let prev = -2;
for (const i of idx) {
  if (i !== prev + 1) console.log('  ────────');
  prev = i;
  const e = all[i];
  const who = e.who === 'me' ? '主人' : (e.who === 'pet' ? ' 她 ' : e.who);
  const en = String(e.en || '').replace(/\n/g, ' ').slice(0, 220);
  const zh = String(e.zh || '').replace(/\n/g, ' ').slice(0, 170);
  console.log('[' + String(i).padStart(3) + '] ' + who + ' ' + en);
  if (zh && zh !== en) console.log('       中 ' + zh);
}
