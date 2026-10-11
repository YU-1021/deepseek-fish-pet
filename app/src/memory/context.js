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
 *
 * 【2026-10 改造，抄自参考项目 Coopanion/Cortico 的"交接笔记"设计】
 * 原来只有一个"超预算就停"的硬闸门，导致两个毛病：
 *   ① **重复刷屏**：同一条失败（同一工具同一报错）连着出现十几次，全部原样占预算 ——
 *      她读到的历史里最显眼的就是"我又失败了"，于是学会放弃（实测她在 3 秒内回"还是那堵墙"，根本没试）。
 *   ② **均匀截断**：老的记录要么整条在、要么整条丢，而不是"越老留得越少"。
 * 现在：
 *   - 逐字相同的记录**合并计数**，只保留最后一次（渲染成"同样内容重复了 N 次"）；
 *   - 保留额度按**年龄衰减**：离现在越远，单条裁得越狠（而不是整条消失）；
 *   - 助手自己的失败叙述由 memory/jobs.js 的摘要提示词负责排除（那边是源头）。
 */
const AGE_SOFT = 12;      // 距现在多少条之后开始额外裁剪
const AGE_HARD = 40;      // 再往后裁得更狠

function pickHistory(msgs, budgetTokens, keepFull) {
  const list = Array.isArray(msgs) ? msgs : [];
  const keep = Number(keepFull) || 3;
  const budget = Number(budgetTokens) || 6000;
  const out = [];
  let used = 0;
  let assistantSeen = 0;
  /* 逐字重复合并：键统一成"角色 + 前 160 字"，只留最后一次，其余只记次数 */
  const seen = new Map();
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
    /* 年龄衰减：越远的单条留得越少（原先只有"整条留/整条丢"） */
    if (distFromNewest > AGE_SOFT && typeof content === 'string' && content.length > 300) {
      content = tokens.clip(content, distFromNewest > AGE_HARD ? 80 : 160);
    }
    /* 重复合并：同一条内容第二次出现时，把前一次替换成"（重复 N 次）"标记 */
    const key = String(m.role || '') + '|' + String(content || '').slice(0, 160);
    const dup = seen.get(key);
    if (dup && typeof content === 'string' && content.length > 12) {
      dup.n++;
      dup.entry.content = dup.base + '\n（上面这条内容在历史里重复了 ' + dup.n + ' 次）';
      continue;                                  // 不再重复占用预算
    }
    const cost = tokens.est(content) + 4;
    if (out.length && used + cost > budget) break;
    used += cost;
    const entry = { role: m.role, content };
    if (typeof content === 'string' && content.length > 12) {
      seen.set(key, { n: 1, base: content, entry });
    }
    out.unshift(entry);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = { build, pickHistory };
