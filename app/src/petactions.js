/* 交互动作表 —— 热区 × 核心人格 → 动作
 *
 * 数据放文件里（同 personatags 的做法）：
 *   内置默认  app/pet-actions.json
 *   实际使用  %APPDATA%/dayu-pet/pet-actions.json   （用户和 AI 都能改）
 *
 * 放图槽（重点）：任何动作都可以带一个 pose 名。渲染层按 pose 名去要图：
 *   %APPDATA%/dayu-pet/art/poses/<pose>.png   ← 丢进去就生效（优先）
 *   app/assets/sprites/<skin>/<pose>.png      ← 随包素材
 * 两者都没有就返回 null，渲染层只用 CSS 形变，不报错。
 * 所以画师只要照着 table.poses 里的名字作图即可，不用碰代码。
 *
 * 解析优先级（逐级回落）：
 *   say : region.say[人格] → region.say._default → group.say[人格] → group.say._default → global.say._default
 *   其它: region → group → global
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const tableFile = () => path.join(app.getPath('userData'), 'pet-actions.json');
const builtinFile = () => path.join(__dirname, '..', 'pet-actions.json');
const posesDir = () => path.join(app.getPath('userData'), 'art', 'poses');
const bundledPosesDir = (skin) => path.join(__dirname, '..', 'assets', 'sprites', String(skin || 'dafeiyu'));

const ANIMS = ['bounce', 'shake', 'tilt', 'blush', 'look_away', 'lean_in', 'sparkle', 'surprise', 'smug', 'wag', 'none'];

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

/* 一条台词：{ en, zh }。en 是给她念的英文（TTS + 气泡），zh 是中文翻译。
   兼容旧的"纯中文字符串"写法（当成 en 用，不会崩）。 */
function takesLine(v) {
  if (typeof v === 'string') { const t = v.trim(); return t ? { en: t.slice(0, 200), zh: '' } : null; }
  if (v && typeof v === 'object') {
    const en = String(v.en || '').trim().slice(0, 200);
    const zh = String(v.zh || '').trim().slice(0, 200);
    if (!en && !zh) return null;
    return { en: en || zh, zh };
  }
  return null;
}

/* 只认结构，坏字段丢掉、不整表作废 */
function sanitize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
  const takesSay = (s) => {
    const out = {};
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s)) {
        const line = takesLine(v);
        if (line) out[String(k).toLowerCase()] = line;
      }
    }
    return out;
  };
  const takesNode = (n) => {
    const x = (n && typeof n === 'object') ? n : {};
    const o2 = {};
    if (x.anim) o2.anim = ANIMS.includes(str(x.anim, 20)) ? str(x.anim, 20) : undefined;
    if (x.pose) o2.pose = str(x.pose, 40);
    if (x.fx) o2.fx = str(x.fx, 8);
    if (x.mode === 'llm' || x.mode === 'preset') o2.mode = x.mode;
    if (x.key) o2.key = true;
    if (x.mood && typeof x.mood === 'object') {
      const m = {};
      for (const k of ['affection', 'mood']) {
        const v = Number(x.mood[k]);
        if (Number.isFinite(v) && v) m[k] = Math.max(-5, Math.min(5, v));
      }
      if (Object.keys(m).length) o2.mood = m;
    }
    const say = takesSay(x.say);
    if (Object.keys(say).length) o2.say = say;
    return o2;
  };

  const groups = {};
  for (const [g, v] of Object.entries(o.groups && typeof o.groups === 'object' ? o.groups : {})) {
    groups[String(g)] = takesNode(v);
  }
  const regions = {};
  for (const [r, v] of Object.entries(o.regions && typeof o.regions === 'object' ? o.regions : {})) {
    const node = takesNode(v);
    if (v && v.group) node.group = str(v.group, 20);
    regions[String(r)] = node;
  }
  return {
    version: 1,
    poses: Array.isArray(o.poses) ? o.poses.map((p) => str(p, 40)).filter(Boolean) : [],
    global: takesNode(o.global),
    groups, regions,
  };
}

function loadTable() {
  const builtin = readJson(builtinFile());
  let raw = readJson(ensure());
  const bv = Number(builtin && builtin.version) || 0;
  const rv = Number(raw && raw.version) || 0;
  /* 格式升级：新版把台词从"纯字符串"改成了 {en, zh} —— 这种**结构性**变化没法逐字段补齐。
     旧版就备份后直接用新版内置表（备份文件留着，用户/AI 改过的东西不会凭空消失）。
     AI 重写的台词在覆盖层里，不受这次升级影响。 */
  if (raw && (raw.regions || raw.groups) && bv && rv < bv) {
    try { fs.writeFileSync(tableFile() + '.v' + rv + '.bak', JSON.stringify(raw, null, 2)); } catch {}
    try { fs.writeFileSync(tableFile(), JSON.stringify(builtin, null, 2)); } catch {}
    raw = builtin;
  }
  if (raw && (raw.regions || raw.groups)) return sanitize(raw);
  return sanitize(builtin);
}

/* 某个 pose 名到底有没有图：用户丢的优先，其次随包素材 */
function poseFile(pose, skin) {
  if (!pose) return null;
  for (const p of [
    path.join(posesDir(), pose + '.png'),
    path.join(bundledPosesDir(skin), pose + '.png'),
  ]) {
    try { if (fs.statSync(p).size > 512) return p; } catch {}
  }
  return null;
}
/* 哪些 pose 已经有图了（给"素材缺口"面板用） */
function poseReport(skin) {
  const t = loadTable();
  return t.poses.map((p) => ({ pose: p, has: !!poseFile(p, skin) }));
}

/* 核心人格 id（来自 personatags）；认不出就 _default */
function archOf(persona) {
  try {
    const a = require('./personatags').analyze(persona);
    return (a.primary && a.primary.id) || '_default';
  } catch { return '_default'; }
}

const pick = (region, group, global, field) => {
  if (region && region[field] !== undefined) return region[field];
  if (group && group[field] !== undefined) return group[field];
  return global ? global[field] : undefined;
};
const pickSay = (region, group, global, arch) => {
  const d = '_default';
  const tries = [
    region && region.say && region.say[arch], region && region.say && region.say[d],
    group && group.say && group.say[arch], group && group.say && group.say[d],
    global && global.say && global.say[d],
  ];
  for (const t of tries) if (t) return t;
  return null;
};

/* ---------------- AI 覆盖层 ----------------
 * AI 重写的台词写这里（不动手写底稿）：%APPDATA%/dayu-pet/pet-actions-ai.json
 * 只在 overlay.arch 与当前核心人格一致时才生效 —— 人格换了，旧台词自动作废，
 * 回落到手写底稿（等下一次重写生成新的）。 */
const overlayFile = () => path.join(app.getPath('userData'), 'pet-actions-ai.json');
let overlayCache = null, overlayMtime = -1;

function loadOverlay() {
  try {
    const st = fs.statSync(overlayFile());
    if (overlayCache && overlayMtime === st.mtimeMs) return overlayCache;
    const j = JSON.parse(fs.readFileSync(overlayFile(), 'utf8').replace(/^\uFEFF/, ''));
    const lines = {};
    const src = (j && j.lines && typeof j.lines === 'object') ? j.lines : {};
    for (const [k, v] of Object.entries(src)) { const line = takesLine(v); if (line) lines[k] = line; }
    overlayCache = { version: 1, sig: String((j && j.sig) || ''), arch: String((j && j.arch) || ''), at: Number(j && j.at) || 0, lines };
    overlayMtime = st.mtimeMs;
  } catch {
    overlayCache = { version: 1, sig: '', arch: '', at: 0, lines: {} };
    overlayMtime = -1;
  }
  return overlayCache;
}
function saveOverlay(o) {
  const clean = { version: 1, sig: String((o && o.sig) || ''), arch: String((o && o.arch) || ''), at: Date.now(), lines: {} };
  for (const [k, v] of Object.entries((o && o.lines) || {})) { const line = takesLine(v); if (line) clean.lines[k] = line; }
  try { fs.writeFileSync(overlayFile(), JSON.stringify(clean, null, 2)); } catch { return null; }
  overlayCache = null; overlayMtime = -1;
  return clean;
}
/* 场上还有效的覆盖层（人格不一致就当作没有） */
function activeOverlay(arch) {
  const ov = loadOverlay();
  return (ov.arch && ov.arch === arch) ? ov : null;
}

/* region: { id, group }（直接来自渲染层 regionAt） */
function resolve(region, persona, skin) {
  if (!region || !region.id) return null;
  const t = loadTable();
  const r = t.regions[region.id] || null;
  const gkey = (r && r.group) || region.group || '';
  const g = t.groups[gkey] || null;
  const arch = archOf(persona);

  const anim = pick(r, g, t.global, 'anim') || 'bounce';
  const pose = pick(r, g, t.global, 'pose') || '';
  const fx = pick(r, g, t.global, 'fx') || '';
  const mode = pick(r, g, t.global, 'mode') || 'preset';
  const mood = pick(r, g, t.global, 'mood') || null;
  const ov = activeOverlay(arch);
  const say = (ov && ov.lines[region.id]) || pickSay(r, g, t.global, arch);

  return {
    region: region.id,
    regionName: region.name || region.id,
    group: gkey,
    arch,
    anim: ANIMS.includes(anim) ? anim : 'bounce',
    pose,
    poseFile: poseFile(pose, skin),          // 有图才有值；渲染层据此决定切不切图
    fx,
    mode,                                    // preset | llm
    key: !!(r && r.key),
    say,                                     // { en, zh } | null
    sayFromAI: !!(ov && ov.lines[region.id]),
    mood,
  };
}

/* 给"要我画哪些图"看的清单 */
function poseNames() { return loadTable().poses.slice(); }
function regionIds() { return Object.keys(loadTable().regions); }

/* ---------------- AI 重写台词的提示词 ----------------
 * 放这里（而不是塞在 main.js）是为了**可测**：主进程和测试脚本共用同一份，不会走样。
 * rows: [{ id, name, en, zh }] —— 要重写的部位及当前台词（只作语气参考）。 */
function buildRewritePrompt(p, arch, rows) {
  p = p || {}; arch = arch || {};
  const list = (rows || []).map((r) => r.id + '（' + r.name + '）: ' + JSON.stringify({ en: r.en || '', zh: r.zh || '' })).join('\n');
  return `你是桌宠「${p.name || '大肥鱼'}」的台词作者。主人用鼠标点她身体的不同部位时，她会说一句即时反应。
请按她**当前的人设**，为下面每个部位重写台词，输出**英文**（她会念出来）+ **中文翻译**。

【她是谁】
人物设定：${p.character_setting || '（未填）'}
性格：${p.personality || '（未填）'}
口头禅：${p.catchphrase || '（未填）'}
核心人格：${arch.label || '（未识别）'}${arch.tone ? '（' + arch.tone + '）' : ''}

【要重写的部位】当前台词（只作语气参考，可以全部推翻）
${list}

要求：
- 只输出一个 JSON 对象：键是部位 id，值是 {"en":"...","zh":"..."}
- en 必须是**她脱口而出的一句话**（1 句、口语、不超过 12 个词），不要旁白、不要动作描写、不要引号
- zh 是 en 的忠实中文翻译
- 严格贴住上面的人设和核心人格；不同部位的台词要不一样
- 不要 markdown、不要解释、不要多余文字`;
}

module.exports = {
  tableFile, builtinFile, posesDir, ensure, loadTable, resolve, poseFile, poseReport, poseNames, regionIds, ANIMS,
  overlayFile, loadOverlay, saveOverlay, activeOverlay, takesLine, buildRewritePrompt,
};
