// 隐藏数值系统（8 个）
//
// 设计要点（长期陪伴向）：
//   · 数值全部**隐藏**——不进界面，只在提示词里翻译成"行为指导"
//   · 分层：情绪层跑得快、性格层极慢、能力层只涨不回归（见 LAYERS）
//   · **与好感/心情挂钩**：同一件事，在她心情好/关系近时"意义不同"（见 RELATE_*）
//   · **感性度的方向看人设**：傲娇/高冷低落时把情绪收起来，病娇/雌小鬼低落时更外露
//     （方向由 src/personatags.js 的词条分析给出，不是写死的；见 moodDirOf）
//   · 软边际递减：同类事件今天第 n 次，增量 × W(n)=1/(1+0.35(n-1))，永远不为 0
//   · 惯性：>80 时正向更慢，<20 时负向更慢（防止顶死）
//   · 保底：IQ / 认真度 ≥ 20（陪伴不该把助手陪成废人）
//   · 变更日志：每次变化都记一条，事后能查"她怎么变这样了"
const store = require('./store');
const bus = require('./bus');

const NS = 'stats';
const LOG_NS = 'statslog';

/* 分层与规则
 * 注意：好感度/心情**不归这里管**——它们在 mood.js（界面要显示），
 * 这里只管界面上看不到的那 6 个隐藏数值。模型判断里如果给了好感度/心情，
 * 由 applyDeltas 转发给 mood.js。 */
const META = {
  dependency:   { label: '依赖度', layer: 'relation', floor: 0,  cap: 95, regress: 0 },
  extraversion: { label: '外向度', layer: 'trait',    floor: 5,  cap: 95, regress: 0.2 },
  emotionality: { label: '感性度', layer: 'trait',    floor: 5,  cap: 95, regress: 0.2 },
  directness:   { label: '直白度', layer: 'trait',    floor: 5,  cap: 95, regress: 0.2 },
  iq:           { label: 'IQ',     layer: 'ability',  floor: 20, cap: 95, regress: 0 },
  diligence:    { label: '认真度', layer: 'ability',  floor: 20, cap: 95, regress: 0 },
};
const KEYS = Object.keys(META);
const HIDDEN = KEYS.slice();                       // 界面上不显示的那 6 个
const FORWARD = { affection: 1, mood: 1 };         // 转发给 mood.js 的

const NEUTRAL = 50;
const DECAY_K = 0.35;      // 软递减系数
const MIN_W = 0.05;        // 递减权重下限（不归零）
const DAILY_CAP = 1.5;     // 每天每项软上限（曲线本身收敛在 ~1，这条只是保险）
/* 改人设时"基线平移"的强度：1.0 = 基线差多少就整段平移多少（保留累积偏移）。
   嫌换人格时数值跳太猛（比如直接顶到上限），把它调到 0.7 / 0.5 即可。 */
const PERSONA_SHIFT = 1.0;

const dayStr = (ts) => {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

function blank() {
  const o = { counts: {}, day: dayStr(), lastJudge: 0, lastRegress: 0, base: null, sig: null };
  for (const k of KEYS) o[k] = NEUTRAL;
  return o;
}
function load() {
  const v = store.read(NS, null);
  if (!v || typeof v !== 'object') return blank();
  const o = Object.assign(blank(), v);
  o.counts = (v.counts && typeof v.counts === 'object') ? v.counts : {};
  for (const k of KEYS) if (typeof o[k] !== 'number' || !isFinite(o[k])) o[k] = NEUTRAL;
  return o;
}
function save(v) { store.write(NS, v); bus.emit('stats:changed', v); return v; }
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (k, x) => Math.max(META[k].floor, Math.min(META[k].cap, x));

/* 软边际递减权重 */
function weight(n) {
  const m = Math.max(1, Number(n) || 1);
  return Math.max(MIN_W, 1 / (1 + DECAY_K * (m - 1)));
}

/* ---------------- 与好感度/心情挂钩 ----------------
 * 同一件事，在她心情好、关系近的时候"意义不一样"：
 *   正向事件 ×(1 + S·(相关度−0.5))   —— 相关度高 → 涨得多
 *   负向事件 ×(1 − S·(相关度−0.5))   —— 相关度高 → 掉得少
 * 相关度 = 心情/好感 的加权混合（0~1）；0.5 是**中点 → 乘数恰好 1.0**，
 * 所以中性状态下行为与挂钩前完全一致（向后兼容，不会一次性把老存档改味）。
 *
 * 作用范围：**只作用于确定性触发**（task-ok / task-fail / away 等）。
 * 会话结束的模型判断(trigger='judge')**跳过**——那个判断的提示词里本来就已经给了
 * 好感度和心情，模型已经据此给过 ±2 了，再乘一次等于同一个因素算两遍，会过冲。
 */
const RELATE_S = 0.8;            // 强度：0.8 → 乘数区间 0.6 ~ 1.4
const RELATE_MIN = 0.4, RELATE_MAX = 1.6;
/* 每层看谁：[心情权重, 好感权重] */
const RELATE_MIX = {
  ability:  [0.85, 0.15],   // IQ / 认真度：主要看心情 —— 心情差就学不进、还容易出错
  relation: [0.35, 0.65],   // 依赖度：主要看好感 —— 越亲近越黏
  trait:    [0.65, 0.35],   // 外向 / 感性 / 直白：心情为主、好感为辅
};

/* 感性度的方向**看人设**：病娇/雌小鬼这类心情差时更外露，傲娇/高冷则把情绪收起来。
 * 其余数值一律走"高相关度 → 涨得多"。 */
const EMOTIONALITY_KEY = 'emotionality';
function moodDirOf() {
  try { return require('./personatags').moodDir(); } catch { return -1; }
}

function relateOf(key, base) {
  const m = META[key];
  if (!m || !base) return 1;
  const mix = RELATE_MIX[m.layer] || [0.5, 0.5];
  let spirit = 0.5, bond = 0.5;          // 读不到就当中性，绝不影响主流程
  try {
    const mo = require('./mood').load();
    spirit = Math.max(0, Math.min(1, (Number(mo.mood) || 0) / 100));
    bond = Math.max(0, Math.min(1, (Number(mo.affection) || 0) / 100));
  } catch {}
  const rel = mix[0] * spirit + mix[1] * bond;
  const gain = 1 + RELATE_S * (rel - 0.5);
  let f = base > 0 ? gain : (2 - gain);      // 负向事件反过来：相关度高 → 伤害小
  /* 感性度：人设说是"更外露"型时，把方向翻过来（低落时涨得多、掉得少） */
  if (key === EMOTIONALITY_KEY && moodDirOf() > 0) f = base > 0 ? (2 - gain) : gain;
  return Math.max(RELATE_MIN, Math.min(RELATE_MAX, round2(f)));
}

/* 惯性：接近上下限时更难动 */
function inertia(k, cur, base) {
  if (base > 0 && cur > 80) return base * 0.5;
  if (base < 0 && cur < 20) return base * 0.5;
  return base;
}

function logChange(entry) {
  try {
    const arr = store.read(LOG_NS, []) || [];
    arr.push({ ts: Date.now(), ...entry });
    store.write(LOG_NS, arr.slice(-200));
  } catch {}
}
const recentLog = (n) => { const a = store.read(LOG_NS, []) || []; return a.slice(-(Number(n) || 20)); };

/* 核心：给一个数值加一笔（含递减 + 惯性 + 保底 + 日上限 + 记账）
 * base 是"基准增量"（可正可负），trigger 用来分线计数
 * noCap=true 时绕过日上限（会话结束的模型判断走这条） */
function nudge(key, base, trigger, reason, noCap) {
  if (!META[key] || !base) return null;
  const v = load();
  const today = dayStr();
  if (v.day !== today) { v.day = today; v.counts = {}; }          // 跨天重置计数

  const cur = Number(v[key]) || NEUTRAL;
  const ck = key + ':' + (trigger || 'x');
  const n = (Number(v.counts[ck]) || 0) + 1;                      // 第几次
  /* 与好感/心情挂钩：确定性触发都乘；会话结束的模型判断(judge)跳过（见 relateOf 注释） */
  const rf = (trigger === 'judge') ? 1 : relateOf(key, Number(base));
  /* 递减权重自带 MIN_W 下限，这里**不要再对 delta 兜一次底**：
     那样会把 inertia 的"×0.5"直接覆盖掉（同一 key 当天第 27 次以上时惯性失效）。 */
  let delta = inertia(key, cur, Number(base) * weight(n) * rf);

  const dayPos = key + ':#day+', dayNeg = key + ':#day-';
  const usedP = Number(v.counts[dayPos]) || 0, usedN = Number(v.counts[dayNeg]) || 0;
  if (!noCap) {
    /* 日上限要**削到剩余额度**，而不是"到点了就整笔归零"：
       以前判断 usedP >= 1.5 才归零，于是最后一笔可以一次把用量顶到 2.1。 */
    if (delta > 0) delta = Math.min(delta, Math.max(0, DAILY_CAP - usedP));
    else if (delta < 0) delta = -Math.min(-delta, Math.max(0, DAILY_CAP - usedN));
  }

  const next = clamp(key, round2(cur + delta));
  const real = round2(next - cur);
  if (!real) return { key, from: cur, to: cur, delta: 0, skipped: true };

  v[key] = next;
  v.counts[ck] = n;
  if (!noCap) {
    if (real > 0) v.counts[dayPos] = round2(usedP + real);
    else v.counts[dayNeg] = round2(usedN - real);
  }
  save(v);
  logChange({ key, from: cur, to: next, delta: real, trigger: trigger || '', reason: String(reason || '').slice(0, 120), n, relate: round2(rf) });
  return { key, from: cur, to: next, delta: real, n };
}

/* 批量（会话结束的模型判断用；每项 -2~+2）。
 * 好感度/心情转发给 mood.js（那边才是界面上显示的那份）。 */
function applyDeltas(deltas, reason) {
  const out = [];
  for (const [k, d] of Object.entries(deltas || {})) {
    const capped = Math.max(-2, Math.min(2, Number(d) || 0));
    if (!capped) continue;
    if (FORWARD[k]) {
      try { require('./mood').adjust({ [k]: capped }); out.push({ key: k, delta: capped, forwarded: true }); } catch {}
      continue;
    }
    if (!META[k]) continue;
    const r = nudge(k, capped, 'judge', reason, true);   // 模型判断绕过日上限
    if (r && !r.skipped) out.push(r);
  }
  return out;
}

/* 慢回归：性格层往中间靠一点。**按时间限流**（默认 6 小时最多一次），
   否则一天重启十次就漂两点了，根本不是"极慢"。IQ/认真度/关系层不回归。 */
function regress(maxStep) {
  const v = load();
  const now = Date.now();
  const MIN_GAP = 6 * 3600000;
  if (v.lastRegress && now - v.lastRegress < MIN_GAP) return [];
  const step = Math.max(0, Math.min(0.5, Number(maxStep) || 0.2));
  const out = [];
  for (const k of KEYS) {
    const m = META[k];
    if (!m.regress) continue;
    const cur = Number(v[k]) || NEUTRAL;
    const d = cur > NEUTRAL ? -Math.min(step, m.regress) : (cur < NEUTRAL ? Math.min(step, m.regress) : 0);
    if (!d) continue;
    const next = clamp(k, round2(cur + d));
    const real = round2(next - cur);
    if (!real) continue;
    v[k] = next;
    out.push({ key: k, from: cur, to: next, delta: real });
  }
  if (out.length) { v.lastRegress = Date.now(); save(v); }
  return out;
}

/* 分档行为指导（数值真正落地的地方） */
const TIERS = {
  dependency: [
    [35, '你不太黏主人，他忙你的、你忙你的，互不打扰'],
    [50, '你会留意主人在不在，但不会一直凑上去'],
    [65, '你有点黏主人了，隔一会儿就想知道他在干嘛'],
    [80, '你很黏主人，他久不理你你会主动找话说'],
    [101, '你非常黏主人，看不到他就会有点不安，会反复找他'],
  ],
  extraversion: [
    [35, '你话很少，回话短，不太主动开启话题'],
    [50, '你正常说话，不多不少'],
    [65, '你比以前爱聊了，会主动接话、多问一句'],
    [80, '你话挺多，爱感叹、爱吐槽，气氛由你带'],
    [101, '你是个话痨，一开口就停不下来'],
  ],
  emotionality: [
    [35, '你很冷静，说话偏分析、讲道理'],
    [50, '你理性感性差不多，看情况'],
    [65, '你比较感性，容易被打动，会表达感受'],
    [80, '你很情绪化，开心难过都写在脸上'],
    [101, '你完全跟着感觉走，情绪浓烈、说变就变'],
  ],
  directness: [
    [35, '你说话很含蓄，爱绕弯、爱暗示，不好意思直说'],
    [50, '你该直说就直说，该委婉就委婉'],
    [65, '你偏直白，想什么说什么'],
    [80, '你说话很直接，不藏着掖着'],
    [101, '你有啥说啥，直来直去，从不拐弯'],
  ],
  iq: [
    [35, '你脑子不太灵光，容易想岔；拿不准就先问主人，别硬来'],
    [50, '你办事还行，偶尔会绕弯路，做完最好确认一下'],
    [65, '你思路清楚，一般一次就能找对办法'],
    [80, '你很机灵，会自己想到更省事的做法'],
    [101, '你一眼就看穿问题，还会顺手把相关的事一起办妥'],
  ],
  diligence: [
    [35, '你有点敷衍，能省就省，做完不太爱检查'],
    [50, '你正常干活，该做的会做'],
    [65, '你比较用心，做完会看一眼结果对不对'],
    [80, '你很认真，会复核、会把情况讲清楚'],
    [101, '你一丝不苟，宁可多花点时间也要做对做全'],
  ],
};

function tierOf(key, val) {
  const rows = TIERS[key];
  if (!rows) return '';
  const v = Number(val) || NEUTRAL;
  for (const [max, text] of rows) if (v < max) return text;
  return rows[rows.length - 1][1];
}

/* 给提示词用的"当前状态"段落（隐藏数值翻译成行为，不给数字） */
function behaviorSpec() {
  const v = load();
  const lines = [];
  for (const k of HIDDEN) lines.push('- ' + META[k].label + '：' + tierOf(k, v[k]));
  return lines.join('\n');
}

/* IQ → 任务步数上限（能力影响效率的机械效果） */
function stepBudget() {
  const v = load();
  const q = Number(v.iq) || NEUTRAL;
  /* ⚠️ 这里原来是写死的档位 3/4/6/8/10 —— **实测太低**：
     用户 IQ 54 → 只有 6 步，而"写文件 → 跑脚本 → 看结果 → 改一下 → 再跑"
     这种任务轻松超过 10 步，她只能中途停下报"没做完"
     （用户原话："你给她步骤太少了，导致她完成不了任务"）。
     现在改成在 base~max 之间按 IQ 连续插值，Base/Max 可配：
       IQ 20 → base(8)    IQ 95 → max(30)    IQ 54 → 约 18 */
  let base = 8, max = 30;
  try {
    const c = require('./config').load();
    if (Number(c.stepBudgetBase) > 0) base = Number(c.stepBudgetBase);
    if (Number(c.stepBudgetMax) > 0) max = Number(c.stepBudgetMax);
  } catch {}
  const lo = Math.max(1, Math.round(base));
  const hi = Math.max(lo, Math.round(max));
  const t = Math.max(0, Math.min(1, (q - 20) / 75));      // IQ 20 → 0，IQ 95 → 1
  return Math.round(lo + (hi - lo) * t);
}

/* 由人设推导初始值（跟"界面风格"一样带人设指纹） */
function personaSig(p) {
  p = p || {};
  const s = [p.name, p.world_setting, p.character_setting, p.personality, p.catchphrase].map((x) => String(x || '')).join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}
/* 基线：优先取「核心人格」的词条 baseline（写在 persona-tags.json 里，用户和 AI 都能改）；
   认不出核心人格时才回落到关键词兜底（老逻辑，保留以防词条表被改坏）。 */
function baselineFromPersona(p) {
  p = p || {};
  let o = null;
  try { o = require('./personatags').baselinesOf(p); } catch {}
  if (!o) {
    const text = [p.character_setting, p.personality, p.world_setting, p.catchphrase].map((x) => String(x || '')).join(' ');
    const has = (re) => re.test(text);
    o = {
      dependency: has(/黏|依赖|想念|寂寞/) ? 68 : 58,
      extraversion: has(/沉默|安静|话少|内向|清冷/) ? 35 : (has(/活泼|话痨|元气|外向/) ? 78 : 48),
      emotionality: has(/感性|情绪化|容易感动|温柔/) ? 68 : (has(/冷静|理性|冷淡/) ? 32 : 52),
      directness: has(/直白|有什么说什么|嘴硬|吐槽/) ? 62 : (has(/含蓄|委婉|害羞/) ? 34 : 48),
      iq: 55,
      diligence: has(/认真|一丝不苟|负责/) ? 70 : 60,
    };
  }
  const out = {};
  for (const k of KEYS) {
    const v = Number(o[k]);
    out[k] = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : NEUTRAL;
  }
  return out;
}

/* 首次/人设变了 → 重置到基线（已有数值不覆盖，除非 force） */
function ensureBaseline(persona, force) {
  const v = load();
  const sig = personaSig(persona);
  if (!force && v.sig === sig && v.inited) {
    /* 老存档没有基线记录 → 补记一份（**不改数值**）。
       这样以后改人设时，位移量 = 新基线 − 这份基线，累积的陪伴一点不丢。 */
    if (!v.base) { v.base = baselineFromPersona(persona); save(v); }
    return v;
  }
  const base = baselineFromPersona(persona);
  const fresh = blank();
  for (const k of KEYS) fresh[k] = (force || !v.inited) ? base[k] : v[k];
  fresh.sig = sig;
  fresh.inited = true;
  fresh.base = base;
  fresh.counts = force ? {} : v.counts;
  fresh.day = v.day;
  fresh.lastJudge = v.lastJudge;
  fresh.lastSeen = v.lastSeen;
  fresh.lastRegress = v.lastRegress;
  save(fresh);
  return fresh;
}

/* 用户（或 AI）改了人设 → **重新评估一次隐藏数值**：
 *   取新基线，把当前数值**按基线的变化量整段平移**。
 *   ——保留"陪了多久"的累积（不清零），只让性格底子跟着人设走。
 *   人设只改了口头禅之类没动关键词时，基线不变 → 平移量 0 → 数值原地不动。
 */
function rebaseline(persona) {
  const v = load();
  const sig = personaSig(persona);
  if (v.sig === sig) return { changed: false, applied: [], reason: '人设指纹没变' };
  const next = baselineFromPersona(persona);
  const prev = (v.base && typeof v.base === 'object') ? v.base : null;
  const applied = [];
  for (const k of KEYS) {
    if (!prev) {                       // 连基线都没有（极端情况）→ 只补记基线，**不动数值**
      continue;
    }
    const shift = round2((Number(next[k]) - Number(prev[k])) * PERSONA_SHIFT);
    if (!shift) continue;
    const nv = clamp(k, round2(v[k] + shift));
    if (nv === v[k]) continue;
    applied.push({ key: k, from: v[k], to: nv, delta: round2(nv - v[k]) });
    v[k] = nv;
  }
  const wasInited = !!v.inited;
  v.base = next;
  v.sig = sig;
  v.inited = true;
  save(v);
  for (const a of applied) {
    logChange({ key: a.key, from: a.from, to: a.to, delta: a.delta, trigger: 'rebaseline', reason: '人设改动 → 基线平移', n: 1, relate: 1 });
  }
  const out = { changed: true, first: !wasInited, applied, base: next };
  bus.emit('stats:rebaseline', out);
  return out;
}

function get(key) { return (load())[key]; }
function all() { const v = load(); const o = {}; for (const k of KEYS) o[k] = v[k]; return o; }

module.exports = {
  META, KEYS, HIDDEN, NEUTRAL, DAILY_CAP,
  load, save, nudge, applyDeltas, regress, weight, inertia, relateOf, moodDirOf, rebaseline, RELATE_MIX, RELATE_S, tierOf, behaviorSpec, stepBudget,
  baselineFromPersona, ensureBaseline, personaSig, recentLog, get, all, dayStr,
};
