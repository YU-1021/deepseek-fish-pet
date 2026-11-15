/* stoplog.js —— ★把"这一轮为什么停"记下来★（照 DSH 把停止原因写进 turn/end）
 *
 * 【为什么】loop.js 早就把停止原因算成**显式的联合类型**了
 *   （completed / step-budget / look-streak / no-result / no-next / aborted / error），
 *   但它原来**只活在内存里**、只跟着 stats:task 走一圈：
 *   主人想知道"她上一轮为什么停"没有地方可查 —— 今天就是靠手工分类 16 条失败才判断出问题的 ✗。
 *   DSH 的做法是把联合类型写进 turn/end（typert.host.js:803、agent-loop/lib/index.js:1027-1030），
 *   也就是**会话日志**（每步都从会话日志重新出发）。这里照做，落到两个地方：
 *     · 会话日志（memory/session.js 的只追加事件流 → %APPDATA%/dayu-pet/memory/session.json）
 *       —— 长期档案、可回放、grep 得到 ✓
 *     · testlog（结构化测试日志）—— 方便统计"她都是因为什么停的" ✓
 *
 * 【两条硬规矩】
 *   1. ★写进会话日志的是**元数据事件**（kind:'stop'），surface 的投影会跳过它★ ——
 *      它绝不进模型看到的对话历史（不然会多出一条没有 role 的空消息，把模型教坏 ✗）。
 *   2. 本模块**绝不抛错**：记账失败不能影响任务本身（和 testlog 的约定一致）。
 */
'use strict';

/* ★照抄 DSH 的联合类型数量（7 个）★：
   DSH = completed | max-tokens | blocked | aborted | error | interrupted | forked
   （今天的对照文档 DSH-对照.md:239 也写了这一条 —— 桌宠这边结构对、数量对，
    只是以前**没有持久化**）。
   桌宠按自己的实际情况取名，见 renderer/loop.js 的 REASONS。
   ★2026-10-10 补第 8 个：`interrupted`★ —— 主人要"界面上的停止按钮 + 全局快捷键"✓，
   那条路与"她在聊天里被喊停"（aborted ✓）不是同一件事 ✓，
   DSH 里这两个也确实是两个不同的值（`aborted` 带 abortSignal.reason ✓、
   `interrupted` 是外部中断 ✓）→ 分开记，事后 grep 才分得清是谁停的 ✓。
   ★2026-10-10 再补第 9 个：`idle-restore`★ —— "任务**期**结束"（不是"循环结束" ✗）：
   连续一段时间没有任何推进（她没说话、没调工具、循环也早已给出停止原因 ✓）→ 恢复对话窗 ✓。
   ★真机 bug★：这条以前**根本不记**✗（真机查过 session.json 里没有对应事件 ✓）——
   所以"任务期为什么结束了"根本查不到 ✓。
   ⚠️ loop.REASONS 与这张表**必须同一套**（app/scripts/probe-stoplog.js 会断言 ✓）。
   不在表里的原因不算错 —— 照实记下来并打一个 unknownReason 标记：
   "没登记的第三方原因"和"没有原因"是两件事，不能混。 */
const KNOWN = ['completed', 'step-budget', 'look-streak', 'no-result', 'no-next', 'aborted', 'error', 'interrupted', 'idle-restore'];

function noteStop(o) {
  const src = o || {};
  const reason = String(src.stopReason || src.reason || '');
  if (!reason) return { ok: false, wrote: false, reason: 'empty-reason' };
  const rec = { reason, ok: !!src.ok };
  if (src.steps != null) rec.steps = Number(src.steps) || 0;
  if (src.lookStreak != null) rec.lookStreak = Number(src.lookStreak) || 0;
  if (src.task) rec.task = String(src.task).slice(0, 60);
  /* ★停止来源（2026-10-10）★：interrupted 是"外部强制停"✓ ——
     到底是谁停的（界面按钮 / 全局快捷键 / 聊天里的"停"✓）必须一起记下来 ✓，
     不然事后只知道"被外部停了"，还是查不出是哪条路 ✓。 */
  if (src.via) rec.via = String(src.via).slice(0, 24);
  const known = KNOWN.indexOf(reason) >= 0;
  if (!known) rec.unknownReason = true;
  try { require('./testlog').log('loop', 'stop', { reason, ok: rec.ok, steps: rec.steps }); } catch (e) {}
  let seq = null;
  try { seq = require('./memory/session').mark(Object.assign({ kind: 'stop' }, rec)); } catch (e) {}
  return { ok: true, wrote: true, reason, known, seq, rec };
}

module.exports = { noteStop, KNOWN };
