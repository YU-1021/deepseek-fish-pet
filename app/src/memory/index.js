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
const skillmem = require('./skillmem');
const context = require('./context');
const jobs = require('./jobs');
const stats = require('../stats');

let deps = { llm: null, config: null, persona: null, skillCatalog: null };
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
  /* 上次收尾做到一半就崩了/被强杀 → 把 pending 捡回来补做，别让那段对话白丢。
     放后台跑，不拖慢启动。 */
  try {
    const pend = store.read(END_NS, null);
    if (pend && Array.isArray(pend.msgs) && pend.msgs.length >= 2 && !medium.has(pend.id)) {
      finishEnding(pend)
        .then((r) => { try { store.write(END_NS, null); } catch {} bus.emit('session:end', Object.assign({ recovered: true }, r)); })
        .catch(() => {});
    } else if (pend) {
      try { store.write(END_NS, null); } catch {}
    }
  } catch {}
  const mc = memCfg();
  try { permanent.decay(mc.candDays || 14, mc.candDecay || 0.8, mc.candFloor || 1); } catch {}
  try { skillmem.decay(mc.skillCandDays || 21, mc.candDecay || 0.8, mc.candFloor || 1); } catch {}
  try { skillmem.prune(mc.skillPoolMax || 200); } catch {}
  try { await consolidate(mc); } catch {}
  try { permanent.promote(mc.promoteWeight || 7); } catch {}
  applyRetention(mc);
  bus.emit('app:start', { session: session.info() });
  return session.info();
}

/* 一轮对话入库（compact 是给"老回合压缩"用的精简版）
   注意：compact **绝不能长得像一条正常回复** —— 否则历史里堆满"只有一行 EN:"的范例，
   模型会跟着学，回复就丢掉 ZH/WORDS 了。所以这里加一个明确的历史标记。 */
const COMPACT_MARK = '(earlier reply, abridged) ';
function onTurn(userText, rawReply, enText) {
  session.push(
    { role: 'user', content: String(userText || '') },
    { role: 'assistant', content: String(rawReply || ''), compact: COMPACT_MARK + String(enText || '') }
  );
  bus.emit('session:turn', session.info());
}

/* 只记助手侧（开场白之类） */
function onAssistant(rawReply, enText) {
  session.push({ role: 'assistant', content: String(rawReply || ''), compact: COMPACT_MARK + String(enText || '') });
}

/* 会话收尾：写中期摘要 + 抽永久记忆候选 → 清草稿
 *
 * 两个坑都在这里堵掉：
 * ① 重入：以前没有"正在收尾"的保护，连点「结束本次会话」或"结束完马上退出"
 *    会并发跑两次 → 8 次模型调用、同 id 的中期摘要写两条、候选权重记两次提前晋升。
 * ② 丢回合：以前 session.clear() 排在 4 个并行模型调用**之后**，而那几秒里
 *    输入框照常可用，用户新说的话会被 push 进旧 state，随后一起被 clear() 丢掉。
 * 现在改成：先快照 → 立刻把快照交给 pending 命名空间并清空当前会话（新话进新会话）
 * → 再慢慢做摘要。中途崩溃的话，下次启动会把 pending 捡回来补做。 */
const END_NS = 'ending';
let ending = null;

async function onSessionEnd() {
  if (ending) return ending;                       // 重入：复用同一次收尾
  ending = doSessionEnd().finally(() => { ending = null; });
  return ending;
}

async function doSessionEnd() {
  const info = session.info();
  const msgs = session.all().slice();              // ① 快照（复制，之后新回合不再混进来）

  if (msgs.length < 2) {
    session.clear();
    try { store.write(END_NS, null); } catch {}
    return { ok: true, skipped: true };
  }
  if (medium.has(info.id)) {
    session.clear();
    try { store.write(END_NS, null); } catch {}
    return { ok: true, duplicate: true };
  }

  // ② 先把草稿落到 pending 并清空会话：这几秒里用户新说的话会进**新会话**，不会被丢掉
  try { store.write(END_NS, { id: info.id, startedAt: info.startedAt, msgs, at: Date.now() }); } catch {}
  session.clear();

  const r = await finishEnding({ id: info.id, startedAt: info.startedAt, msgs });
  try { store.write(END_NS, null); } catch {}
  return r;
}

/* 真正的收尾工作（也用于启动时补做上次没收完的） */
async function finishEnding(p) {
  const msgs = Array.isArray(p && p.msgs) ? p.msgs : [];
  if (msgs.length < 2) return { ok: true, skipped: true };
  const info = { id: (p && p.id) || '', startedAt: (p && p.startedAt) || Date.now() };

  const mc = memCfg();
  const c = cfg();
  const llm = deps.llm;
  const entry = { id: info.id, date: dayStr(info.startedAt), turns: msgs.length, ts: Date.now(), summary: '' };

  /* 四件事互相独立（都只是"读同一段对话、产出各自的结果"）→ **并行跑**。
     同样的 token，会话结束的等待时间从"4 次串行"砍到"1 次的时间"，而且各自失败互不影响。 */
  const useLLM = !!(llm && c.apiKey);
  const cat = deps.skillCatalog ? deps.skillCatalog() : '';
  const curAll = Object.assign({}, require('../mood').load(), stats.all());
  const [summary, factItems, expItems, judged] = useLLM
    ? await Promise.all([
      jobs.summarize(llm, c, msgs).catch(() => ''),
      jobs.extractFacts(llm, c, msgs).catch(() => []),
      jobs.extractExperiences(llm, c, msgs, cat).catch(() => []),
      jobs.judgeStats(llm, c, msgs, deps.persona ? deps.persona() : {}, curAll).catch(() => null),
    ])
    : ['', [], [], null];

  if (summary) entry.summary = summary;
  if (!entry.summary) entry.summary = tokens.clip(msgs.slice(-6).map((m) => m.content).join(' / '), 300);
  medium.add(entry);

  /* 永久记忆候选 */
  let extracted = 0;
  if (factItems && factItems.length) {
    permanent.merge(factItems);
    const r = permanent.promote(mc.promoteWeight || 7);
    extracted = factItems.length;
    bus.emit('memory:permanent', r);
  }

  /* 做事的经验 → 共有的技能长期记忆库（权重够了再归档进技能文件夹） */
  let learned = 0;
  if (expItems && expItems.length) {
    const r = skillmem.merge(expItems, mc.skillPoolMax || 200);
    learned = expItems.length;
    bus.emit('memory:skillmem', r);
  }

  /* 先把"非今天"的中期摘要熔炼成日记，**再**按条数裁剪。
     以前 consolidate 只在启动时跑一次，而裁剪每次收尾都跑 —— 不重启连用几天，
     早期摘要会被 prune 直接删掉，永远进不了日记层。 */
  try { await consolidate(mc); } catch {}
  applyRetention(mc);

  /* 内在数值的变化（长期陪伴向：绝大多数是 0，单次最多 ±2） */
  let statChange = null;
  if (judged && Object.keys(judged.deltas).length) {
    const applied = stats.applyDeltas(judged.deltas, judged.reason);
    const st = stats.load();
    st.lastJudge = Date.now();
    stats.save(st);
    statChange = { reason: judged.reason, applied, deltas: judged.deltas };
    bus.emit('stats:judged', statChange);
  }

  bus.emit('session:end', { id: info.id, extracted, learned, statChange });
  return { ok: true, extracted, learned, statChange };
}

function buildContext() { return context.build(cfg()); }

/* 补跑数值判断：会话一直没结束时（App 挂着好几天），启动时兜底判一次 */
async function judgeStatsNow() {
  const c = cfg();
  const llm = deps.llm;
  if (!llm || !c.apiKey) return null;
  const msgs = session.all();
  const st = stats.load();
  if (!msgs || msgs.length < 4) return null;
  if (Date.now() - (st.lastJudge || 0) < 12 * 3600000) return null;
  try {
    const j = await jobs.judgeStats(llm, c, msgs, deps.persona ? deps.persona() : {}, Object.assign({}, require('../mood').load(), stats.all()));
    const bump = () => { const s2 = stats.load(); s2.lastJudge = Date.now(); stats.save(s2); };
    if (j && Object.keys(j.deltas).length) {
      const applied = stats.applyDeltas(j.deltas, '[启动补判] ' + j.reason);
      bump();
      bus.emit('stats:judged', { reason: j.reason, applied, deltas: j.deltas, catchUp: true });
      return { reason: j.reason, applied };
    }
    bump();
  } catch {}
  return null;
}

function pickHistory(budgetTokens, fullTurns) {
  const mc = memCfg();
  return context.pickHistory(
    session.all(),
    budgetTokens || mc.historyTokens || 6000,
    fullTurns || mc.fullTurns || 3
  );
}

module.exports = {
  init, onAppStart, onTurn, onAssistant, onSessionEnd, finishEnding, buildContext, pickHistory, judgeStatsNow,
  migrate, dayStr,
  session, medium, long, permanent, skillmem, stats, tokens, bus, jobs,
};
