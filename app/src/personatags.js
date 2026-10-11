/* 人设词条系统（3 分层权重）—— 数据驱动 + 可被用户/AI 修改
 *
 * 为什么要有它：
 *   1) **行为方向不该写死**——「心情差的时候她是更外露、还是更压抑」取决于她是什么样的人：
 *      傲娇/高冷会把情绪收起来，病娇/雌小鬼反而更炸。这个方向现在由词条决定。
 *   2) **之后要按人设换立绘**——核心人格词条（傲娇 / 病娇 / 雌小鬼 …）就是立绘组的 key。
 *   3) **让 AI 好改人设**——词条表就是"人格词汇表"：她改人设时用标准词，系统才认得出来；
 *      遇到词汇表里没有的新人格，她可以自己用 tag_set 加词条。
 *
 * 分层（"权重"的来源，越核心权重越高）：
 *   tier 1 核心人格  权重 3  —— 决定立绘 + 行为大方向
 *   tier 2 重要特质  权重 2  —— 影响语气与行为倾向
 *   tier 3 次级修饰  权重 1  —— 细节
 *
 * 数据放在**文件**里（不再是代码常量）：
 *   内置默认  app/persona-tags.json          （随包发布，只读）
 *   实际使用  %APPDATA%/dayu-pet/persona-tags.json （用户和 AI 都能改）
 * 读坏/写坏一律回落到内置默认，绝不让词条表把主流程带崩。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/* 分层的名字与结构在代码里（改结构才需要动代码），权重值在文件里可调 */
const TIERS = {
  1: { label: '核心人格', note: '决定立绘与行为大方向' },
  2: { label: '重要特质', note: '影响语气与行为倾向' },
  3: { label: '次级修饰', note: '细节修饰' },
};
const MAX_TAGS = 200;
const MAX_WORDS = 40;

const tableFile = () => path.join(app.getPath('userData'), 'persona-tags.json');
const builtinFile = () => path.join(__dirname, '..', 'persona-tags.json');
const personaFile = () => path.join(app.getPath('userData'), 'persona.json');

/* 首次运行把内置表拷进 userData（之后用户/AI 改这份）。
   逐文件读写而不是 copyFileSync —— 打包后内置表在 asar 里，copyFileSync 不一定读得到。 */
function ensure() {
  const f = tableFile();
  if (!fs.existsSync(f)) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, fs.readFileSync(builtinFile()));
    } catch {}
  }
  return f;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/* 清洗：任何一项不合法就丢掉那一项，而不是整张表作废 */
function sanitize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const tw = o.tierWeights && typeof o.tierWeights === 'object' ? o.tierWeights : {};
  const fw = o.fieldWeights && typeof o.fieldWeights === 'object' ? o.fieldWeights : {};
  const tags = [];
  for (const t of (Array.isArray(o.tags) ? o.tags : [])) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const tier = Math.max(1, Math.min(3, Math.round(num(t.tier, 2))));
    const words = (Array.isArray(t.words) ? t.words : [])
      .map((w) => String(w || '').trim()).filter(Boolean).slice(0, MAX_WORDS);
    if (!id || !words.length) continue;
    const md = Math.round(num(t.moodDir, 0));
    /* tier1 可以带：baseline（该人格的隐藏数值基线）+ tone（语气倾向，会进提示词） */
    const base = (t.baseline && typeof t.baseline === 'object') ? t.baseline : null;
    const baseline = {};
    if (base) for (const k of ['dependency', 'extraversion', 'emotionality', 'directness', 'iq', 'diligence']) {
      if (Number.isFinite(Number(base[k]))) baseline[k] = Math.max(0, Math.min(100, Number(base[k])));
    }
    tags.push({
      id, tier, words,
      label: String(t.label || id).trim().slice(0, 12),
      moodDir: md > 0 ? 1 : (md < 0 ? -1 : 0),
      baseline: Object.keys(baseline).length ? baseline : null,
      tone: String(t.tone || '').trim().slice(0, 200),
    });
    if (tags.length >= MAX_TAGS) break;
  }
  const out = {
    version: 1,
    tierWeights: { 1: num(tw[1], 3), 2: num(tw[2], 2), 3: num(tw[3], 1) },
    fieldWeights: {
      character_setting: num(fw.character_setting, 1.5),
      personality: num(fw.personality, 1.2),
      hidden_setting: num(fw.hidden_setting, 1.0),
      catchphrase: num(fw.catchphrase, 0.8),
      world_setting: num(fw.world_setting, 0.4),
      name: num(fw.name, 0.2),
    },
    tags,
  };
  return out;
}

/* 读实际表；读不到 / 坏掉 → 内置表
 * **字段级补齐**：内置表后续新增的字段（如 baseline/tone）自动补进实际表，
 * 但绝不覆盖实际表里已有的值、也不增删词条 —— 用户/AI 改过的东西不能被升级冲掉。 */
function loadTable() {
  const raw = readJson(ensure());
  const builtin = readJson(builtinFile());
  if (raw && Array.isArray(raw.tags) && raw.tags.length) {
    if (builtin && Array.isArray(builtin.tags)) {
      const bById = {};
      for (const t of builtin.tags) if (t && t.id) bById[t.id] = t;
      let filled = 0;
      for (const t of raw.tags) {
        const bt = t && bById[t.id];
        if (!bt) continue;
        if (t.baseline === undefined && bt.baseline !== undefined) { t.baseline = bt.baseline; filled++; }
        if (!t.tone && bt.tone) { t.tone = bt.tone; filled++; }
        if (t.moodDir === undefined && bt.moodDir !== undefined) { t.moodDir = bt.moodDir; filled++; }
      }
      /* 补齐过就落盘一次，让这份文件始终是"自解释"的（用户和 AI 都要读它） */
      if (filled) { try { fs.writeFileSync(tableFile(), JSON.stringify(raw, null, 2)); } catch {} }
    }
    return sanitize(raw);
  }
  return sanitize(builtin);
}

function saveTable(next) {
  const clean = sanitize(next);
  try {
    const f = tableFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(clean, null, 2));
  } catch { return null; }
  cache = { key: null, result: null };
  return clean;
}

/* AI 工具：新增或覆盖一条词条（按 id 匹配）。words 可以给字符串数组，也可以给逗号分隔串 */
function setTag(patch) {
  const p = patch || {};
  const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return { ok: false, error: 'id 只能用小写字母/数字/-/_' };
  const words = Array.isArray(p.words) ? p.words : String(p.words || '').split(/[,，、\s]+/);
  const clean = words.map((w) => String(w || '').trim()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'words 不能为空' };
  const tier = Math.max(1, Math.min(3, Math.round(Number(p.tier) || 2)));
  const md = Math.round(Number(p.moodDir) || 0);

  const table = loadTable();
  const item = {
    id, tier, words: clean.slice(0, MAX_WORDS),
    label: String(p.label || id).trim().slice(0, 12),
    moodDir: md > 0 ? 1 : (md < 0 ? -1 : 0),
  };
  const i = table.tags.findIndex((t) => t.id === id);
  const existed = i >= 0;
  if (existed) {
    /* 只覆盖显式给了的字段，没给的保留原样（AI 想只补词就不用重写整条） */
    const old = table.tags[i];
    table.tags[i] = {
      id,
      tier: p.tier === undefined ? old.tier : item.tier,
      label: p.label === undefined ? old.label : item.label,
      words: p.words === undefined ? old.words : item.words,
      moodDir: p.moodDir === undefined ? old.moodDir : item.moodDir,
    };
  } else {
    table.tags.push(item);
  }
  if (!saveTable(table)) return { ok: false, error: '写入失败' };
  return { ok: true, action: existed ? 'updated' : 'added', tag: table.tags.find((t) => t.id === id), total: table.tags.length };
}

function removeTag(id) {
  const key = String(id || '').trim().toLowerCase();
  const table = loadTable();
  const i = table.tags.findIndex((t) => t.id === key);
  if (i < 0) return { ok: false, error: '没有这个词条：' + key };
  const [gone] = table.tags.splice(i, 1);
  if (!saveTable(table)) return { ok: false, error: '写入失败' };
  return { ok: true, removed: gone, total: table.tags.length };
}

/* ---------------- 人设文本 ---------------- */
function loadPersona() {
  const p = readJson(personaFile()) || {};
  if (!p.character_setting && p.character) p.character_setting = p.character;   // 兼容旧字段名
  return p;
}
function sigOf(p, table) {
  const t = table || loadTable();
  const s = Object.keys(t.fieldWeights).map((f) => String((p || {})[f] || '')).join('|')
    + '#' + JSON.stringify(t.tags) + '#' + JSON.stringify(t.tierWeights);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

let cache = { key: null, result: null };

function analyze(persona) {
  const p = persona || loadPersona();
  const table = loadTable();
  const key = sigOf(p, table);
  if (cache.key === key && cache.result) return cache.result;

  const hits = {};
  const tw = table.tierWeights, fw = table.fieldWeights;
  const bump = (tag, field, w, n) => {
    if (!n) return;
    const h = hits[tag.id] || (hits[tag.id] = { score: 0, hits: 0, fields: {}, words: {} });
    h.score += (tw[tag.tier] || 1) * (fw[field] || 1) * n;
    h.hits += n;
    h.fields[field] = (h.fields[field] || 0) + n;
    h.words[w] = (h.words[w] || 0) + n;
  };
  for (const tag of table.tags) {
    /* 拿 tag.id 也匹配一次（词边界、大小写不敏感）。
     * 为什么需要：表里的匹配词只有中/日文（傲娇/ツンデレ…），而 id 是英文
     * （tsundere / yandere / gentle / stubborn…）—— 那正好就是最标准的英文说法。
     * 以前用户把人物设定写成英文（"a tsundere whale maid"）**一个词都匹配不上**，
     * 于是 analyze 返回空、archOf 落到 _default、toneOf 为空、baseline 不生效：
     * 整套人格系统静默失效，还没有任何提示。
     * 用词边界是为了别让 gentle 命中 gentleman、genki 命中 genkiness 之类。 */
    const idRe = new RegExp('(^|[^a-zA-Z])' + String(tag.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-zA-Z])', 'gi');
    for (const field of Object.keys(fw)) {
      const text = String(p[field] || '');
      if (!text) continue;
      bump(tag, field, tag.id, (text.match(idRe) || []).length);
      for (const w of tag.words) {
        let idx = 0, n = 0;
        while ((idx = text.indexOf(w, idx)) >= 0) { n++; idx += w.length; }
        bump(tag, field, w, n);
      }
    }
  }

  const matched = table.tags
    .filter((t) => hits[t.id])
    .map((t) => ({
      id: t.id, label: t.label, tier: t.tier, tierLabel: (TIERS[t.tier] || {}).label || ('tier' + t.tier),
      moodDir: t.moodDir || 0, tone: t.tone || '', hasBaseline: !!t.baseline,
      score: Math.round(hits[t.id].score * 100) / 100,
      hits: hits[t.id].hits,
      fields: hits[t.id].fields,
      words: Object.keys(hits[t.id].words),
    }))
    .sort((a, b) => (a.tier - b.tier) || (b.score - a.score));

  const core = matched.filter((m) => m.tier === 1);
  const result = {
    key,
    core,
    traits: matched.filter((m) => m.tier === 2),
    modifiers: matched.filter((m) => m.tier === 3),
    all: matched,
    primary: core[0] || null,
    spriteKey: core[0] ? core[0].id : null,
    totalScore: Math.round(matched.reduce((n, m) => n + m.score, 0) * 100) / 100,
  };
  cache = { key, result };
  return result;
}

/* 心情差的时候感性度往哪走：+1 更外露 / -1 更压抑（默认 -1） */
function moodDir(persona) {
  const p = analyze(persona).primary;
  if (!p) return -1;                    // 认不出人格 → 保守走"收起来"
  return p.moodDir === 1 ? 1 : -1;
}

/* 核心人格 → 隐藏数值基线（多个人格命中时按分数加权平均）
 * 返回 null 表示没识别出核心人格（调用方自己兜底） */
function baselinesOf(persona) {
  const table = loadTable();
  const byId = {};
  for (const t of table.tags) if (t.baseline) byId[t.id] = t.baseline;
  const a = analyze(persona);
  const keys = ['dependency', 'extraversion', 'emotionality', 'directness', 'iq', 'diligence'];
  const acc = {}, wsum = { };
  let any = false;
  for (const m of a.core) {
    const b = byId[m.id];
    if (!b) continue;
    any = true;
    for (const k of keys) {
      if (!Number.isFinite(Number(b[k]))) continue;
      acc[k] = (acc[k] || 0) + Number(b[k]) * m.score;
      wsum[k] = (wsum[k] || 0) + m.score;
    }
  }
  if (!any) return null;
  const out = {};
  for (const k of keys) if (wsum[k]) out[k] = Math.round((acc[k] / wsum[k]) * 100) / 100;
  return Object.keys(out).length ? out : null;
}

/* 语气倾向：核心人格的 tone（+ 命中的 tier2 特质名做个补充），给提示词用 */
function toneOf(persona) {
  const a = analyze(persona);
  const parts = a.core.filter((m) => m.tone).map((m) => m.label + '：' + m.tone);
  const traits = a.traits.slice(0, 4).map((m) => m.label);
  let s = parts.join('\n');
  if (traits.length) s += (s ? '\n' : '') + '（同时还有这些特质：' + traits.join('、') + '）';
  return s;
}

/* 给提示词的"人格词汇表"（AI 改人设时照着用，系统才认得出） */
function vocabulary() {
  const table = loadTable();
  const byTier = { 1: [], 2: [], 3: [] };
  for (const t of table.tags) (byTier[t.tier] || (byTier[t.tier] = [])).push(t.label);
  return [1, 2, 3].map((i) => (TIERS[i] ? TIERS[i].label + '：' + (byTier[i].join(' / ') || '（无）') : '')).filter(Boolean).join('\n');
}

function summary(persona) {
  const a = analyze(persona);
  const line = (arr) => arr.map((m) => m.label + '(' + m.tierLabel.slice(0, 2) + '·' + m.score + ')').join('、') || '（无）';
  return [
    '核心人格: ' + line(a.core),
    '重要特质: ' + line(a.traits),
    '次级修饰: ' + line(a.modifiers),
    '立绘 key: ' + (a.spriteKey || '（未识别）'),
    '心情差时感性度: ' + (moodDir(persona) > 0 ? '更外露 (+1)' : '更压抑 (-1)'),
  ].join('\n');
}

module.exports = {
  TIERS, MAX_TAGS,
  tableFile, builtinFile, ensure, loadTable, saveTable, setTag, removeTag,
  analyze, moodDir, baselinesOf, toneOf, vocabulary, summary, loadPersona, sigOf,
};
