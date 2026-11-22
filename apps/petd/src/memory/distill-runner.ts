/**
 * 自动蒸馏：把一次会话的对话交给模型整理成「摘要 / 日记 / 事实 / 经验」，
 * 写进工作区 memory/ 下的三层文件（旧桌宠记忆层的第二步）。
 *
 * 设计取舍：
 *   - 只写 AI 可写的数据区（workspace/**），每个文件都走 MemoryService（自动 Git 提交 + memory.changed 事件）；
 *   - 事实按「权重 + 相似合并 + 出现次数」累积，不按时间淘汰；
 *   - 日记一天一篇，重复蒸馏只追加、不覆盖（手写内容不会被吃）；
 *   - 经验只登记成候选，转正必须走 learning 审批（第三步），这里绝不自己批准。
 */
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import type { LlmClient } from '../llm/client.js';
import type { ChatStore, Session } from '../chat/store.js';
import type { MemoryService } from './service.js';
import type { WorkspaceMemory } from './store.js';
import {
  DIARY_DIR,
  EXPERIENCES_FILE,
  FACTS_FILE,
  MEDIUM_DIR,
  parseExperiences,
  parseFacts,
  renderExperiences,
  renderFacts,
  type FactEntry,
} from './distill.js';

export interface MemoryDistillerLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
}

export interface MemoryDistillerOptions {
  memory: WorkspaceMemory;
  memoryService: MemoryService;
  llm?: LlmClient | null;
  chatStore?: Pick<ChatStore, 'get' | 'list'> | null;
  config: () => PetdConfig['memory']['distill'];
  logger?: MemoryDistillerLogger;
  now?: () => Date;
  publish?: (event: string, data: unknown) => void;
}

export interface DistillFiles {
  medium?: { path: string; commit: string | null };
  diary?: { path: string; commit: string | null };
  facts?: { path: string; commit: string | null; added: number; merged: number };
  experiences?: { path: string; commit: string | null; added: number; merged: number };
}

export interface DistillRunResult {
  ok: boolean;
  reason: string;
  sessionId?: string;
  turns: number;
  skipped?: 'too-short' | 'empty';
  files: DistillFiles;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface DistillStatus {
  enabled: boolean;
  hasLlm: boolean;
  lastRunAt?: string;
  lastError?: string;
  counters: { runs: number; factsAdded: number; factsMerged: number; experiencesAdded: number };
}

interface DistilledPayload {
  summary: string;
  diary: string;
  facts: Array<{ text: string; weight: number; tags: string[] }>;
  experiences: Array<{ text: string; weight: number; tags: string[] }>;
}

const SYSTEM_PROMPT = [
  '你是一个记忆整理器，负责把一段对话整理成长期记忆。只输出一个 JSON 对象，不要解释、不要代码块围栏。',
  '',
  'JSON 结构：',
  '{',
  '  "summary": "120 字以内的事实性摘要，只写发生了什么、结论是什么；禁止自我评价、道歉、\'我卡住了\'之类的话",',
  '  "diary": "以桌宠第一人称写的 150 字以内日记，贴合对话语气，写今天和主人做了什么、有什么感受",',
  '  "facts": [{"text": "关于主人的稳定事实/偏好/禁忌/目标/明确要求记住的事", "weight": 1-10, "tags": ["偏好"]}],',
  '  "experiences": [{"text": "怎么做某件事的可复用经验", "weight": 1-10, "tags": ["技能或场景"]}]',
  '}',
  '',
  '规则：',
  '- facts 只写「主人是什么样的人/想要什么」，不写这次对话的过程；',
  '- experiences 只写「以后遇到类似情况该怎么做」，不写具体某次操作；',
  '- 拿不准就不写；没有就给空数组；最多 5 条 facts、3 条 experiences；',
  '- weight 1–10，越重要/越稳定越高；',
  '- summary 和 diary 必须是字符串，不要留空。',
].join('\n');

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function clampWeight(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => asString(t)).filter(Boolean).slice(0, 8);
  const text = asString(v);
  if (!text) return [];
  return text
    .split(/[、,，/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function parseList(v: unknown): Array<{ text: string; weight: number; tags: string[] }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ text: string; weight: number; tags: string[] }> = [];
  for (const item of v) {
    if (isObject(item)) {
      const text = asString(item['text']);
      if (text) out.push({ text, weight: clampWeight(item['weight']), tags: parseTags(item['tags']) });
    } else if (typeof item === 'string' && item.trim()) {
      out.push({ text: item.trim(), weight: 5, tags: [] });
    }
  }
  return out;
}

/** 从模型输出里抠出 JSON（容忍代码块围栏、前后废话）。 */
function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出里找不到 JSON 对象');
  const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
  if (!isObject(parsed)) throw new Error('模型输出的 JSON 不是对象');
  return parsed;
}

function normalizePayload(raw: Record<string, unknown>): DistilledPayload {
  return {
    summary: asString(raw['summary']),
    diary: asString(raw['diary']),
    facts: parseList(raw['facts']),
    experiences: parseList(raw['experiences']),
  };
}

/** 文字相似度：字符集合 Jaccard（去标点/空白），够阈值就合并，避免同一件事反复出现。 */
export function similarity(a: string, b: string): number {
  const set = (s: string): Set<string> => {
    const clean = s.replace(/[\s\p{P}]/gu, '');
    return new Set([...clean]);
  };
  const sa = set(a);
  const sb = set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export interface MergeStats {
  added: number;
  merged: number;
}

/** 合并一组新条目到已有事实/经验：相同或相似就累加权重与出现次数，否则新增。 */
export function mergeEntries(
  existing: readonly FactEntry[],
  incoming: ReadonlyArray<{ text: string; weight: number; tags: string[] }>,
  today: string,
  threshold: number
): { entries: FactEntry[]; stats: MergeStats } {
  const entries = existing.map((e) => ({ ...e, tags: [...e.tags] }));
  let added = 0;
  let merged = 0;
  for (const item of incoming) {
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let target: FactEntry | undefined;
    for (const candidate of entries) {
      if (candidate.text === text) {
        target = candidate;
        break;
      }
      const sim = similarity(candidate.text, text);
      if (sim >= threshold || candidate.text.includes(text) || text.includes(candidate.text)) {
        target = candidate;
        break;
      }
    }
    if (target) {
      const boosted = Math.min(10, Math.round((target.weight + item.weight * 0.6) * 10) / 10);
      target.weight = boosted;
      target.hits += 1;
      target.lastSeen = today;
      target.tags = [...new Set([...target.tags, ...item.tags])].slice(0, 8);
      if (text.length > target.text.length) target.text = text;
      merged += 1;
    } else {
      entries.push({ text, weight: clampWeight(item.weight), tags: item.tags.slice(0, 8), hits: 1, lastSeen: today });
      added += 1;
    }
  }
  return { entries, stats: { added, merged } };
}

function sanitizeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'session';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function dateKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function hhmm(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 把会话消息压成一段可发给模型的对话文本（单条截断 + 总长截断，优先保留最近内容）。 */
export function buildTranscript(
  messages: ReadonlyArray<{ role: string; content: string }>,
  maxChars: number
): string {
  const lines: string[] = [];
  const perMessage = 1200;
  for (const msg of messages) {
    const who = msg.role === 'assistant' ? '桌宠' : '主人';
    const text = msg.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${who}：${text.length > perMessage ? `${text.slice(0, perMessage)}…` : text}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    // 超长时保留开头一小段 + 结尾大部分（结论通常在后面）
    const head = out.slice(0, Math.floor(maxChars * 0.3));
    const tail = out.slice(out.length - Math.floor(maxChars * 0.7));
    out = `${head}\n…（中间省略）…\n${tail}`;
  }
  return out;
}

export class MemoryDistiller {
  private readonly memory: WorkspaceMemory;
  private readonly memoryService: MemoryService;
  private readonly llm: LlmClient | null;
  private readonly chatStore: Pick<ChatStore, 'get' | 'list'> | null;
  private readonly config: () => PetdConfig['memory']['distill'];
  private readonly logger: MemoryDistillerLogger;
  private readonly now: () => Date;
  private readonly publish?: (event: string, data: unknown) => void;
  private readonly counters = { runs: 0, factsAdded: 0, factsMerged: 0, experiencesAdded: 0 };
  private lastRunAt?: string;
  private lastError?: string;

  constructor(options: MemoryDistillerOptions) {
    this.memory = options.memory;
    this.memoryService = options.memoryService;
    this.llm = options.llm ?? null;
    this.chatStore = options.chatStore ?? null;
    this.config = options.config;
    this.logger = options.logger ?? {};
    this.now = options.now ?? (() => new Date());
    this.publish = options.publish;
  }

  status(): DistillStatus {
    return {
      enabled: this.config().enabled,
      hasLlm: this.llm !== null,
      ...(this.lastRunAt === undefined ? {} : { lastRunAt: this.lastRunAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      counters: { ...this.counters },
    };
  }

  /** 蒸馏一次会话；sessionId 缺省时取最近一次有消息的会话。 */
  async run(input: { sessionId?: string; reason?: string } = {}): Promise<DistillRunResult> {
    const cfg = this.config();
    if (!cfg.enabled) throw new PetdError('E_UNAVAILABLE', '自动蒸馏已关闭（config.memory.distill.enabled=false）');
    const client = this.llm;
    if (!client) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有可用的模型客户端，无法蒸馏');

    const session = this.resolveSession(input.sessionId);
    const turns = session ? session.messages.length : 0;
    const result: DistillRunResult = {
      ok: false,
      reason: input.reason ?? 'manual',
      ...(session ? { sessionId: session.id } : {}),
      turns,
      files: {},
    };
    if (!session || turns < cfg.minMessages) {
      result.skipped = 'too-short';
      result.reason = `${result.reason}:too-short`;
      return result;
    }

    const transcript = buildTranscript(session.messages, cfg.maxInputChars);
    if (!transcript.trim()) {
      result.skipped = 'empty';
      return result;
    }

    let raw: Record<string, unknown>;
    try {
      const reply = await client.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `对话：\n${transcript}` },
        ],
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
      raw = extractJson(reply.text);
      result.usage = reply.usage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.logger.warn?.('蒸馏失败', { error: message });
      throw err;
    }

    const payload = normalizePayload(raw);
    const now = this.now();
    const today = dateKey(now);
    const stamp = hhmm(now);
    const similarityThreshold = cfg.similarity;

    const files: DistillFiles = {};

    if (payload.summary) {
      const path = `${MEDIUM_DIR}/${today}-${sanitizeSegment(session.id)}.md`;
      const content = [
        '---',
        `date: ${today}`,
        `session: ${session.id}`,
        `turns: ${turns}`,
        '---',
        '',
        payload.summary,
        '',
      ].join('\n');
      const written = await this.memoryService.write(path, content);
      files.medium = { path, commit: written.commit ?? null };
    }

    if (payload.diary) {
      const path = `${DIARY_DIR}/${today}.md`;
      const content = this.memory.exists(path)
        ? `${this.memory.readFile(path).trimEnd()}\n\n## ${stamp}\n\n${payload.diary}\n`
        : `# ${today}\n\n## ${stamp}\n\n${payload.diary}\n`;
      const written = await this.memoryService.write(path, content);
      files.diary = { path, commit: written.commit ?? null };
    }

    if (payload.facts.length > 0) {
      const existing = parseFacts(this.readSafe(FACTS_FILE));
      const merged = mergeEntries(existing, payload.facts, today, similarityThreshold);
      const written = await this.memoryService.write(FACTS_FILE, renderFacts(merged.entries));
      files.facts = { path: FACTS_FILE, commit: written.commit ?? null, ...merged.stats };
      this.counters.factsAdded += merged.stats.added;
      this.counters.factsMerged += merged.stats.merged;
    }

    if (payload.experiences.length > 0) {
      const existing = parseExperiences(this.readSafe(EXPERIENCES_FILE));
      const merged = mergeEntries(existing, payload.experiences, today, similarityThreshold);
      const written = await this.memoryService.write(EXPERIENCES_FILE, renderExperiences(merged.entries));
      files.experiences = { path: EXPERIENCES_FILE, commit: written.commit ?? null, ...merged.stats };
      this.counters.experiencesAdded += merged.stats.added;
    }

    this.counters.runs += 1;
    this.lastRunAt = now.toISOString();
    this.lastError = undefined;
    result.ok = true;
    result.files = files;
    this.logger.info?.('蒸馏完成', {
      sessionId: session.id,
      turns,
      facts: files.facts ? { added: files.facts.added, merged: files.facts.merged } : null,
      experiences: files.experiences ? { added: files.experiences.added } : null,
    });
    this.publish?.('memory.distilled', {
      sessionId: session.id,
      reason: result.reason,
      turns,
      files,
    });
    return result;
  }

  private resolveSession(sessionId?: string): Session | null {
    if (!this.chatStore) return null;
    if (sessionId) return this.chatStore.get(sessionId);
    const metas = this.chatStore.list();
    for (const meta of metas) {
      const session = this.chatStore.get(meta.id);
      if (session && session.messages.length > 0) return session;
    }
    return null;
  }

  private readSafe(relPath: string): string {
    try {
      return this.memory.readFile(relPath);
    } catch {
      return '';
    }
  }
}
