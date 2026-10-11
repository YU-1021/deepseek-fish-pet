/* surface 投影（只追加的事件日志 + 可替换的投影）—— 抄自 DSH 的 dsh-session / dsh-compaction
 *
 * 【为什么】现在的做法是 tokens.clip() **就地截断**：历史被改掉之后就再也查不回来
 *   "她当时到底看到了什么"。出了问题只能靠猜。
 *
 * 【DSH 怎么做】
 *   · 会话是**只追加**的递增 seq 事件日志（dsh-session）；模型看到的不是日志本身，
 *     而是一个叫 `surface` 的**投影**（dsh-compaction/lib/types/index.js:44 只声明
 *     "把一段 surface 换成摘要节点"，触发策略/保留策略/摘要实现分属不同包）；
 *   · 剪枝（dsh-compaction-tool-result-pruner/lib/index.js:137）**先追加**一条
 *     `compaction/prune`（记下 shadowedSeqs 与省下多少 token），**再追加**一条替代事件
 *     （`surfaceOp:{op:'replace',startSeq,endSeq}` + `sourceEventSeqs`）；
 *   · 于是：**历史永不改写、永远可回放**，而"模型看到什么"随时可以重算。
 *
 * 【本模块】把这两件事分开：
 *   ① `append(ev)` —— 只追加，绝不修改已有事件；
 *   ② `project()` —— 从头重算"模型该看到什么"，把历次 prune 依次应用上去。
 *   另有 `prune()` 负责**决定**剪掉哪一段，并把决定本身作为事件记下来（可审计）。
 *   纯逻辑、无依赖 → 可以纯 Node 测试（见 app/scripts/test-surface.js）。
 */
'use strict';

const DEF = {
  maxInlineChars: 8192,   // 单条超过这个长度就值得剪
  /* 最近几条永远保留。默认只留 2 条 —— 理由是实测：真实场景里**最长的输出往往就是刚来的那条**
     （一次 screen_look / watch_screen 的结果），如果保留窗口开大，最该剪的反而剪不掉。
     刚来的那条由 spill（大输出溢出到文件）负责保住原文，这里只负责把**更早的**长条目折叠掉。
     （按 DSH 的分工：触发策略是独立的一层，所以这个值是配置，调用方可以按场景改。） */
  keepRecent: 2,
  minSaveChars: 200,      // 剪了省不到这么多就别剪（避免为小事留一堆事件）
};

function create(opts) {
  const o = Object.assign({}, DEF, opts || {});
  const log = [];          // 只追加
  let seq = 0;

  /* 追加一个事件。返回它的 seq。
   * 事件形状：{ seq, kind, ... }
   *   kind:'msg'    { role, content }
   *   kind:'tool'   { role:'user', content, tool }
   *   kind:'prune'  { op:'replace', fromSeq, toSeq, shadowedSeqs, savedChars, reason, summary }
   *                  —— summary 就是替代节点（那一小段摘要），它**取代** fromSeq..toSeq 这一段的呈现 */
  function append(ev) {
    const e = Object.assign({}, ev || {});
    e.seq = ++seq;
    log.push(e);
    return e.seq;
  }

  function events() { return log.map((e) => Object.assign({}, e)); }   // 拷贝出去，外部改不动内部

  /* 重算"模型该看到什么"。返回节点数组（每个节点带 sourceSeqs 便于追溯）。 */
  function project() {
    /* 先收集所有替代操作（按 seq 顺序，后来的覆盖先前的 —— 后剪的优先级更高） */
    const ops = [];
    for (const e of log) {
      if (e.kind === 'prune' && e.op === 'replace') {
        ops.push({ from: e.fromSeq, to: e.toSeq, summary: e.summary, by: e.seq, reason: e.reason });
      }
    }
    const hidden = new Map();     // seq → 取代它的 prune 事件 seq
    const inserted = new Map();   // 插在哪个 seq 之后 → summary 节点
    for (const op of ops) {
      for (let s = op.from; s <= op.to; s++) hidden.set(s, op.by);
      inserted.set(op.to, { role: 'user', content: op.summary, pruned: true, by: op.by, reason: op.reason, sourceSeqs: [op.from, op.to] });
    }
    const out = [];
    for (const e of log) {
      if (hidden.has(e.seq)) {
        /* 被隐藏的事件不直接出现；但如果它是某个替代操作的"锚点"，就在这个位置插入摘要节点 */
        if (inserted.has(e.seq)) out.push(inserted.get(e.seq));
        continue;
      }
      if (e.kind === 'prune') continue;      // prune 事件本身不进投影（它是元数据）
      out.push({ role: e.role, content: e.content, seq: e.seq, tool: e.tool, sourceSeqs: [e.seq] });
    }
    return out;
  }

  /* 决定剪哪一段，并把决定记为事件。
   * 返回 { ok, seq?, pruned?, savedChars?, reason? }
   * 规则：只剪**单条过长**的（> maxInlineChars），且**不动最近 keepRecent 条**。 */
  function prune(extra) {
    const cfg = Object.assign({}, o, extra || {});
    const visible = project();
    const visibleSeqSet = new Set(visible.map((v) => v.seq));
    const tail = visible.slice(-cfg.keepRecent).map((v) => v.seq);
    const tailSet = new Set(tail);
    /* 挑一条：够长、还有正文、不在最近保留区里 */
    let pick = null;
    for (const e of log) {
      if (e.kind === 'prune') continue;
      if (!visibleSeqSet.has(e.seq)) continue;      // 已经被剪过
      if (tailSet.has(e.seq)) continue;             // 最近的要留
      const len = String(e.content == null ? '' : e.content).length;
      if (len <= cfg.maxInlineChars) continue;
      if (!pick || len > pick.len) pick = { seq: e.seq, len, ev: e };
    }
    if (!pick) return { ok: true, pruned: false, reason: '没有需要剪的（要么都不长，要么只剩最近几条）' };
    const saved = pick.len - 200;
    if (saved < cfg.minSaveChars) return { ok: true, pruned: false, reason: '剪了也省不下多少（省 ' + saved + ' 字符 < ' + cfg.minSaveChars + '）' };
    const summary = '（这里原本有一条很长的工具结果，' + pick.len + ' 字符，已被折叠；'
      + '需要看原文请按时间点查会话日志 / 溢出文件。）';
    const s = append({
      kind: 'prune', op: 'replace', fromSeq: pick.seq, toSeq: pick.seq,
      shadowedSeqs: [pick.seq], savedChars: saved, reason: cfg.reason || 'tool-result-too-long', summary,
    });
    return { ok: true, pruned: true, seq: s, shadowed: pick.seq, savedChars: saved };
  }

  /* 一直剪到没有可剪的（每剪一次都会重算投影，所以不会重复剪同一条） */
  function pruneAll(extra) {
    const done = [];
    for (let i = 0; i < 200; i++) {
      const r = prune(extra);
      if (!r.ok || !r.pruned) return { ok: true, count: done.length, rounds: done, last: r.reason || '' };
      done.push(r);
    }
    return { ok: true, count: done.length, rounds: done, last: '达到单次上限' };
  }

  function stats() {
    const p = project();
    const raw = log.filter((e) => e.kind !== 'prune');
    const chars = (arr) => arr.reduce((n, e) => n + String(e.content == null ? '' : e.content).length, 0);
    return {
      events: log.length,
      prunes: log.filter((e) => e.kind === 'prune').length,
      rawNodes: raw.length,
      visibleNodes: p.length,
      rawChars: chars(raw),
      visibleChars: chars(p),
      savedChars: chars(raw) - chars(p),
    };
  }

  return { append, events, project, prune, pruneAll, stats, config: o };
}

module.exports = { create, DEFAULTS: DEF };
