/**
 * 蒸馏记忆注入：把「永久事实 / 日记 / 会话摘要」三层压进聊天系统提示词。
 *
 * 形状移植自旧桌宠 app/src/memory（permanent.js / long.js / medium.js / context.js）：
 * - 永久事实按权重排序（不看时间看重要性），取前 N 条；
 * - 日记按日期倒序取最近 N 天；
 * - 会话摘要按时间倒序取最近 N 条；
 * - 三层顺序固定「事实 → 日记 → 摘要」（稳定内容在前，利于提示词前缀缓存）；
 * - 超预算先丢摘要、再丢日记、最后丢事实。
 *
 * 与旧实现不同的是：这些内容在 petd 里就是工作区文件（Git 版本化、可审计、可手改），
 * 注入时只读，不改写文件；写文件由蒸馏管线（后续 slice）负责。
 */
import type { WorkspaceMemory } from './store.js';

/** 永久事实文件（Markdown 表格）。 */
export const FACTS_FILE = 'memory/facts.md';

/** 技能经验候选（第 3 阶段转正用；这里只登记路径）。 */
export const EXPERIENCES_FILE = 'memory/experiences.md';

/** 日记目录：一天一篇，文件名 YYYY-MM-DD.md。 */
export const DIARY_DIR = 'memory/diary';

/** 会话摘要目录：一次会话一条，文件名 YYYY-MM-DD-<id>.md。 */
export const MEDIUM_DIR = 'memory/medium';

/** 事实表格的表头（render 时原样写回）。 */
export const FACTS_HEADER = [
  '# 记住的事',
  '',
  '（程序按权重挑这些事实注入对话；手改也可以，一行一条，别删表头。）',
  '',
  '| 事实 | 权重 | 标签 | 出现 | 最近 |',
  '| --- | --- | --- | --- | --- |',
];

/** 技能经验候选的表头（第 3 阶段会把权重够高的提名成学习提案，等人批准）。 */
export const EXPERIENCES_HEADER = [
  '# 技能经验候选',
  '',
  '（程序从对话里整理的「怎么做事」经验；权重够高时会被提名成学习提案，主人批准后才生效。）',
  '',
  '| 经验 | 权重 | 标签 | 出现 | 最近 |',
  '| --- | --- | --- | --- | --- |',
];

export interface FactEntry {
  text: string;
  /** 1–10，越大越重要（注入时按它排序） */
  weight: number;
  tags: string[];
  /** 被提到/强化过几次 */
  hits: number;
  /** 最近一次出现（YYYY-MM-DD） */
  lastSeen: string;
}

export interface DiaryEntry {
  date: string;
  body: string;
}

export interface MediumEntry {
  date: string;
  summary: string;
  sessionId?: string;
  turns?: number;
}

/** 注入参数（config.memory.inject 的镜像，方便单测直接传）。 */
export interface InjectOptions {
  enabled: boolean;
  budgetChars: number;
  facts: number;
  factChars: number;
  diaryDays: number;
  diaryChars: number;
  medium: number;
  mediumChars: number;
}

export interface DistilledContext {
  enabled: boolean;
  /** 拼好的正文（enabled=false 或没有内容时为空串） */
  text: string;
  used: { facts: number; diary: number; medium: number };
  dropped: { facts: number; diary: number; medium: number };
}

const DEFAULT_INJECT: InjectOptions = {
  enabled: true,
  budgetChars: 7000,
  facts: 40,
  factChars: 160,
  diaryDays: 7,
  diaryChars: 320,
  medium: 8,
  mediumChars: 320,
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 把 config.memory.inject 的原始值收敛成合法参数。 */
export function normalizeInjectOptions(raw?: Partial<InjectOptions> | null): InjectOptions {
  const merged: InjectOptions = { ...DEFAULT_INJECT, ...(raw ?? {}) };
  const budget = clampInt(merged.budgetChars, 500, 8000, DEFAULT_INJECT.budgetChars);
  return {
    enabled: merged.enabled !== false,
    budgetChars: budget,
    facts: clampInt(merged.facts, 0, 200, DEFAULT_INJECT.facts),
    factChars: clampInt(merged.factChars, 40, 2000, DEFAULT_INJECT.factChars),
    diaryDays: clampInt(merged.diaryDays, 0, 60, DEFAULT_INJECT.diaryDays),
    diaryChars: clampInt(merged.diaryChars, 40, 2000, DEFAULT_INJECT.diaryChars),
    medium: clampInt(merged.medium, 0, 50, DEFAULT_INJECT.medium),
    mediumChars: clampInt(merged.mediumChars, 40, 2000, DEFAULT_INJECT.mediumChars),
  };
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[、,，/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim();
}

/** 解析表格行（事实/经验同形）；坏行忽略（不报错，注入不能因为一条坏数据挂掉）。 */
function parseTable(markdown: string, headerCell: string): FactEntry[] {
  const rows: FactEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const text = cells[0];
    if (!text || /^-+$/.test(text) || text === headerCell) continue;
    const weight = Number.parseInt(cells[1] ?? '', 10);
    rows.push({
      text,
      weight: Number.isFinite(weight) ? Math.min(10, Math.max(1, weight)) : 5,
      tags: splitTags(cells[2] ?? ''),
      hits: Number.parseInt(cells[3] ?? '', 10) || 0,
      lastSeen: cells[4] ?? '',
    });
  }
  return rows;
}

function renderTable(entries: readonly FactEntry[], header: readonly string[]): string {
  const sorted = [...entries].sort(compareFacts);
  const lines = [...header];
  for (const entry of sorted) {
    lines.push(
      `| ${escapeCell(entry.text)} | ${entry.weight} | ${entry.tags.map(escapeCell).join('、')} | ${entry.hits} | ${escapeCell(
        entry.lastSeen
      )} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 解析 memory/facts.md。 */
export function parseFacts(markdown: string): FactEntry[] {
  return parseTable(markdown, '事实');
}

/** 按权重排序渲染回 Markdown 表格（写文件时用；注入只读不写）。 */
export function renderFacts(entries: readonly FactEntry[]): string {
  return renderTable(entries, FACTS_HEADER);
}

/** 解析 memory/experiences.md（与事实同形状）。 */
export function parseExperiences(markdown: string): FactEntry[] {
  return parseTable(markdown, '经验');
}

/** 渲染技能经验候选表格。 */
export function renderExperiences(entries: readonly FactEntry[]): string {
  return renderTable(entries, EXPERIENCES_HEADER);
}

/** 排序：权重降序 → 最近出现降序 → 文本升序（同分稳定）。 */
export function compareFacts(a: FactEntry, b: FactEntry): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (a.lastSeen !== b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
  return a.text.localeCompare(b.text);
}

function safeList(memory: WorkspaceMemory, dir: string): string[] {
  try {
    return memory.walkFiles(dir);
  } catch {
    return [];
  }
}

function safeRead(memory: WorkspaceMemory, relPath: string): string {
  try {
    return memory.readFile(relPath);
  } catch {
    return '';
  }
}

function dateOf(name: string): string {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return match?.[1] ?? '';
}

/** 最近 N 天的日记（按日期倒序）。 */
export function listDiaries(memory: WorkspaceMemory, limit: number): DiaryEntry[] {
  if (limit <= 0) return [];
  const entries: DiaryEntry[] = [];
  for (const rel of safeList(memory, DIARY_DIR)) {
    if (!rel.toLowerCase().endsWith('.md')) continue;
    const date = dateOf(rel);
    if (!date) continue;
    const body = safeRead(memory, rel).trim();
    if (!body) continue;
    entries.push({ date, body });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries.slice(0, limit);
}

/** 最近 N 条会话摘要（按日期倒序）。 */
export function listMedium(memory: WorkspaceMemory, limit: number): MediumEntry[] {
  if (limit <= 0) return [];
  const entries: MediumEntry[] = [];
  for (const rel of safeList(memory, MEDIUM_DIR)) {
    if (!rel.toLowerCase().endsWith('.md')) continue;
    const date = dateOf(rel);
    const raw = safeRead(memory, rel).trim();
    if (!raw) continue;
    const summary = stripFrontmatter(raw);
    if (!summary) continue;
    const meta = parseFrontmatter(raw);
    const turns = Number.parseInt(meta.turns ?? '', 10);
    entries.push({
      date: date || meta.date || '',
      summary,
      sessionId: meta.session,
      turns: Number.isFinite(turns) ? turns : undefined,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries.slice(0, limit);
}

function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta: Record<string, string> = {};
  if (!match) return meta;
  const body = match[1] ?? '';
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function factsBlock(entries: readonly FactEntry[], opts: InjectOptions): string {
  const lines = entries.map((entry) => {
    const tags = entry.tags.length > 0 ? `（${entry.tags.join('、')}）` : '';
    return `- ${clip(entry.text, opts.factChars)}${tags}`;
  });
  return `## 记住的事（按重要性）\n\n${lines.join('\n')}`;
}

function diaryBlock(entries: readonly DiaryEntry[], opts: InjectOptions): string {
  const lines = entries.map((entry) => `- ${entry.date}：${clip(entry.body, opts.diaryChars)}`);
  return `## 最近的日记\n\n${lines.join('\n')}`;
}

function mediumBlock(entries: readonly MediumEntry[], opts: InjectOptions): string {
  const lines = entries.map((entry) => {
    const label = entry.turns !== undefined ? `${entry.date}（${entry.turns} 轮）` : entry.date;
    return `- ${label}：${clip(entry.summary, opts.mediumChars)}`;
  });
  return `## 最近的会话摘要\n\n${lines.join('\n')}`;
}

const PREAMBLE =
  '以下是从过去对话里自动整理出来的记忆（只作参考，细节以工作区文件为准；这些内容由程序维护，不要整份重写）：';

function compose(sections: readonly string[]): string {
  const body = sections.filter((s) => s.length > 0).join('\n\n');
  if (!body) return '';
  return `${PREAMBLE}\n\n${body}`;
}

/**
 * 组装注入正文：读三层文件 → 截断 → 按预算裁剪（先丢摘要、再丢日记、最后丢事实）。
 * 任何读失败都当空处理，绝不让聊天因为记忆文件坏了而报错。
 */
export function buildDistilledContext(
  memory: WorkspaceMemory,
  rawOptions?: Partial<InjectOptions> | null
): DistilledContext {
  const opts = normalizeInjectOptions(rawOptions);
  if (!opts.enabled) return { enabled: false, text: '', used: { facts: 0, diary: 0, medium: 0 }, dropped: { facts: 0, diary: 0, medium: 0 } };

  let facts = parseFacts(safeRead(memory, FACTS_FILE)).sort(compareFacts).slice(0, opts.facts);
  let diary = listDiaries(memory, opts.diaryDays);
  let medium = listMedium(memory, opts.medium);
  const dropped = { facts: 0, diary: 0, medium: 0 };

  let text = compose([
    facts.length > 0 ? factsBlock(facts, opts) : '',
    diary.length > 0 ? diaryBlock(diary, opts) : '',
    medium.length > 0 ? mediumBlock(medium, opts) : '',
  ]);

  while (text.length > opts.budgetChars) {
    if (medium.length > 0) {
      medium = medium.slice(0, -1);
      dropped.medium += 1;
    } else if (diary.length > 0) {
      diary = diary.slice(0, -1);
      dropped.diary += 1;
    } else if (facts.length > 1) {
      // 事实层至少保留 1 条最重的；全丢完就没有记忆可注入了
      facts = facts.slice(0, -1);
      dropped.facts += 1;
    } else {
      break;
    }
    text = compose([
      facts.length > 0 ? factsBlock(facts, opts) : '',
      diary.length > 0 ? diaryBlock(diary, opts) : '',
      medium.length > 0 ? mediumBlock(medium, opts) : '',
    ]);
  }

  if (text.length > opts.budgetChars) {
    // 只剩一条事实也超预算（预算被调得很小）：硬截断，避免撑爆提示词
    text = `${text.slice(0, Math.max(0, opts.budgetChars - 1)).trimEnd()}…`;
  }

  return {
    enabled: true,
    text,
    used: { facts: facts.length, diary: diary.length, medium: medium.length },
    dropped,
  };
}
