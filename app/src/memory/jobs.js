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

function parseFacts(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*•\d.、)）\s]+/, '');
    if (!t || !t.includes('|')) continue;
    const seg = t.split('|');
    const text = String(seg[0] || '').trim();
    if (!text || text.length < 2) continue;
    const weight = Number(String(seg[1] || '').replace(/[^\d.]/g, ''));
    const tags = String(seg[2] || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    out.push({
      text: text.slice(0, 200),
      weight: Number.isFinite(weight) ? Math.max(1, Math.min(10, weight)) : 5,
      tags: tags.slice(0, 4),
    });
  }
  return out;
}

module.exports = { summarize, diary, extractFacts, parseFacts, convoToText };
