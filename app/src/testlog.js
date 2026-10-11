/* 结构化测试日志 + 自动埋点
 *
 * 为什么自动埋点：手动往 25 个模块里插日志，改动面大、还必然漏。
 * 这里在启动时对指定模块的**导出函数**做一层包装，自动记录
 *   { 模块, 函数, 耗时, 参数摘要, 结果摘要, 错误 }
 * 再加上手工埋点入口 log(mod, ev, data) 用于记录"函数之外的语义事件"。
 *
 * 输出：%APPDATA%/dayu-pet/testlog.jsonl（一行一条 JSON，方便直接聚合）
 *
 * ⚠️ 两条硬性约束：
 *   1. **绝不落盘敏感信息** —— apiKey / token / 密码一律打码（这个项目已经被泄露过一次了）
 *   2. **包装层绝不能改变行为** —— 任何内部异常都吞掉，原函数照常执行；不改返回值、不改 this
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_BYTES = 24 * 1024 * 1024;      // 超过就轮转一次，避免无限增长
const MAX_STR = 600;                     // 单个字符串字段的落盘上限
const file = () => path.join(app.getPath('userData'), 'testlog.jsonl');

let seq = 0;
let disabled = false;

/* ---------------- 打码 ---------------- */
const SECRET_RE = /sk-[A-Za-z0-9_-]{6,}/g;
const SECRET_KEYS = /^(api_?key|vision_?key|password|passwd|secret|token|authorization)$/i;
function redact(v, depth) {
  depth = depth || 0;
  if (v == null) return v;
  if (typeof v === 'string') {
    const s = v.length > MAX_STR ? v.slice(0, MAX_STR) + '…(' + v.length + '字)' : v;
    return s.replace(SECRET_RE, (m) => 'sk-' + '*'.repeat(Math.max(4, m.length - 3)));
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'function') return '[fn]';
  if (depth > 2) return Array.isArray(v) ? '[' + v.length + '项]' : '[对象]';
  if (Array.isArray(v)) return v.slice(0, 6).map((x) => redact(x, depth + 1)).concat(v.length > 6 ? ['…共' + v.length + '项'] : []);
  if (typeof v === 'object') {
    const o = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ > 12) { o['…'] = '还有更多字段'; break; }
      o[k] = SECRET_KEYS.test(k) ? (v[k] ? '[已打码]' : '') : redact(v[k], depth + 1);
    }
    return o;
  }
  return String(v);
}

/* ---------------- 写盘 ---------------- */
function rotateIfNeeded() {
  try {
    const st = fs.statSync(file());
    if (st.size > MAX_BYTES) fs.renameSync(file(), file() + '.1');
  } catch {}
}
let rotateChecked = 0;
function log(mod, ev, data) {
  if (disabled) return;
  try {
    rotateChecked++;
    if (rotateChecked % 500 === 1) rotateIfNeeded();
    /* t  = **真实墙钟**：new Date() 不带参数走的是系统时钟，**不受 clock.js 劫持 Date.now() 影响**。
     *      日志必须按真实时间排，否则跨天测试里写下的条目会带上 +1~2 天的偏移、
     *      看起来落在"未来"，按时间窗审计（audit-logs.js --since）就完全筛不动 —— 实测踩到过。
     * td = 应用内时间（测试里可能被平移），用来和 t 对照，平时两者相等。 */
    const line = JSON.stringify(Object.assign({
      t: new Date().getTime(), td: Date.now(), i: ++seq, mod: String(mod), ev: String(ev),
    }, redact(data || {})));
    fs.appendFileSync(file(), line + '\n');
  } catch { disabled = true; }        // 日志坏了不影响主流程
}

/* 耗时用**单调时钟** performance.now()，不用 Date.now()。
 * 原因：clock.js 会劫持 Date.now() 来实现"跨天测试不改系统时间"，
 * 于是"开始记 t0 → 期间时钟平移了 1 天 → 结束算差"就会得出 86401541ms 这种
 * 24 小时的假耗时（审计日志时真的抓到了这条，一度以为 TTS 卡死）。
 * performance.now() 不受影响，且本来就是测耗时的正确工具。 */
const mono = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ---------------- 自动埋点 ----------------
 * opts.skip: 跳过的函数名数组（高频且无信息量的，比如 tokens.est）
 * opts.summary: { fnName: (args, result) => object } 自定义摘要（覆盖默认）
 * opts.before: { fnName: () => object } 调用**前**先取一份状态，和结果一起记。
 *   为什么需要：像 mood.startupDecay() 这种"没有参数、按离线时长扣分"的函数，
 *   只记结果的话日志里全是 `mood=0`，完全看不出"从 70 扣到了 0、扣了多少"
 *   —— 审计真实数据时就被这个卡住过（只看到心情恒为 0，查不出原因）。 */
function summarize(args) {
  if (!args || !args.length) return {};
  const o = {};
  args.slice(0, 4).forEach((a, i) => { o['a' + i] = redact(a); });
  return o;
}
function instrumentOne(modName, fnName, holder, opts) {
  const orig = holder[fnName];
  if (typeof orig !== 'function') return;
  if ((opts.skip || []).indexOf(fnName) >= 0) return;
  const custom = (opts.summary || {})[fnName];
  const beforeFn = (opts.before || {})[fnName];
  holder[fnName] = function () {
    const args = Array.prototype.slice.call(arguments);
    const t0 = mono();
    const base = { fn: fnName };
    let pre = null;
    if (beforeFn) { try { pre = redact(beforeFn()); } catch {} }
    const done = (ok, res, err) => {
      try {
        const d = Object.assign({}, base, summarize(args), custom ? custom(args, res) : { r: redact(res) });
        if (pre) d.before = pre;
        if (!ok) d.err = redact(String((err && err.message) || err));
        d.ms = Math.round(mono() - t0);
        log(modName, ok ? 'call' : 'err', d);
      } catch {}
    };
    let out;
    try { out = orig.apply(holder, args); }
    catch (e) { done(false, null, e); throw e; }
    if (out && typeof out.then === 'function') {
      return out.then(
        (r) => { done(true, r, null); return r; },
        (e) => { done(false, null, e); throw e; },
      );
    }
    done(true, out, null);
    return out;
  };
  try { holder[fnName].__wrapped = true; } catch {}
}
function instrument(modName, mod, opts) {
  if (!mod || typeof mod !== 'object') return;
  opts = opts || {};
  for (const k of Object.keys(mod)) {
    try {
      if (mod[k] && typeof mod[k] === 'function' && !mod[k].__wrapped) instrumentOne(modName, k, mod, opts);
    } catch {}
  }
}
/* 一次给一堆模块埋点：{ 名字: 模块对象 } */
function instrumentAll(map, optsByMod) {
  for (const [name, mod] of Object.entries(map || {})) instrument(name, mod, (optsByMod || {})[name] || {});
  log('testlog', 'instrumented', { mods: Object.keys(map || {}) });
}

/* ---------------- 分析：直接找出异常数据 ----------------
 * 按 (模块, 事件/函数) 聚合：次数、错误数、耗时统计，
 * 以及所有**数值型字段**的 min/max/avg —— 这就是"哪些数据异常"的入口。 */
function analyze(opts) {
  const o = opts || {};
  const minN = Number(o.minCount) || 2;
  let lines = [];
  try { lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean); } catch { return { error: '没有日志' }; }
  const groups = {};
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    const k = e.mod + '.' + e.ev + (e.fn ? ':' + e.fn : '');
    const g = groups[k] || (groups[k] = { n: 0, errs: 0, fields: {}, ms: [] });
    g.n++;
    if (e.err) g.errs++;
    if (Number.isFinite(e.ms)) g.ms.push(e.ms);
    for (const [f, v] of Object.entries(e)) {
      if (typeof v === 'number' && f !== 'ms' && f !== 't' && f !== 'i') {
        const s = g.fields[f] || (g.fields[f] = { min: Infinity, max: -Infinity, sum: 0, n: 0 });
        s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.n++;
      }
    }
  }
  const round = (x) => Math.round(x * 1000) / 1000;
  const report = Object.entries(groups)
    .filter(([, g]) => g.n >= minN)
    .map(([k, g]) => {
      const f = {};
      for (const [name, s] of Object.entries(g.fields)) f[name] = { min: round(s.min), max: round(s.max), avg: round(s.sum / s.n) };
      return {
        key: k, n: g.n, errs: g.errs,
        ms: g.ms.length ? { min: round(Math.min(...g.ms)), max: round(Math.max(...g.ms)), avg: round(g.ms.reduce((a, b) => a + b, 0) / g.ms.length) } : null,
        fields: f,
      };
    })
    .sort((a, b) => b.n - a.n);
  return { totalLines: lines.length, groups: report.length, report };
}

function tail(n) {
  try {
    const lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(Number(n) || 50));
  } catch { return []; }
}
function clear() { try { fs.writeFileSync(file(), ''); seq = 0; } catch {} }
function logFile() { return file(); }

module.exports = { log, instrument, instrumentAll, analyze, tail, clear, logFile, redact, MAX_STR };
