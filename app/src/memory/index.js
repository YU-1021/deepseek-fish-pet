/* 记忆系统 · 门面
 *
 * 对外只暴露很少几个入口（init / onAppStart / onTurn / onSessionEnd / buildContext / pickHistory），
 * 依赖（llm / config / persona）由 main.js 用 init() 注入 —— 记忆层不硬依赖它们，方便换实现或测试。
 * 未来要接入的新系统（学习经验、DSH 联动…）请：
 *   1) 自己开一个命名空间：store.read/write('你的名字', ...)
 *   2) 通过 bus.on(...) 订阅生命周期，别去改别人的模块
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const bus = require('../bus');
const tokens = require('../tokens');
const store = require('../store');
const session = require('./session');
const medium = require('./medium');
const long = require('./long');
const permanent = require('./permanent');
const context = require('./context');
const jobs = require('./jobs');

let deps = { llm: null, config: null, persona: null };
function init(d) { deps = Object.assign(deps, d || {}); return deps; }

const cfg = () => { try { return deps.config ? deps.config.load() : {}; } catch { return {}; } };
const memCfg = () => { const m = cfg().memory; return m && typeof m === 'object' ? m : {}; };
const dayStr = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* 旧版 memory.json（{medium, long}）一次性迁进 memory/ 目录 */
function migrate() {
  try {
    const oldFile = path.join(app.getPath('userData'), 'memory.json');
    if (!fs.existsSync(oldFile)) return { migrated: false };
    if (store.exists('medium') || store.exists('long')) return { migrated: false };
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(old.medium)) medium.save(old.medium);
    if (Array.isArray(old.long)) long.save(old.long);
    try { fs.renameSync(oldFile, oldFile + '.migrated'); } catch {}
    return { migrated: true };
  } catch { return { migrated: false }; }
}

/* 保留策略：中期只留 N 条，日记只留 N 天 */
function applyRetention(mc) {
  medium.prune(mc.mediumKeep || 20);
  long.pruneDays(mc.longKeepDays || 20);
}

/* 把"非今天"的中期摘要熔炼成日记（人设口吻），然后清掉它们 */
async function consolidate(mc) {
  const today = dayStr(Date.now());
  const old = medium.olderThan(today);
  if (!old.length) return 0;
  const byDay = {};
  for (const e of old) (byDay[e.date] = byDay[e.date] || []).push(e.summary);
  const c = cfg();
  const llm = deps.llm;
  let n = 0;
  for (const [date, sums] of Object.entries(byDay)) {
    let text = sums.join('\n\n');
    if (llm && c.apiKey) {
      try {
        const d = await jobs.diary(llm, c, deps.persona ? deps.persona() : {}, date, sums);
        if (d) text = d;
      } catch {}
    }
    long.add({ date, diary: tokens.clip(text, 800), ts: Date.now() });
    n++;
  }
  medium.keepOnly(today);
  return n;
}

/* 启动编排：迁移 → 恢复草稿（未结束的会话）→ 候选衰减 → 熔炼日记 → 晋升 → 保留策略 */
async function onAppStart() {
  migrate();
  session.restore();
  const mc = memCfg();
  try { permanent.decay(mc.candDays || 14, mc.candDecay || 0.8, mc.candFloor || 1); } catch {}
  try { await consolidate(mc); } catch {}
  try { permanent.promote(mc.promoteWeight || 7); } catch {}
  applyRetention(mc);
  bus.emit('app:start', { session: session.info() });
  return session.info();
}

/* 一轮对话入库（compact 是给"老回合压缩"用的精简版） */
function onTurn(userText, rawReply, enText) {
  session.push(
    { role: 'user', content: String(userText || '') },
    { role: 'assistant', content: String(rawReply || ''), compact: 'EN: ' + String(enText || '') }
  );
  bus.emit('session:turn', session.info());
}

/* 只记助手侧（开场白之类） */
function onAssistant(rawReply, enText) {
  session.push({ role: 'assistant', content: String(rawReply || ''), compact: 'EN: ' + String(enText || '') });
}

/* 会话收尾：写中期摘要 + 抽永久记忆候选 → 清草稿 */
async function onSessionEnd() {
  const msgs = session.all();
  const info = session.info();
  if (msgs.length < 2) { session.clear(); return { ok: true, skipped: true }; }
  if (medium.has(info.id)) { session.clear(); return { ok: true, duplicate: true }; }

  const mc = memCfg();
  const c = cfg();
  const llm = deps.llm;
  const entry = { id: info.id, date: dayStr(info.startedAt), turns: msgs.length, ts: Date.now(), summary: '' };

  if (llm && c.apiKey) {
    try { entry.summary = await jobs.summarize(llm, c, msgs); } catch {}
  }
  if (!entry.summary) entry.summary = tokens.clip(msgs.slice(-6).map((m) => m.content).join(' / '), 300);
  medium.add(entry);

  let extracted = 0;
  if (llm && c.apiKey) {
    try {
      const items = await jobs.extractFacts(llm, c, msgs);
      if (items.length) {
        permanent.merge(items);
        const r = permanent.promote(mc.promoteWeight || 7);
        extracted = items.length;
        bus.emit('memory:permanent', r);
      }
    } catch {}
  }

  applyRetention(mc);
  session.clear();
  bus.emit('session:end', { id: info.id, extracted });
  return { ok: true, extracted };
}

function buildContext() { return context.build(cfg()); }

function pickHistory(budgetTokens, fullTurns) {
  const mc = memCfg();
  return context.pickHistory(
    session.all(),
    budgetTokens || mc.historyTokens || 6000,
    fullTurns || mc.fullTurns || 3
  );
}

module.exports = {
  init, onAppStart, onTurn, onAssistant, onSessionEnd, buildContext, pickHistory,
  migrate, dayStr,
  session, medium, long, permanent, tokens, bus,
};
