/* 看一眼记忆系统的现状：ending.json 是什么、数组形状的那几个装了什么
 * 跑法：node app/scripts/inspect-memory.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.APPDATA, 'dayu-pet', 'memory');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

console.log('=== 记忆文件逐个看 ===');
for (const f of files) {
  const p = path.join(dir, f);
  const st = fs.statSync(p);
  const raw = fs.readFileSync(p, 'utf8');
  let shape = '?', extra = '';
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      shape = '数组';
      extra = j.length + ' 项' + (j[0] ? '，首项键: ' + Object.keys(j[0]).slice(0, 7).join(',') : '');
    } else if (j && typeof j === 'object') {
      shape = j.version === undefined ? '对象(★无版本)' : ('对象(v' + j.version + ')');
      extra = '键: ' + Object.keys(j).slice(0, 8).join(',');
    } else {
      shape = '标量';
      extra = JSON.stringify(j);
    }
  } catch (e) {
    shape = '★解析失败';
    extra = '原始长度 ' + raw.length + '  内容[' + raw.slice(0, 60) + ']';
  }
  console.log('  ' + f.padEnd(18) + ' ' + String(Math.round(st.size / 102.4) / 10 + 'KB').padStart(7) + '  ' + shape.padEnd(16) + extra);
}

/* ending.json 到底有没有代码在用 */
console.log('');
console.log('=== 谁在读写 ending 这个命名空间 ===');
const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..')];
let hits = 0;
function scan(d, depth) {
  if (depth > 3) return;
  let items = [];
  try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git') continue;
    const p = path.join(d, it.name);
    if (it.isDirectory()) { scan(p, depth + 1); continue; }
    if (!it.name.endsWith('.js')) continue;
    let s = '';
    try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
    s.split('\n').forEach((ln, i) => {
      if (/'ending'|"ending"|'ending\.json'/.test(ln)) {
        hits++;
        console.log('  ' + path.relative(path.join(__dirname, '..'), p) + ':' + (i + 1) + '  ' + ln.trim().slice(0, 100));
      }
    });
  }
}
for (const r of roots) scan(r, 0);
if (!hits) console.log('  （没有任何代码引用它 —— 是个孤儿文件）');
