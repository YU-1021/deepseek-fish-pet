// 隐藏数值系统（8 个）
//
// 设计要点（长期陪伴向）：
//   · 数值全部**隐藏**——不进界面，只在提示词里翻译成"行为指导"
//   · 分层：情绪层跑得快、性格层极慢、能力层只涨不回归（见 LAYERS）
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

const dayStr = (ts) => {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

function blank() {
  const o = { counts: {}, day: dayStr(), lastJudge: 0, lastRegress: 0 };
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
  /* 递减权重自带 MIN_W 下限，这里**不要再对 delta 兜一次底**：
     那样会把 inertia 的"×0.5"直接覆盖掉（同一 key 当天第 27 次以上时惯性失效）。 */
  let delta = inertia(key, cur, Number(base) * weight(n));

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
  logChange({ key, from: cur, to: next, delta: real, trigger: trigger || '', reason: String(reason || '').slice(0, 120), n });
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
  if (q >= 80) return 10;
  if (q >= 65) return 8;
  if (q >= 50) return 6;
  if (q >= 35) return 4;
  return 3;
}

/* 由人设推导初始值（跟"界面风格"一样带人设指纹） */
function personaSig(p) {
  p = p || {};
  const s = [p.name, p.world_setting, p.character_setting, p.personality, p.catchphrase].map((x) => String(x || '')).join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}
function baselineFromPersona(p) {
  p = p || {};
  const text = [p.character_setting, p.personality, p.world_setting, p.catchphrase].map((x) => String(x || '')).join(' ');
  const has = (re) => re.test(text);
  const o = {};
  o.dependency = has(/黏|依赖|想念|寂寞/) ? 68 : 58;
  o.extraversion = has(/沉默|安静|话少|内向|清冷/) ? 35 : (has(/活泼|话痨|元气|外向/) ? 78 : 48);
  o.emotionality = has(/感性|情绪化|容易感动|温柔/) ? 68 : (has(/冷静|理性|冷淡/) ? 32 : 52);
  o.directness = has(/直白|有什么说什么|嘴硬|吐槽/) ? 62 : (has(/含蓄|委婉|害羞/) ? 34 : 48);
  o.iq = 55;
  o.diligence = has(/认真|一丝不苟|负责/) ? 70 : 60;
  return o;
}

/* 首次/人设变了 → 重置到基线（已有数值不覆盖，除非 force） */
function ensureBaseline(persona, force) {
  const v = load();
  const sig = personaSig(persona);
  if (!force && v.sig === sig && v.inited) return v;
  const base = baselineFromPersona(persona);
  const fresh = blank();
  for (const k of KEYS) fresh[k] = (force || !v.inited) ? base[k] : v[k];
  fresh.sig = sig;
  fresh.inited = true;
  fresh.counts = force ? {} : v.counts;
  fresh.day = v.day;
  fresh.lastJudge = v.lastJudge;
  fresh.lastSeen = v.lastSeen;
  fresh.lastRegress = v.lastRegress;
  save(fresh);
  return fresh;
}

function get(key) { return (load())[key]; }
function all() { const v = load(); const o = {}; for (const k of KEYS) o[k] = v[k]; return o; }

module.exports = {
  META, KEYS, HIDDEN, NEUTRAL, DAILY_CAP,
  load, save, nudge, applyDeltas, regress, weight, inertia, tierOf, behaviorSpec, stepBudget,
  baselineFromPersona, ensureBaseline, personaSig, recentLog, get, all, dayStr,
};
