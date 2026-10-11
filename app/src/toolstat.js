/* 工具使用统计（纯记录）—— 给**我**看的，她感知不到
 *
 * ★★★ 设计约束（用户特别关心的：不要妨碍她"总结情感"那套）★★★
 *   ① ★绝不调用模型 ✗★ —— 只记**程序已经知道的事实** ✓
 *      （用了哪个工具、成没成、多久 —— 步骤流水里本来就有 ✓）
 *   ② ★绝不写进她的对话 ✗ / 绝不进提示词 ✗★ —— 她感知不到 ✓
 *   ③ ★绝不碰 stats.json / skillmem.json ✗★ ——
 *      情绪/关系那套（stats.js 的 nudge 与 judge）**一个字都不改** ✓✓
 *   ④ 存独立文件 toolstat.json ✓
 *
 * 【为什么要它】
 *   实测（2026-10-03）：她 58 个工具**只用过 9 个** ✗ —— 而那是我手工翻 chatlog 数出来的 ✓。
 *   她的"经验提炼"机制设计上分两阶段（skills.js 的注释写着"候选池，阶段 2 用"），
 *   ★阶段 2 从来没做★ ✗ → permanent.json / skillmem.json 永远是空壳 ✓。
 *   于是"什么情况用什么工具"这条知识，目前**只有我手写进 override.md** 这一条路 ✓。
 *   这个模块把"数工具使用"变成**自动、零成本**的事 ✓ ——
 *   我读它的 summary() 就能发现模式（哪些常用、哪些从没用过、哪些老是失败 ✓），
 *   再把结论写进 override.md ✓✓
 *
 * 【一轮任务怎么界定】
 *   不引入新的"任务开始/结束"信号 ✗（那会碰她的循环 ✓）。
 *   用**空闲结算**：有新步骤就续着，★空闲超过 IDLE_MS 就把这一轮结算成一条记录★ ✓。
 *   这和她的"任务期 15 秒无动作即结束"是同一个思路 ✓（也避免了改动她的状态机 ✓）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IDLE_MS = 20000;        // 空闲 20 秒 = 这一轮结束
const MAX_ROUNDS = 400;       // 文件里最多留这么多轮
let storeFile = null;
let rounds = [];
let cur = null;               // 当前这一轮
let idleTimer = null;
let toolTotals = {};          // 累积计数（跨轮）

function dbg(msg) { try { require('./debug').log('[toolstat] ' + msg); } catch (e) {} }

function load() {
  if (!storeFile) return;
  try {
    const j = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    rounds = Array.isArray(j.rounds) ? j.rounds : [];
    toolTotals = j.totals && typeof j.totals === 'object' ? j.totals : {};
  } catch (e) { rounds = []; toolTotals = {}; }
}
function save() {
  if (!storeFile) return;
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ rounds, totals: toolTotals }, null, 0), 'utf8');
  } catch (e) { /* ★ 统计失败绝不能影响她做事 ✗★ */ }
}

function init(opts) {
  storeFile = (opts && opts.file) || null;
  load();
  /* ★ 一开始就落盘 ★ —— 这样"文件存在"本身就是"接线生效"的证据 ✓
     （原来只 load 不 save，要等她跑完第一轮任务文件才出现，不好确认接线 ✓）*/
  save();
  return { rounds: rounds.length, tools: Object.keys(toolTotals).length };
}

/* 记一个步骤（在步骤流水的发事件处调 ✓）*/
function note(tool, status) {
  try {
    const t = String(tool || '');
    if (!t) return;
    if (!cur) cur = { at: Date.now(), tools: [], fails: 0, ms: 0 };
    /* running 只用来"开一轮"，ok/fail 才计入 ✓（避免同一步记两遍 ✓） */
    if (status === 'running') { arm(); return; }
    const ok = status === 'ok';
    cur.tools.push({ name: t, ok });
    if (!ok) cur.fails++;
    toolTotals[t] = toolTotals[t] || { n: 0, fail: 0 };
    toolTotals[t].n++;
    if (!ok) toolTotals[t].fail++;
    arm();
  } catch (e) { /* ★ 绝不外抛 ✗★ */ }
}

/* 补一步的耗时（步骤流水里有 ms ✓）*/
function noteMs(ms) {
  try { if (cur && Number.isFinite(Number(ms))) cur.ms += Number(ms); } catch (e) {}
}

function arm() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  idleTimer = setTimeout(() => { try { settle('idle'); } catch (e) {} }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/* 结算当前这一轮 */
function settle(reason) {
  if (!cur || !cur.tools.length) { cur = null; return null; }
  const r = {
    at: cur.at, endAt: Date.now(), reason: reason || 'idle',
    n: cur.tools.length, fails: cur.fails, ms: cur.ms,
    /* ★ 只留工具名序列，不留参数 ✗★（参数里可能有隐私/长文本 ✓） */
    seq: cur.tools.map((x) => x.name + (x.ok ? '' : '!')).join(' '),
    used: Array.from(new Set(cur.tools.map((x) => x.name))),
  };
  cur = null;
  rounds.push(r);
  while (rounds.length > MAX_ROUNDS) rounds.shift();
  save();
  dbg('结算一轮：' + r.n + ' 步 / ' + r.fails + ' 失败 / ' + Math.round(r.ms / 1000) + 's —— ' + r.seq.slice(0, 120));
  return r;
}

/* 给任务文案补个标签（可选 ✓ —— 收尾时如果知道任务原文就带上 ✓）*/
function label(text) {
  try {
    if (!cur) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t) cur.task = t;
  } catch (e) {}
}

/* ★ 给我看的统计 ★ */
function summary() {
  const used = Object.entries(toolTotals).sort((a, b) => b[1].n - a[1].n || b[1].fail - a[1].fail);
  const faily = used.filter(([, v]) => v.fail > 0).sort((a, b) => b[1].fail - a[1].fail);
  return {
    rounds: rounds.length,
    recent: rounds.slice(-8).map((r) => ({ at: r.at, n: r.n, fails: r.fails, ms: r.ms, seq: r.seq.slice(0, 100) })),
    toolsUsed: used.length,
    top: used.slice(0, 20).map(([k, v]) => k + '×' + v.n + (v.fail ? ('(失败' + v.fail + ')') : '')),
    mostFailed: faily.slice(0, 10).map(([k, v]) => k + ' 失败' + v.fail + '/' + v.n),
    /* 注册表里有、但从来没被用过的 —— ★这是最有价值的一栏 ✓★ */
    neverUsed: (function () {
      try {
        const R = require('./registry');
        return R.TOOL_DEFS.map((d) => d.name).filter((n) => !toolTotals[n]);
      } catch (e) { return []; }
    })(),
  };
}

module.exports = { init, note, noteMs, label, settle, summary, all: () => rounds, totals: () => toolTotals };
