/* 上下文装配
 * 顺序故意固定成「稳定内容在前、易变内容在后」：
 *   永久记忆 → 日记 → 中期摘要
 * 这样 DeepSeek 的前缀缓存能命中尽量长的前缀（省钱的关键命门）。
 *
 * 另外这里要守住**总量**：三块加起来必须有上限。以前只按"条数 × 单条长度"算，
 * 永久记忆攒到几十条时，注入块单独就能超过历史预算，而且没有任何裁剪。
 */
const tokens = require('../tokens');
const permanent = require('./permanent');
const long = require('./long');
const medium = require('./medium');

/* 工具/系统记录（技能说明、截图文字、脚本输出…）在历史里的标记 */
const SYS_MARK = /^\s*\[系统\]/;
const SYS_CLIP_MARK = '\n（系统记录，已压缩）';

function build(cfg) {
  const m = (cfg && cfg.memory) || {};
  const inj = m.inject || {};
  const budget = Math.max(500, Math.min(8000, Number(inj.totalChars) || 2400));

  const facts = permanent.topFacts(inj.permanentFacts || 40)
    .map((f) => String(f.text || '').trim()).filter(Boolean);
  const longs = long.list().slice(-(inj.longDays || 3))
    .map((e) => '- [' + e.date + '] ' + tokens.clip(e.diary, inj.longChars || 300));
  const meds = medium.list().slice(-(inj.mediumCount || 6))
    .map((e) => '- ' + tokens.clip(e.summary, inj.mediumChars || 200));

  const secF = () => (facts.length ? '# 永久记忆（关于主人的关键要点，你绝不会忘）\n' + facts.map((t) => '- ' + t).join('\n') : '');
  const secL = () => (longs.length ? '# 你的日记（最近几天）\n' + longs.join('\n') : '');
  const secM = () => (meds.length ? '# 最近的会话（今天）\n' + meds.join('\n') : '');
  const total = () => secF().length + secL().length + secM().length;

  /* 超预算就从最不重要的开始丢：中期摘要 → 日记 → 永久记忆。
     丢的时候各自丢"最旧/最不重要"的那一端。 */
  while (total() > budget && meds.length) meds.shift();
  while (total() > budget && longs.length) longs.shift();
  while (total() > budget && facts.length) facts.pop();

  const parts = [secF(), secL(), secM()].filter(Boolean);
  return parts.length ? '\n' + parts.join('\n\n') + '\n' : '';
}

/* 历史按 token 预算裁剪：
 *  - 从最新往旧累计，超预算就停（装得下就全发 → 接近 DeepSeek 的连贯感）
 *  - 最近 keepFull 条助手回合保留完整格式（格式锚，防模型退化）
 *  - 更老的助手回合压成 compact
 *  - **老的工具/系统记录也要压**：以前只压缩 assistant 消息，user 角色的工具结果
 *    （技能说明、截图文字、脚本输出）永远原文保留 —— 加载一个技能约 1000 token，
 *    而整个历史预算才 3000，真实对话就这样被一点点挤出去了。
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
    const distFromNewest = list.length - 1 - i;
    let content = m.content;
    if (isAssistant) {
      assistantSeen++;
      if (assistantSeen > keep && m.compact) content = m.compact;
    } else if (distFromNewest > 4 && typeof content === 'string'
      && content.length > 400 && SYS_MARK.test(content)) {
      content = tokens.clip(content, 240) + SYS_CLIP_MARK;
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
