/* 上下文装配
 * 顺序故意固定成「稳定内容在前、易变内容在后」：
 *   永久记忆 → 日记 → 中期摘要
 * 这样 DeepSeek 的前缀缓存能命中尽量长的前缀（省钱的关键命门）。
 */
const tokens = require('../tokens');
const permanent = require('./permanent');
const long = require('./long');
const medium = require('./medium');

function build(cfg) {
  const m = (cfg && cfg.memory) || {};
  const inj = m.inject || {};
  const parts = [];

  const facts = permanent.topFacts(inj.permanentFacts || 40);
  if (facts.length) {
    parts.push('# 永久记忆（关于主人的关键要点，你绝不会忘）\n' +
      facts.map((f) => '- ' + f.text).join('\n'));
  }

  const longs = long.list().slice(-(inj.longDays || 3));
  if (longs.length) {
    parts.push('# 你的日记（最近几天）\n' +
      longs.map((e) => '- [' + e.date + '] ' + tokens.clip(e.diary, inj.longChars || 300)).join('\n'));
  }

  const meds = medium.list().slice(-(inj.mediumCount || 6));
  if (meds.length) {
    parts.push('# 最近的会话（今天）\n' +
      meds.map((e) => '- ' + tokens.clip(e.summary, inj.mediumChars || 200)).join('\n'));
  }

  return parts.length ? '\n' + parts.join('\n\n') + '\n' : '';
}

/* 历史按 token 预算裁剪：
 *  - 从最新往旧累计，超预算就停（装得下就全发 → 接近 DeepSeek 的连贯感）
 *  - 最近 keepFull 条助手回合保留完整格式（格式锚，防模型退化）
 *  - 更老的助手回合压成 compact（只留 EN:），体积能砍掉约 2/3
 *  - 裁完保证第一条是 user（部分接口对首条 role 敏感）
 */
function pickHistory(msgs, budgetTokens, keepFull) {
  const list = Array.isArray(msgs) ? msgs : [];
  const keep = Number(keepFull) || 3;
  const budget = Number(budgetTokens) || 6000;
  const out = [];
  let used = 0;
  let assistantSeen = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const isAssistant = m.role === 'assistant';
    let content = m.content;
    if (isAssistant) {
      assistantSeen++;
      if (assistantSeen > keep && m.compact) content = m.compact;
    }
    const cost = tokens.est(content) + 4;
    if (out.length && used + cost > budget) break;
    used += cost;
    out.unshift({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = { build, pickHistory };
