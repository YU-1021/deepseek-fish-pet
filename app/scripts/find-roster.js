// 翻她的记忆 + 聊天记录，找"243 排班表"和干员名单
const fs = require('fs'), path = require('path');
const D = path.join(process.env.APPDATA, 'dayu-pet');
const hits = [];
function scan(label, file, filter) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    const walk = (o, p) => {
      if (o == null) return;
      if (typeof o === 'string') {
        if (filter(o)) hits.push({ label: label + p, text: o.slice(0, 300) });
        return;
      }
      if (Array.isArray(o)) return o.forEach((v, i) => walk(v, p + '[' + i + ']'));
      if (typeof o === 'object') return Object.keys(o).forEach((k) => walk(o[k], p + '.' + k));
    };
    walk(j, '');
  } catch (e) { hits.push({ label: label, text: '(读取失败: ' + e.message + ')' }); }
}
const KEYS = /243|排班|换班|基建|进驻|制造站|贸易站|发电站|控制中枢|会务|会客/;
for (const f of ['memory/permanent.json', 'memory/long.json', 'memory/medium.json', 'memory/skillmem.json', 'memory/ending.json']) {
  scan(f, path.join(D, f), (s) => KEYS.test(s));
}
console.log('=== 记忆里命中"基建/排班"的内容 ===');
if (!hits.length) console.log('  （记忆里没有）');
for (const h of hits.slice(0, 20)) console.log('  [' + h.label + '] ' + h.text.replace(/\s+/g, ' '));

// chatlog 里找提到干员名/排班表的回合
const j = JSON.parse(fs.readFileSync(path.join(D, 'memory', 'chatlog.json'), 'utf8'));
const e = j.entries || [];
const OP = /澄闪|令|夕|艾雅法拉|史尔特尔|阿米娅|妮芙|结城理|能天使|银灰|德克萨斯|拉普兰德|推进之王|闪灵|夜莺|华法琳|白面鸮|巫恋|琴柳|棘刺|史都华德|卡达|斑点|芬|克洛丝|米格鲁|杜林|安赛尔|芙蓉|炎熔|黑角|夜刀|castle|12F|Lancet|Fang|Kroos|Beagle|Durin|Ansel|Hibiscus|Lava|Noir|Yato/i;
console.log('');
console.log('=== 聊天记录里提到干员名或排班表的回合（最近 25 条）===');
const out = [];
for (let i = 0; i < e.length; i++) {
  const x = e[i];
  const t = String(x.en || '') + ' ' + String(x.zh || '') + ' ' + String(x.text || '');
  if (OP.test(t) || /排班表|243方案|shift table|243 plan/i.test(t)) {
    out.push('[' + (x.who || '?') + '] ' + t.replace(/\s+/g, ' ').slice(0, 220));
  }
}
console.log(out.slice(-25).map((s) => '  ' + s).join('\n') || '  （没有）');
