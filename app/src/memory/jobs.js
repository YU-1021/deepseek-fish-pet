/* 记忆相关的 LLM 任务（会话摘要 / 日记 / 抽关键要点）
 * 只负责"怎么问 + 怎么解析"，不碰存储、不碰编排。
 */
const tokens = require('../tokens');

function convoToText(msgs, maxChars) {
  const s = (msgs || []).map((m) => (m.role === 'user' ? 'User: ' : '大肥鱼: ') + String(m.content || '')).join('\n');
  return tokens.clip(s, maxChars || 6000);
}

async function summarize(llm, cfg, msgs) {
  const raw = await llm.request(cfg, [
    { role: 'system', content: '把这段对话压缩成中文要点摘要（聊了什么、用户状态、重要事实），120字以内，只输出纯文本。' },
    { role: 'user', content: convoToText(msgs, 6000) }
  ]);
  return tokens.clip(String(raw || '').trim(), 300);
}

async function diary(llm, cfg, persona, date, sums) {
  const p = persona || {};
  const sys = `你是日记代笔。请以「${p.name || '大肥鱼'}」的第一人称视角，把下面的会话摘要写成一篇中文日记。
世界观：${p.world_setting || '现代都市，你是住在主人电脑里的桌宠。'}
人物设定：${p.character_setting || '蓝发鲸鱼女仆，傲娇、温柔、嘴硬。'}
性格：${p.personality || '傲娇、温柔、嘴硬'}
要求：语气、称呼、口头禅**完全贴合上述人设**（人设改了，日记风格也要跟着改）；自然、简短，150 字以内；只输出日记正文，不要标题、不要 markdown。`;
  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: '日期：' + date + '\n\n' + (sums || []).join('\n') }
  ]);
  return tokens.clip(String(raw || '').trim(), 300);
}

/* 抽"值得永久记住"的要点。输出用行格式（这套模型对行格式比 JSON 稳）：
 *   要点|权重|标签,标签
 */
async function extractFacts(llm, cfg, msgs) {
  const sys = `你是一台"记忆筛选器"。从下面这段主人和桌宠的对话里，挑出**值得永久记住**的关于主人的信息。

只挑这四类：
1) 关于主人本人的稳定事实（名字、年龄、生日、职业、身份、所在城市…）
2) 主人的偏好与禁忌（喜欢 / 讨厌什么）
3) 主人的目标与计划（在准备什么、想做什么）
4) 主人明确要求记住的事（"记住…" "以后…"）

权重 1~10 打分标准：
- 用户明确说"记住 / 以后" → 9~10
- 关于主人本人的稳定事实 → 7~9
- 偏好 / 目标 → 5~8
- 情绪很浓的重要时刻 → 5~7
- 一次性琐事、纯闲聊 → **不要输出**

输出格式：每行一条，三段用竖线分隔，**只输出这些行**，不要编号、不要解释、不要代码块：
要点|权重|标签

示例：
主人在准备考研|9|目标,学业
主人讨厌早上被叫醒|6|偏好

如果这段对话里没有任何值得永久记住的内容，就只输出一个空行。`;

  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: convoToText(msgs, 6000) }
  ]);
  return parseFacts(raw);
}

/* 清掉模型爱加的行首列表符号。
   **不能**用 /^[-*•\d.、)）\s]+/ 一把梭：那样 "3月要去上海出差" 会被吃成 "月要去上海出差"，
   "2024年换的工作" 会变成 "年换的工作"。只剥真正的列表符号和编号。 */
function stripBullet(line) {
  return String(line == null ? '' : line)
    .replace(/^\s*[-*•·]\s*/, '')            // - * • ·
    .replace(/^\s*\d+\s*[.、)）]\s*/, '')     // 1. 2、 3) 这类编号
    .trim();
}

/* 权重解析：漏写/写空时 Number('') === 0 而 isFinite(0) 为真，
   会被 clamp 到下限 1（本来想要 5 / 4）→ 这种要点几乎永远攒不到晋升阈值。
   所以空串必须当"没给"处理，走 fallback。 */
function parseWeight(seg, fallback) {
  const s = String(seg == null ? '' : seg).replace(/[^\d.]/g, '').trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : fallback;
}

function parseFacts(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = stripBullet(line);
    if (!t || !t.includes('|')) continue;
    const seg = t.split('|');
    const text = String(seg[0] || '').trim();
    if (!text || text.length < 2) continue;
    const tags = String(seg[2] || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    out.push({
      text: text.slice(0, 200),
      weight: parseWeight(seg[1], 5),
      tags: tags.slice(0, 4),
    });
  }
  return out;
}

/* 抽"做事的经验"（procedure），进共有的技能长期记忆库。
 * 和 extractFacts 的区别：facts 是"主人是什么样的人"，经验是"这类事该怎么做"。
 * 输出行格式：经验|权重|技能|标签
 */
async function extractExperiences(llm, cfg, msgs, catalog) {
  const cat = String(catalog || '').trim();
  const sys = `你是一台"经验筛选器"。从下面这段主人和桌宠的对话里，挑出**下次遇到同类任务可以直接复用的做法**。

只挑这类（"怎么做事"的程序性经验）：
- 帮主人完成的具体操作任务，以及**有效的做法/步骤**
- 踩过的坑：什么做法不行、为什么、该换成什么
- 主人明确交代过的做事规矩（"以后都这样"）

**不要挑**：关于主人本人的事实、喜好、情绪、闲聊（那些另有地方存）。

${cat ? '现有技能（能把经验归到某个技能就写它的 id，否则写 none）：\n' + cat + '\n' : ''}
权重 1~10：
- 主人明确说"以后都这么做" → 9~10
- 验证过能用的完整做法 → 6~8
- 一次性的、不确定对不对的尝试 → 2~4
- 纯闲聊、没做成事 → **不要输出**

输出格式：每行一条，四段用竖线分隔，**只输出这些行**，不要编号、不要解释、不要代码块：
经验|权重|技能|标签

示例：
排查 Electron 打包后原生 exe 跑不起来：要先加进 asarUnpack|8|none|Electron,打包
主人要 commit 信息时，标题用动词开头、别罗列文件名|7|write-commit|git

如果这段对话里没有任何值得记的经验，就只输出一个空行。`;

  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: convoToText(msgs, 6000) }
  ]);
  return parseExperiences(raw);
}

function parseExperiences(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = stripBullet(line);
    if (!t || !t.includes('|')) continue;
    const seg = t.split('|');
    const text = String(seg[0] || '').trim();
    if (!text || text.length < 4) continue;
    const skill = String(seg[2] || '').trim().toLowerCase();
    const tags = String(seg[3] || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    out.push({
      text: text.slice(0, 300),
      weight: parseWeight(seg[1], 4),
      skill: (skill && skill !== 'none' && skill !== '无') ? skill : '',
      tags: tags.slice(0, 4),
    });
  }
  return out;
}

/* 人设演化：让桌宠的"人设"随着经历自然成长（不是重写，是被经历慢慢改变）。
 * 返回 { changed, reason, fields }；fields 只包含要改的字段（完整新内容）。
 * 锁住的字段由调用方过滤，这里也会在提示词里明说"不许改"。
 */
async function evolvePersona(llm, cfg, args) {
  const a = args || {};
  const p = a.persona || {};
  const show = (k, label) => (p[k] ? label + '：' + String(p[k]) + '\n' : '');
  const current =
    show('name', '名字') + show('world_setting', '世界观') + show('character_setting', '人物设定')
    + show('personality', '性格') + show('catchphrase', '口头禅') + show('hidden_setting', '隐藏设定');

  const sys = `你负责让一个桌宠的"人设"随着经历自然成长——不是重写，而是像人一样，被经历慢慢改变。

【现在的人设】
${current}
【最近的经历（长期记忆 / 日记）】
${a.diary || '（还没有）'}

【已经确认为永久记忆的事】
${a.facts || '（还没有）'}

【当前状态】好感度 ${a.affection == null ? '?' : a.affection}/100，心情 ${a.mood == null ? '?' : a.mood}/100
【锁住的字段（绝对不能改）】${a.lockNote || '（无）'}

请判断：这些经历是否足以让她的人设发生一点变化？
- **大多数时候应该是"不用改"**——人设不该天天变，没有分量就不要动
- 小事 → 最多微调"口头禅"或"性格"的措辞
- 只有记忆里出现**分量足够重**的经历（长期相处形成的默契、重要事件、主人明确的态度反复出现）→ 才可以动"世界观""人物设定"，甚至"隐藏设定"
- 核心不能丢：她基本还是那个她

只输出一个 JSON，不要 markdown、不要解释：
{ "changed": true 或 false, "reason": "一句话说明为什么（给人看的）", "fields": { "字段名": "新的完整内容" } }

要求：
- 不改的字段**不要**出现在 fields 里；changed 为 false 时 fields 写成 {}
- fields 里写**完整的新内容**，不是补丁、不是 diff
- 锁住的字段**绝对不能**出现在 fields 里`;

  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: '请判断并输出 JSON。' }
  ]);
  const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < 0) return { changed: false, reason: '', fields: {} };
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    return {
      changed: !!o.changed,
      reason: String(o.reason || '').slice(0, 200),
      fields: (o.fields && typeof o.fields === 'object') ? o.fields : {},
    };
  } catch { return { changed: false, reason: '', fields: {} }; }
}

/* 会话结束：判断桌宠的内在数值该怎么变（-2 ~ +2，绝大多数应该是 0）
 * 长期陪伴向——变化要非常小，人设会影响"同样的事对她意味着什么"。
 */
async function judgeStats(llm, cfg, msgs, persona, current) {
  const p = persona || {};
  const cur = current || {};
  const list = ['affection:好感度', 'mood:心情度', 'dependency:依赖度', 'extraversion:外向度',
    'emotionality:感性度', 'directness:直白度', 'iq:IQ', 'diligence:认真度'];
  const sys = `你负责判断：这段对话之后，这个桌宠的内在数值各自该怎么变。

【她是谁】
名字：${p.name || '大肥鱼'}
人物设定：${p.character_setting || '蓝发鲸鱼女仆，傲娇、温柔、嘴硬'}
性格：${p.personality || '傲娇、温柔、嘴硬'}

【当前数值】
${list.map((x) => { const [k, label] = x.split(':'); return '- ' + label + '：' + (cur[k] == null ? 50 : cur[k]); }).join('\n')}

【这次对话】
${convoToText(msgs, 6000)}

判断要求（长期陪伴为核心）：
- 每个数值给 -2 ~ +2 的变化，**绝大多数应该是 0**。人设不该天天变，没有明确信号就别动
- 只有对话里出现**明确而强烈**的信号才动：被夸奖、被斥责、被冷落很久、深入的心里话、一起做成/搞砸了事情
- 同样的对话，对不同人设意味着不同的事（傲娇可能嘴上顶回去、心里其实很高兴）
- 参考：做成事 → IQ/认真度略升；被斥责做不好 → IQ/心情略降；被陪伴/被需要 → 依赖度升；长时间没人理 → 依赖度升、心情降

只输出一个 JSON，不要 markdown：
{ "reason": "一句话说明为什么这么变（给人看的）", "deltas": { ${list.map((x) => '"' + x.split(':')[0] + '": 0').join(', ')} } }`;

  const raw = await llm.request(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: '请判断并输出 JSON。' }
  ]);
  const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < 0) return { reason: '', deltas: {} };
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    const d = {};
    for (const [k, v] of Object.entries(o.deltas || {})) {
      const n = Number(v) || 0;
      if (n) d[k] = Math.max(-2, Math.min(2, n));
    }
    return { reason: String(o.reason || '').slice(0, 200), deltas: d };
  } catch { return { reason: '', deltas: {} }; }
}

module.exports = { summarize, diary, extractFacts, parseFacts, extractExperiences, parseExperiences, evolvePersona, judgeStats, convoToText };
