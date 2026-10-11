/* 测试日志审计器 —— 汇总所有测试目录的 testlog.jsonl，按规则挑出可疑数据
 *
 * 纯 Node，不依赖 electron：直接用 node app\scripts\audit-logs.js 跑。
 * 用法：
 *   node app\scripts\audit-logs.js            审计全部测试目录
 *   node app\scripts\audit-logs.js --real     连真实数据目录一起审
 *   node app\scripts\audit-logs.js --min=3    只列出现 >=3 次的组
 *   node app\scripts\audit-logs.js --since=2h 只看最近 2 小时（默认全部）
 *
 * ⚠️ 为什么需要 --since：日志是**只追加**的，修好的旧错误会一直留在里面，
 *   不按时间筛的话"高严重度"里永远挂着已经修掉的旧账（第一次审就踩到了）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const WITH_REAL = argv.includes('--real');
const MIN = Number((argv.find((a) => a.startsWith('--min=')) || '--min=2').split('=')[1]) || 2;
const SINCE = (argv.find((a) => a.startsWith('--since=')) || '').split('=')[1] || '';
const sinceMs = (() => {
  const m = String(SINCE).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] || 'm'] || 60000;
  return n * unit;
})();
const CUT = sinceMs ? Date.now() - sinceMs : 0;
/* 未来时间戳一律丢弃：修好 t 字段之前写下的旧条目带 +1~2 天偏移、看起来落在未来，
   而"只排除过去"的过滤**恰好放它们进来** —— 实测那条假的 24 小时 TTS 耗时就是这么
   在 --since 里阴魂不散的。日志不可能来自未来，超过 5 分钟余量就说明是脏数据。 */
const FUTURE = Date.now() + 5 * 60000;

const ROOT = path.join(process.env.APPDATA);
const DIRS = fs.readdirSync(ROOT).filter((d) => /^dayu-pet/.test(d))
  .filter((d) => WITH_REAL || d !== 'dayu-pet')
  .map((d) => path.join(ROOT, d, 'testlog.jsonl'))
  .filter((f) => fs.existsSync(f));

if (!DIRS.length) { console.log('没找到 testlog.jsonl（先跑一次测试）'); process.exit(0); }

const groups = {};      // key -> {n, errs, ms[], fields{}, dirs:Set, samples[]}
let total = 0;
let futureSkipped = 0;
const sources = [];
for (const f of DIRS) {
  const dir = path.basename(path.dirname(f));
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  sources.push({ dir, lines: lines.length, kb: Math.round(fs.statSync(f).size / 1024) });
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (CUT && Number(e.t) < CUT) continue;      // --since 过滤：别让旧账盖住新问题
    if (Number(e.t) > FUTURE) { futureSkipped++; continue; }   // 脏的未来时间戳（旧格式）
    total++;
    const k = e.mod + '.' + e.ev + (e.fn ? ':' + e.fn : '');
    const g = groups[k] || (groups[k] = { n: 0, errs: 0, ms: [], fields: {}, dirs: new Set(), errSamples: [] });
    g.n++; g.dirs.add(dir);
    if (e.err) { g.errs++; if (g.errSamples.length < 3) g.errSamples.push(String(e.err).slice(0, 140)); }
    if (Number.isFinite(e.ms)) g.ms.push(e.ms);
    for (const [f2, v] of Object.entries(e)) {
      if (typeof v !== 'number' || f2 === 'ms' || f2 === 't' || f2 === 'i') continue;
      const s = g.fields[f2] || (g.fields[f2] = { min: Infinity, max: -Infinity, sum: 0, n: 0, zeros: 0 });
      s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.n++;
      if (v === 0) s.zeros++;
    }
  }
}

const round = (x) => Math.round(x * 100) / 100;
const rows = Object.entries(groups).map(([k, g]) => {
  const fields = {};
  for (const [name, s] of Object.entries(g.fields)) {
    fields[name] = { min: round(s.min), max: round(s.max), avg: round(s.sum / s.n), zeros: s.zeros, n: s.n };
  }
  const ms = g.ms.length ? { min: Math.min(...g.ms), max: Math.max(...g.ms), avg: round(g.ms.reduce((a, b) => a + b, 0) / g.ms.length), n: g.ms.length } : null;
  return { key: k, n: g.n, errs: g.errs, errSamples: g.errSamples, ms, fields, dirs: [...g.dirs] };
});

console.log('================ 日志审计 ================');
console.log('  来源: ' + sources.map((s) => s.dir + '(' + s.lines + '行/' + s.kb + 'KB)').join('  '));
console.log('  总条目 ' + total + '　分组 ' + rows.length + '　过滤: 出现次数 >= ' + MIN + (SINCE ? '　时间窗: 最近 ' + SINCE : '')
  + (futureSkipped ? '　丢弃未来时间戳 ' + futureSkipped + ' 条（旧格式脏数据）' : ''));
console.log('');

/* ---------- 异常规则 ---------- */
const anomalies = [];
for (const r of rows) {
  if (r.n < MIN) continue;
  if (r.errs > 0) anomalies.push({ sev: '高', key: r.key, why: r.errs + '/' + r.n + ' 次报错', detail: r.errSamples.join(' | ') });
  if (r.ms && r.ms.max > 30000) anomalies.push({ sev: '中', key: r.key, why: '单次耗时 ' + r.ms.max + 'ms（>30s）', detail: 'avg=' + r.ms.avg + 'ms n=' + r.ms.n });
  for (const [name, s] of Object.entries(r.fields)) {
    if (s.n >= 3 && s.min < 0 && !/delta|diff|offset|adjust/.test(name)) {
      anomalies.push({ sev: '中', key: r.key + '.' + name, why: '出现负值 min=' + s.min, detail: 'max=' + s.max });
    }
    if (s.n >= 5 && s.min > 0 && s.max / Math.max(1e-9, s.min) > 1000) {
      anomalies.push({ sev: '低', key: r.key + '.' + name, why: '量级跨度 ' + s.min + ' ~ ' + s.max + '（比值 >1000）', detail: 'avg=' + s.avg });
    }
    if (s.zeros > 0 && s.zeros === s.n) {
      anomalies.push({ sev: '低', key: r.key + '.' + name, why: '这项在所有 ' + s.n + ' 次里恒为 0', detail: '可能是字段没填/没生效' });
    }
  }
  /* 应该带耗时的函数却没带 */
  if (/^llm\.|^asr\.|^tts\.|^assistant\.run|^projects\.run/.test(r.key) && !r.ms) {
    anomalies.push({ sev: '低', key: r.key, why: '没有耗时数据（可能没走到计时分支）', detail: 'n=' + r.n });
  }
}

/* ---------- 输出 ---------- */
console.log('--- 异常清单（按严重度）---');
if (!anomalies.length) console.log('  （没发现）');
const order = { 高: 0, 中: 1, 低: 2 };
anomalies.sort((a, b) => order[a.sev] - order[b.sev]);
for (const a of anomalies) console.log('  [' + a.sev + '] ' + a.key.padEnd(34) + ' ' + a.why + (a.detail ? '  ← ' + a.detail : ''));

console.log('');
console.log('--- 分组明细（次数降序，前 30）---');
console.log('  ' + '组'.padEnd(36) + '次数'.padStart(5) + '错误'.padStart(5) + '  耗时(min~max/avg)      关键数值');
for (const r of rows.filter((x) => x.n >= MIN).sort((a, b) => b.n - a.n).slice(0, 30)) {
  const ms = r.ms ? (r.ms.min + '~' + r.ms.max + '/' + r.ms.avg + 'ms').padEnd(22) : ''.padEnd(22);
  const f = Object.entries(r.fields)
    .filter(([k]) => !/^a\d|^v$|^in$|^en$|^zh$/.test(k))
    .slice(0, 3).map(([k, s]) => k + '[' + s.min + '~' + s.max + ']').join(' ');
  console.log('  ' + r.key.padEnd(36) + String(r.n).padStart(5) + String(r.errs || '').padStart(5) + '  ' + ms + ' ' + f);
}

/* ---------- 状态变化轨迹（有记 before 的那些）----------
 * 为什么单列一块：像 mood.startupDecay() 这种"没参数、按离线时长扣分"的函数，
 * 光看结果永远是 `mood=0`，看不出"从多少扣到多少"；有了 before 才能一眼看出
 * "这次启动因为离线 18 小时被扣了 30 点"。 */
const changes = [];
for (const f of DIRS) {
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (CUT && Number(e.t) < CUT) continue;
    if (Number(e.t) > FUTURE) continue;
    if (!e.before) continue;
    changes.push({ t: e.t, key: e.mod + '.' + e.fn, before: e.before, after: e.r, arg: e.a0, err: e.err });
  }
}
if (changes.length) {
  console.log('');
  console.log('--- 状态变化轨迹（before → after，最近 12 条）---');
  for (const c of changes.slice(-12)) {
    const ts = new Date(c.t).toLocaleTimeString('zh-CN', { hour12: false });
    const b = JSON.stringify(c.before), a = JSON.stringify(c.after);
    console.log('  ' + ts + '  ' + c.key.padEnd(26) + b + '  →  ' + a + (c.arg ? '   请求=' + JSON.stringify(c.arg) : ''));
  }
}

/* ---------- 可疑：非数字字段里的异常 ---------- */
console.log('');
console.log('--- 事件型事件计数（bus / dbg 前缀分布）---');
const busRows = rows.filter((r) => r.key.startsWith('bus.') || r.key.endsWith('.dbg'));
for (const r of busRows.sort((a, b) => b.n - a.n).slice(0, 14)) console.log('  ' + r.key.padEnd(40) + r.n);
