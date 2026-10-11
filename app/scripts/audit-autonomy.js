/* 从聊天记录里找「她把问题推给用户」的证据
 * node app\scripts\audit-autonomy.js [--last=60]
 *
 * 用户反馈："感觉桌宠自主思考能力有点差，每次遇到一些简单问题问我解决，问得有点多"
 * 这个脚本把她的发言按"有没有把球踢回给主人"分类，给出具体例子和比例。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? Number(m.split('=')[1]) : d; };
const FILE = path.join(process.env.APPDATA, 'dayu-pet', 'memory', 'chatlog.json');
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const entries = (j.entries || []).filter((e) => e.who === 'pet');
const N = arg('last', 80);
const recent = entries.slice(-N);

/* 把球踢给主人的典型句式（中英都算，因为她的 en/zh 两版内容一样） */
const HANDOFF = [
  /你自己.*(试|点|弄|看|决定|选)/, /你(要|想)不(要|想)/, /要不你/, /你来(试|点|弄|决定)/,
  /(请|麻烦)你/, /帮我(看|点|弄|试|确认|决定)/, /需要你/, /得靠你/, /你来决定/, /你告诉我/,
  /你觉得(呢|怎么样)/, /你想(怎么|要)/, /要(不要|不)我/, /可以吗[?？]?$/, /怎么样[?？]?$/,
  /you (should|need to|have to|might want to|decide|tell me|let me know)/i, /can you/i,
  /should I/i, /do you want/i, /your call/i, /up to you/i, /let me know/i, /want me to/i,
];
/* "给方案 + 让主人选" 也算半推（不是自己判断哪个最好） */
const SOFT = [/或者/, /要么.*要么/, /二选一/, /or\b.*\bor\b/i, /either/i, /option/i];

/* 她"自己动手"的证据：给出 ACTION / 说已执行 / 给出结论 */
const ACTED = [/ACTION:|已(点击|滚动|输入|执行|打开|读取|写入|删除|移动)/, /我(自己|来)(试|点|看|查|改|跑)/,
  /(查到|找到了|结果是|实测|试过了|已经(修|改|弄)好)/, /done\.|I (tried|checked|ran|clicked)/i];

let handoff = 0, soft = 0, acted = 0, pure = [];
const rows = [];
for (const e of recent) {
  const t = String(e.en || '') + '\n' + String(e.zh || '');
  const h = HANDOFF.some((r) => r.test(t));
  const s = SOFT.some((r) => r.test(t));
  const a = ACTED.some((r) => r.test(t));
  if (h) handoff++;
  if (s) soft++;
  if (a) acted++;
  if (h && !a) pure.push({ at: e.at, en: String(e.en || '').slice(0, 150), zh: String(e.zh || '').slice(0, 110) });
  rows.push({ h, s, a });
}

console.log('=== 最近 ' + recent.length + ' 条她的发言 ===');
console.log('  把球踢给主人（出现请你/你自己/你来决定/要你…这类句式）: ' + handoff + ' 条  (' + Math.round(handoff / recent.length * 100) + '%)');
console.log('  给多个方案让主人挑（或者/要么/二选一）              : ' + soft + ' 条  (' + Math.round(soft / recent.length * 100) + '%)');
console.log('  有自己动手的痕迹（给 ACTION / 说已执行 / 给了结论）  : ' + acted + ' 条  (' + Math.round(acted / recent.length * 100) + '%)');
console.log('  ★ 既踢球又没动手（最该改的）                        : ' + pure.length + ' 条');
console.log('');
console.log('=== 「踢球且没动手」的原文（最多 12 条）===');
for (const p of pure.slice(-12)) {
  const t = p.at ? new Date(p.at).toTimeString().slice(0, 8) : '';
  console.log('[' + t + '] ' + p.en.replace(/\n/g, ' '));
  if (p.zh) console.log('        中: ' + p.zh.replace(/\n/g, ' '));
}
console.log('');
console.log('=== 抽样：她"自己动手了"的发言（做对照）===');
const good = recent.filter((e, i) => rows[i].a && !rows[i].h).slice(-5);
for (const g of good) console.log('  + ' + String(g.en || '').replace(/\n/g, ' ').slice(0, 130));
