/**
 * 上下文交接笔记（handoff note）。
 *
 * 为什么需要：
 *   - 会话 JSONL 会一直增长，但模型的上下文窗口有限；
 *   - 超过软阈值后，把「较早的那段对话」压成一篇 Markdown 笔记写进工作区 handoffs/，
 *     会话元数据里记下 contextStart —— 之后每轮只带 contextStart 之后的消息 + 这篇笔记；
 *   - 细节不靠笔记全记住：笔记里明确写「去工作区文件里找」，配合工作区记忆长期保存。
 *
 * 与 Coo 的差别（见 docs/记忆移植来源.md）：
 *   - Coo 的 handoffNote 由模型渲染、含 tool call / 回执 / 语音调用等富结构；
 *   - petd 这里是机械摘录（用户/助手文本 + 截断），更省 token、可预期、无需额外 LLM 调用。
 */
import type { StoredMessage } from './store.js';

/** 机器可读的笔记类型（与 Coo 的 HANDOFF_NOTE_TYPE 对齐，便于以后做 UI/检索） */
export const HANDOFF_TYPE = 'handoff-note';

/** 单条摘录的默认字符上限（最近一条） */
export const ENTRY_MAX_CHARS = 600;
/** 折叠时单条摘录的下限 */
export const ENTRY_MIN_CHARS = 120;
/** 头部固定开销预留 */
const HEADER_RESERVE = 320;

/** 粗估 token：中文/英文混排按 3 字符≈1 token 计，另每条消息固定开销 8 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content) + 8;
  return total;
}

/** UTC 时间戳 → 文件名安全形式：2026-11-15T08-10-00Z（无冒号/点，Git/glob 都安全） */
export function handoffStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[:]/g, '-');
}

/** 笔记相对工作区的路径：<dir>/<stamp>.md */
export function handoffPath(dir: string, now: Date = new Date()): string {
  const clean = dir.trim().replace(/^\/+|\/+$/g, '');
  return clean ? clean + '/' + handoffStamp(now) + '.md' : handoffStamp(now) + '.md';
}

export interface RenderedHandoff {
  /** 完整 Markdown 笔记 */
  content: string;
  /** 收进笔记的消息条数 */
  entries: number;
  /** 因预算被折叠掉的消息条数 */
  folded: number;
}

export interface RenderHandoffOptions {
  /** 被压缩的那段消息（不含当前轮用户输入） */
  messages: StoredMessage[];
  /** 笔记字符上限（含头部） */
  maxChars: number;
  /** 会话标题，只用于抬头 */
  sessionTitle?: string;
  now?: Date;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shortTime(ts: string): string {
  if (!ts) return '';
  // ISO：2026-11-15T08:10:00.000Z → 08:10
  const m = /T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : '';
}

/**
 * 把一段消息机械渲染成交接笔记。
 *
 * 预算策略：从最新往旧收，单条先按 ENTRY_MAX_CHARS 截断；总长超出上限后，
 * 后续更旧的条目按「剩余预算 / 剩余条数」递减截断，直到 ENTRY_MIN_CHARS，
 * 还放不下就整条丢弃并计数（抬头里会写「更早的 N 条已折叠」）。
 */
export function renderHandoffNote(opts: RenderHandoffOptions): RenderedHandoff {
  const now = opts.now ?? new Date();
  const messages = opts.messages;
  const maxChars = Math.max(1000, opts.maxChars);
  const firstTs = messages.find((m) => m.ts)?.ts ?? '';
  const lastTs = [...messages].reverse().find((m) => m.ts)?.ts ?? '';

  const header: string[] = [
    '# 交接笔记 ' + handoffStamp(now),
    '',
    '- 会话' + (opts.sessionTitle ? '：' + opts.sessionTitle : ''),
    '- 时间：' + (shortTime(firstTs) || '?') + ' → ' + (shortTime(lastTs) || '?'),
    '- 说明：下面是更早对话的机械摘录；细节不一定完整，请用 read_file / grep_files 在工作区文件里核对。',
    '',
  ];

  const lines: string[] = [];
  let dropped = 0;
  let headLen = header.join('\n').length + 64;
  const available = Math.max(400, maxChars - HEADER_RESERVE);

  // 从新到旧收
  let used = 0;
  let budgetPer = ENTRY_MAX_CHARS;
  const picked: Array<{ idx: number; line: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const body = cleanText(msg.content);
    if (!body) continue;
    const remain = messages.length - picked.length;
    const cap = Math.min(ENTRY_MAX_CHARS, Math.max(ENTRY_MIN_CHARS, Math.floor((available - used) / Math.max(1, remain))));
    budgetPer = cap;
    const clipped = body.length > cap ? body.slice(0, cap) + '…' : body;
    const tag = msg.role === 'user' ? '主人' : '我';
    const when = shortTime(msg.ts);
    const line = '- ' + (when ? '[' + when + '] ' : '') + tag + '：' + clipped;
    if (used + line.length + headLen > maxChars) {
      dropped += 1;
      continue;
    }
    used += line.length + 1;
    picked.push({ idx: i, line });
  }

  picked.reverse();
  lines.push(...picked.map((p) => p.line));
  if (dropped > 0) lines.push('- …（更早的 ' + dropped + ' 条已折叠）');
  void budgetPer;

  const content = header.concat(lines).join('\n') + '\n';
  return { content, entries: picked.length, folded: dropped };
}

// ── LLM 摘要版：让模型把旧对话整理成一篇「记得住事」的笔记 ──────────────────────

/** 摘要太短视为无效（模型敷衍/只回一句废话），回退机械摘录 */
const SUMMARY_MIN_CHARS = 40;

export interface HandoffSummaryPromptOptions {
  /** 被压缩的那段消息（不含当前轮用户输入） */
  messages: StoredMessage[];
  sessionTitle?: string;
  /** 摘要正文的字符上限（不含抬头） */
  maxChars: number;
}

/**
 * 给「整理交接笔记」的模型提示词。
 *
 * 关键取舍：输出的是给「未来的自己」看的记忆，不是给用户看的总结——
 * 所以要保留人物/关系/承诺/待办/偏好/事实/未完成事项/时间点，允许省略寒暄与重复。
 */
export function buildHandoffSummaryPrompt(opts: HandoffSummaryPromptOptions): { system: string; user: string } {
  const messages = opts.messages;
  const transcript: string[] = [];
  for (const msg of messages) {
    const body = cleanText(msg.content);
    if (!body) continue;
    const tag = msg.role === 'user' ? '主人' : '我';
    const when = shortTime(msg.ts);
    transcript.push('- ' + (when ? '[' + when + '] ' : '') + tag + '：' + body.slice(0, 800));
  }
  const system = [
    '你是桌宠的「记忆整理员」。把下面这段更早的对话压缩成一篇交接笔记，交给未来的自己。',
    '只输出 Markdown 正文，不要解释、不要代码围栏、不要复述全部对话。',
    '必须保留：主人是谁/怎么称呼、我们之间的关系与相处细节、主人的偏好与雷点、我答应过或没做完的事、重要日期与计划、值得记住的事实。',
    '可以省略：寒暄、重复、已经被后续消息否定的内容。',
    '按主题分小节（例如「## 关于主人」「## 待办与承诺」「## 相处细节」），每节 1–5 条短句；不确定的细节写「不确定」，绝不编造。',
    '总长不超过 ' + Math.max(200, opts.maxChars) + ' 字。',
  ].join('\n');
  const user = [
    opts.sessionTitle ? '会话：' + opts.sessionTitle : '会话：（未命名）',
    '',
    '对话原文：',
    transcript.join('\n'),
  ].join('\n');
  return { system, user };
}

/** 清洗模型返回：去代码围栏与首尾废话；太短/空返回 null。 */
export function cleanHandoffSummary(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fence && fence[1]) text = fence[1].trim();
  text = text.replace(/^#\s*交接笔记[^\n]*\n+/i, '').trim();
  if (text.length < SUMMARY_MIN_CHARS) return null;
  return text;
}

export interface RenderSummaryHandoffOptions {
  /** 模型整理出的摘要正文（已清洗） */
  summary: string;
  /** 被压缩的那段消息（只用来算时间范围与条数） */
  messages: StoredMessage[];
  sessionTitle?: string;
  now?: Date;
  /** 压进这篇笔记的消息条数 */
  compressed: number;
  /** 保留在原上下文里的消息条数 */
  kept: number;
}

/**
 * 用模型整理的摘要渲染交接笔记：抬头格式与机械版一致（第一行都是 `# 交接笔记 …`），
 * 目的让「解析笔记」的代码/UI 不用区分两种模式。
 */
export function renderSummaryHandoffNote(opts: RenderSummaryHandoffOptions): RenderedHandoff {
  const now = opts.now ?? new Date();
  const messages = opts.messages;
  const firstTs = messages.find((m) => m.ts)?.ts ?? '';
  const lastTs = [...messages].reverse().find((m) => m.ts)?.ts ?? '';
  const header: string[] = [
    '# 交接笔记 ' + handoffStamp(now),
    '',
    '- 会话' + (opts.sessionTitle ? '：' + opts.sessionTitle : ''),
    '- 时间：' + (shortTime(firstTs) || '?') + ' → ' + (shortTime(lastTs) || '?'),
    '- 范围：压缩了 ' + opts.compressed + ' 条更早的消息，最近 ' + opts.kept + ' 条仍在当前上下文里。',
    '- 说明：下面是「由我自己整理的摘要」，可能漏掉细节；需要核对原文时用 read_file / grep_files 去工作区文件里找。',
    '',
    '## 摘要',
    '',
    opts.summary.trim(),
    '',
  ];
  return { content: header.join('\n') + '\n', entries: opts.compressed, folded: 0 };
}

