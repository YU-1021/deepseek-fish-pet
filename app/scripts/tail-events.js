// 看她最近每一步：调用了什么工具、参数、结果、耗时
const fs = require('fs'), path = require('path');
const f = path.join(process.env.APPDATA, 'dayu-pet', 'testlog.jsonl');
const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const tail = lines.slice(-400);
const out = [];
for (const ln of tail) {
  let e; try { e = JSON.parse(ln); } catch { continue; }
  const key = (e.mod || '') + '.' + (e.ev || '') + (e.fn ? ':' + e.fn : '');
  if (/llm\.call:(request|stream)|assistant\.call:run|assistant\.err|assistant\.call:allowed|screenstream|vision\.call|projects\.call|tts\.call/.test(key)) {
    const r = String(JSON.stringify(e.r || e.a1 || e.err || '')).slice(0, 260);
    out.push('[' + key + ']' + (e.ms ? ' ' + e.ms + 'ms' : '') + ' ' + r);
  }
}
console.log('=== last ' + Math.min(out.length, 34) + ' relevant events ===');
for (const l of out.slice(-34)) console.log('  ' + l);
