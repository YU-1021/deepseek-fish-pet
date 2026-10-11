/* 实时监视桌宠的数据流（纯 Node，不需要 electron）
 *
 *   node app\scripts\watch-live.js                 盯真实数据目录
 *   node app\scripts\watch-live.js --ud=dayu-pet-test
 *   node app\scripts\watch-live.js --all          连正常调用也逐条打印（默认只打关键+异常）
 *   node app\scripts\watch-live.js --since=0      从文件开头开始读（默认只看新产生的）
 *
 * 盯着什么（用户给桌宠派任务时要能看出异常）：
 *   · 报错（err 字段 / ev=err）
 *   · 慢调用（LLM > 3s、其它 > 1s）
 *   · 隐藏数值与好感/心情的**变化**（onBefore → after，带范围检查）
 *   · 记忆变化（事实晋升、日记、技能经验）
 *   · 可疑值：NaN / 越界 / 负耗时 / 空回复 / 该有的字段没有
 *   · 每 20 秒打一行汇总（各模块调用数、最慢的几次）
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const UD = path.join(process.env.APPDATA, arg('ud', 'dayu-pet'));
const FILE = path.join(UD, 'testlog.jsonl');
const ALL = argv.includes('--all');
const SINCE_START = argv.includes('--since=0');

const RANGE = { dependency: [0, 95], extraversion: [5, 95], emotionality: [5, 95], directness: [5, 95], iq: [20, 95], diligence: [20, 95], affection: [0, 100], mood: [0, 100] };

const counts = {};
const slow = [];
let nErr = 0, nTotal = 0, nWarn = 0;
const anomalies = [];

const ts = () => new Date().toTimeString().slice(0, 8);
const say = (s) => { try { process.stdout.write(s + '\n'); } catch {} };

function note(sev, key, why, detail) {
  const a = { t: ts(), sev, key, why, detail: String(detail == null ? '' : detail).slice(0, 160), at: Date.now() };
  anomalies.push(a);
  if (sev === 'err') nErr++; else nWarn++;
  say('  ' + (sev === 'err' ? '❌' : '⚠️ ') + ' [' + a.t + '] ' + key + '  ' + why + (a.detail ? '   ← ' + a.detail : ''));
}

function handle(e) {
  nTotal++;
  const key = e.mod + '.' + e.ev + (e.fn ? ':' + e.fn : '');
  counts[key] = (counts[key] || 0) + 1;

  /* ---- 1. 报错 ---- */
  if (e.err || e.ev === 'err') note('err', key, '报错', e.err || JSON.stringify(e).slice(0, 120));

  /* ---- 2. 慢调用 ---- */
  if (Number.isFinite(e.ms)) {
    const limit = /llm|vision|assistant\.run|projects\.run|tts/.test(key) ? 3000 : 1000;
    if (e.ms > limit) {
      slow.push({ key, ms: e.ms, t: ts() });
      note('warn', key, '慢 ' + e.ms + 'ms（阈值 ' + limit + '）', JSON.stringify(e.a0 || e.a1 || '').slice(0, 70));
    }
    if (e.ms < 0) note('warn', key, '负耗时 ' + e.ms + 'ms', '时钟被平移过？');
  }

  /* ---- 3. 数值变化（before → after）---- */
  if (e.before && e.r && typeof e.r === 'object') {
    const parts = [];
    for (const k of Object.keys(e.r)) {
      if (typeof e.r[k] !== 'number' || typeof e.before[k] !== 'number') continue;
      if (k === 'lastSeen' || k === 'lastJudge' || k === 'lastRegress') continue;
      const d = Math.round((e.r[k] - e.before[k]) * 100) / 100;
      if (!d) continue;
      parts.push(k + ' ' + e.before[k] + '→' + e.r[k] + '(' + (d > 0 ? '+' : '') + d + ')');
      const rg = RANGE[k];
      if (rg && (e.r[k] < rg[0] || e.r[k] > rg[1])) note('err', key, k + ' 越界到 ' + e.r[k] + '（应在 ' + rg[0] + '~' + rg[1] + '）');
      if (!Number.isFinite(e.r[k])) note('err', key, k + ' 变成 ' + e.r[k]);
    }
    if (parts.length) say('  📊 [' + ts() + '] ' + key + '  ' + parts.join('  '));
  }

  /* ---- 4. 记忆变化 ---- */
  if (/^bus\.memory/.test(key)) {
    const tag = e.ns || e.what || '';
    if (/permanent/.test(key) || /permanent/.test(String(tag))) {
      const n = e.facts != null ? e.facts : (e.n != null ? e.n : '');
      say('  🧠 [' + ts() + '] 永久记忆变化 ' + (n !== '' ? '(' + n + ' 条)' : '') + ' ' + JSON.stringify(e).slice(0, 100));
    }
  }

  /* ---- 5. LLM 回复质量 ---- */
  if (e.fn === 'parseReply' || /llm\.call/.test(key)) {
    const txt = String((e.r && e.r) || '');
    if (e.fn === 'parseReply' && e.r && typeof e.r === 'object' && !e.r.en && !e.r.zh) {
      note('warn', key, '模型回复里既没有 EN 也没有 ZH', JSON.stringify(e.r).slice(0, 100));
    }
  }

  /* ---- 6. 关键事件按需打印 ---- */
  const interesting = /^(bus\.|llm\.|assistant\.|skills\.|projects\.|tts\.|asr\.|speak\.|memory\.(onSessionEnd|onAppStart|judgeStatsNow))/.test(key)
    || /error|fail|retry/i.test(key);
  if (interesting && !/call$/.test(key) && !e.before) {
    const brief = e.v || e.reason || e.tool || e.tier || e.r || '';
    say('  • [' + ts() + '] ' + key + (e.ms ? '  ' + e.ms + 'ms' : '') + (brief ? '  ' + String(typeof brief === 'object' ? JSON.stringify(brief) : brief).slice(0, 110) : ''));
  } else if (ALL) {
    say('    [' + ts() + '] ' + key + (e.ms ? '  ' + e.ms + 'ms' : ''));
  }
}

function summary() {
  say('');
  say('  ── 汇总 [' + ts() + '] 共 ' + nTotal + ' 条  报错 ' + nErr + '  警告 ' + nWarn + ' ──');
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  say('     调用最多: ' + top.map(([k, v]) => k + '×' + v).join('  '));
  if (slow.length) {
    say('     最慢: ' + slow.sort((a, b) => b.ms - a.ms).slice(0, 5).map((s) => s.key + ' ' + s.ms + 'ms').join('  '));
  }
  say('');
}

if (!fs.existsSync(FILE)) { say('找不到 ' + FILE + '（应用可能还没写过日志）'); process.exit(1); }
let pos = SINCE_START ? 0 : fs.statSync(FILE).size;
say('=== 监视中：' + FILE + ' ===');
say('  （只显示关键事件与异常；--all 可以看全部。每 20 秒打一次汇总）');
let buf = '';
setInterval(() => {
  try {
    const st = fs.statSync(FILE);
    if (st.size < pos) { pos = 0; say('  （日志被轮转了，从头读）'); }   // 轮转
    if (st.size === pos) return;
    const fd = fs.openSync(FILE, 'r');
    const len = st.size - pos;
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, pos);
    fs.closeSync(fd);
    pos = st.size;
    buf += b.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { handle(JSON.parse(ln)); } catch {}
    }
  } catch {}
}, 400);
setInterval(summary, 20000);

process.on('SIGINT', () => { summary(); say('  异常清单:'); for (const a of anomalies) say('    ' + a.sev + ' ' + a.at + ' ' + a.key + ' ' + a.why + ' ' + a.detail); process.exit(0); });
