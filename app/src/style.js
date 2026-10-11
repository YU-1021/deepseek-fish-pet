// 界面风格系统
//
// 目的：桌宠写任何带界面的代码（网页 / 小程序 / 桌面程序）时，产出的 UI 都要**像她做的**——
// 配色、圆角、字体、文案语气统一，而且这套风格不是硬编码的，是从**人设**推导、并被**记忆**影响的。
//
// 三层来源：
//   1) 人设（persona）→ 基础设计规范：让 LLM 从人设推导一次，存进 memory/style.json，之后复用
//   2) 记忆（mood/好感度）→ 动态微调：好感高就更暖，心情差就更冷
//   3) 记忆（永久记忆里的偏好）→ 比如主人说自己喜欢深色，就照着调
const store = require('./store');
const path = require('path');
const fs = require('fs');

const NS = 'style';
const SKILL_ID = '界面风格';   // 风格会写成这个技能，写界面时按需加载（平时不占 token）

function load() {
  const v = store.read(NS, null);
  return (v && typeof v === 'object' && v.palette) ? v : null;
}
function save(v) { store.write(NS, v); return v; }

/* 让人设推导出一套设计规范（只做一次，之后复用；改人设可以手动重生成） */
async function derive(llm, cfg, persona) {
  const p = persona || {};
  const sys = `你是一位资深 UI 设计师。请根据下面这个角色的设定，为"她写出来的界面"设计一套**统一的设计规范**。
要求：风格要能从人设里读出来（性格、世界观、职业、口癖），但必须**实用、耐看**，不要花哨到影响可读性。
只输出一个 JSON 对象，不要 markdown、不要解释。字段：
{
  "name": "风格名（2-6字）",
  "palette": { "bg": "背景 #RRGGBB", "surface": "卡片 #RRGGBB", "primary": "主色 #RRGGBB", "accent": "点缀色 #RRGGBB", "text": "正文色 #RRGGBB", "muted": "次要文字 #RRGGBB" },
  "radius": "圆角，如 14px",
  "font": "字体栈，如 system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  "spacing": "间距体系，如 8px 基准，卡片内边距 16-20px",
  "tone": "界面上文案的语气（她会怎么写按钮、提示、报错）",
  "motifs": ["体现人设的小元素，2-4 个，如 鲸鱼/水滴/蕾丝"],
  "rules": ["3-5 条写界面时必须遵守的规矩"]
}`;
  const user = `角色名：${p.name || '大肥鱼'}
世界观：${p.world_setting || '现代都市，住在主人电脑里的桌宠'}
人物设定：${p.character_setting || '蓝发鲸鱼女仆，傲娇、温柔、嘴硬'}
性格：${p.personality || '傲娇、温柔、嘴硬'}
口头禅：${p.catchphrase || 'I am NOT a freeloader fat fish!'}`;

  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]);
  const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('模型没给出 JSON');
  const o = JSON.parse(t.slice(a, b + 1));
  if (!o || !o.palette) throw new Error('风格 JSON 缺 palette');
  o.createdAt = Date.now();
  o.fromPersona = String(p.name || '');
  return o;
}

/* 兜底：LLM 不可用时给一套中性但像样的规范 */
function fallback(persona) {
  const p = persona || {};
  return {
    name: '深海',
    palette: { bg: '#f4f8fc', surface: '#ffffff', primary: '#4f8fd6', accent: '#79c9e6', text: '#243044', muted: '#6b7a90' },
    radius: '14px',
    font: "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    spacing: '8px 基准，卡片内边距 16-20px',
    tone: '干净克制，偶尔一句符合角色性格的俏皮话，不要卖萌过度',
    motifs: ['水滴', '鲸尾'],
    rules: ['主色用于唯一的主要操作按钮', '卡片圆角统一', '文字对比度要够，别为了好看牺牲可读性'],
    createdAt: Date.now(),
    fromPersona: String(p.name || ''),
    fallback: true,
  };
}

/* 把风格写成一份技能，写界面时按需加载 —— 平时完全不占 token */
function writeSkillFile() {
  const s = load();
  if (!s) return null;
  const dir = path.join(require('electron').app.getPath('userData'), 'skills', SKILL_ID);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = '---\n'
      + 'name: 界面风格（' + (s.name || '默认') + '）\n'
      + 'description: 你要写任何带界面的东西（网页 / 小程序 / 桌面程序的登录页、面板等）之前，先读这个，照它做\n'
      + '---\n\n'
      + '这是**你自己的界面风格**，从你的人设推导出来。你写的任何 UI 都要看起来像"你做的"。\n\n'
      + spec(null, null, false) + '\n';
    const p = path.join(dir, 'SKILL.md');
    fs.writeFileSync(p, body);
    return p;
  } catch { return null; }
}

/* 人设指纹：用来判断人设有没有变过（变了就重新推导风格，避免风格被固定住） */
function personaSig(p) {
  p = p || {};
  const s = [p.name, p.world_setting, p.character_setting, p.personality, p.catchphrase].map((x) => String(x || '')).join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

/* 生成或复用：人设没变就复用；人设变了（或 force）就按新人设重新推导 */
async function ensure(llm, cfg, persona, force) {
  const cur = load();
  const sig = personaSig(persona);
  if (cur && !force && cur.sig === sig) { cur.personaChanged = false; return cur; }
  const changed = !!(cur && cur.sig !== sig);
  let out;
  try {
    if (llm && cfg && cfg.apiKey) out = await derive(llm, cfg, persona);
  } catch (e) { /* 落到兜底 */ }
  if (!out) out = fallback(persona);
  out.sig = sig;
  save(out);          // 注意：personaChanged 是临时标记，不落盘（否则下次启动会误报）
  writeSkillFile();
  return Object.assign({}, out, { personaChanged: changed });
}

/* 记忆联动：好感度/心情 → 冷暖微调（确定性，不花 token） */
function moodHint(mood) {
  const m = mood || {};
  const aff = Number(m.affection) || 0;
  const mo = Number(m.mood) || 0;
  const bits = [];
  if (aff >= 70) bits.push('关系和主人很好：配色可以更暖、更亮，文案更亲昵');
  else if (aff <= 25) bits.push('关系还生疏：配色克制一些，别太亲昵');
  if (mo <= 30) bits.push('心情偏低：整体饱和度压低一点，别太跳');
  else if (mo >= 75) bits.push('心情很好：允许点缀色更活泼一点');
  return bits.join('；');
}

/* 给提示词用的风格规范文本（只在要写界面时才需要）
   includeMood=false 用于写进技能文件——心情是动态的，不该固化进文件 */
function spec(cfg, mood, includeMood) {
  const s = load();
  if (!s) return '';
  const withMood = includeMood !== false;
  const p = s.palette || {};
  const lines = [
    '设计规范「' + (s.name || '默认') + '」（写任何界面都必须遵守）：',
    '- 配色：背景 ' + p.bg + '｜卡片 ' + p.surface + '｜主色 ' + p.primary + '｜点缀 ' + p.accent + '｜正文 ' + p.text + '｜次要文字 ' + p.muted,
    '- 圆角：' + s.radius,
    '- 字体：' + s.font,
    '- 间距：' + s.spacing,
    '- 文案语气：' + s.tone,
    Array.isArray(s.motifs) && s.motifs.length ? '- 人设元素：' + s.motifs.join(' / ') : '',
    Array.isArray(s.rules) && s.rules.length ? '- 规矩：' + s.rules.map((r) => r).join('；') : '',
    '- 实现要求：单一 HTML/CSS 能直接跑；响应式；按钮有 hover/active 反馈；不要用外部图片和 CDN',
    (withMood && moodHint(mood)) ? '- 当前状态微调：' + moodHint(mood) : '',
  ];
  return lines.filter(Boolean).join('\n');
}

module.exports = { load, save, derive, ensure, spec, moodHint, fallback, writeSkillFile, personaSig, SKILL_ID, NS };
