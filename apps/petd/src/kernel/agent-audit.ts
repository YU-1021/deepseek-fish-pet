/**
 * AI 动态文件的审计流水（自我迭代安全边界 INV-9）。
 *
 * - 所有写入 `.agent.*` 动态文件（SOUL.agent.md / learning/** / proposals/** /
 *   skills/staging/**）的动作都追加到 `home/state/agent-audit.jsonl`，只追加不覆盖；
 * - 每条记录带 actor、理由、前后内容 hash 与文本、行级 diff，可按文件/时间查；
 * - 人可以把某个文件回滚到某条记录之前的样子（AI 自己不能调这个方法，也没有对应工具）；
 * - 回滚本身也追加一条 audit 记录（actor=user），所以「谁把 AI 改的东西撤了」也有账。
 *
 * 审计文件本身不在写盘白名单里，AI 改不了它；文件超过 maxBytes 时轮转一份 `.1` 备份。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { agentWritePolicy } from './agent-files.js';

/** 单段文本最多落多少字（超了截断并标记） */
export const MAX_AUDIT_TEXT = 20_000;
/** 默认轮转大小（4MB） */
export const DEFAULT_MAX_BYTES = 4_000_000;
/** diff 最多输出多少行 */
const MAX_DIFF_LINES = 400;
/** LCS 表格超过这个规模就退化成「旧 N 行 / 新 M 行」摘要，避免卡死 */
const MAX_LCS_CELLS = 40_000;

export type AuditActor = 'user' | 'agent' | 'system';
export type AuditAction = 'write' | 'delete' | 'rollback';
export type AuditZone = 'agent-file' | 'memory';

export interface AuditContent {
  hash: string;
  bytes: number;
  text: string;
  /** 文本被截断（超 MAX_AUDIT_TEXT） */
  truncated?: boolean;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: AuditActor;
  action: AuditAction;
  /** 相对 home 的路径（统一 /） */
  path: string;
  zone: AuditZone;
  reason: string;
  before: AuditContent | null;
  after: AuditContent | null;
  /** 行级 diff（可能被截断） */
  diff: string;
  sessionId?: string;
}

/** 列表返回的精简记录（不带正文与 diff） */
export type AuditMeta = Omit<AuditEntry, 'before' | 'after' | 'diff'> & {
  before: Omit<AuditContent, 'text'> | null;
  after: Omit<AuditContent, 'text'> | null;
  diffChars: number;
};

export interface AuditAppendInput {
  path: string;
  actor: AuditActor;
  action: Exclude<AuditAction, 'rollback'>;
  reason?: string;
  beforeText: string | null;
  afterText: string | null;
  sessionId?: string;
}

export interface AuditListQuery {
  path?: string;
  actor?: AuditActor;
  limit?: number;
}

export interface AuditRollbackResult {
  path: string;
  /** content=恢复成旧内容；deleted=删掉（这条记录是新建文件时） */
  restored: 'content' | 'deleted';
  entry: AuditMeta;
}

export interface AgentAuditOptions {
  home: string;
  /** 审计文件；默认 home/state/agent-audit.jsonl */
  file?: string;
  now?: () => string;
  maxBytes?: number;
  /** 读不到/写不进审计时的告警（审计失败不应该静默） */
  logger?: { warn(msg: string, data?: Record<string, unknown>): void; info?(msg: string, data?: Record<string, unknown>): void };
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function makeContent(text: string | null): AuditContent | null {
  if (text === null) return null;
  const truncated = text.length > MAX_AUDIT_TEXT;
  const kept = truncated ? text.slice(0, MAX_AUDIT_TEXT) : text;
  return { hash: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), text: kept, ...(truncated ? { truncated: true } : {}) };
}

function metaOf(entry: AuditEntry): AuditMeta {
  const strip = (c: AuditContent | null): Omit<AuditContent, 'text'> | null =>
    c === null ? null : { hash: c.hash, bytes: c.bytes, ...(c.truncated ? { truncated: true } : {}) };
  const { before, after, diff, ...rest } = entry;
  return { ...rest, before: strip(before), after: strip(after), diffChars: diff.length };
}

/** 行级 diff：够用即可（不做 hunk 分组）；规模太大时只给摘要 */
export function diffLines(before: string | null, after: string | null): string {
  const a = before === null ? [] : before.replace(/\r\n?/g, '\n').split('\n');
  const b = after === null ? [] : after.replace(/\r\n?/g, '\n').split('\n');
  if (a.length * b.length > MAX_LCS_CELLS) {
    return `旧内容 ${a.length} 行 → 新内容 ${b.length} 行（太大，省略逐行 diff）`;
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(' ' + a[i]);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      out.push('+' + b[j]);
      j += 1;
    } else if (i < n) {
      out.push('-' + a[i]);
      i += 1;
    }
    if (out.length >= MAX_DIFF_LINES) {
      out.push(`…（diff 超过 ${MAX_DIFF_LINES} 行，已截断）`);
      break;
    }
  }
  return out.join('\n');
}

function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeTextAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export class AgentAuditLog {
  private readonly home: string;
  private readonly file: string;
  private readonly now: () => string;
  private readonly maxBytes: number;
  private readonly logger?: AgentAuditOptions['logger'];
  /** 串行追加，避免并发写坏 JSONL */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: AgentAuditOptions) {
    this.home = path.resolve(opts.home);
    this.file = opts.file ? path.resolve(opts.home, opts.file) : path.join(this.home, 'state', 'agent-audit.jsonl');
    this.now = opts.now ?? (() => new Date().toISOString());
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger = opts.logger;
  }

  get auditFile(): string {
    return this.file;
  }

  /** 追加一条记录（返回精简 meta）。只写审计文件，不碰目标文件 */
  append(input: AuditAppendInput): AuditMeta {
    const ts = this.now();
    const policy = agentWritePolicy(this.home, input.path);
    if (!policy.ok || policy.zone === null) {
      throw new PetdError('E_FORBIDDEN', `审计目标不在允许范围：${policy.rel || input.path}`);
    }
    const entry: AuditEntry = {
      id: crypto.createHash('sha256').update(`${ts}|${policy.rel}|${input.action}|${input.afterText === null ? '' : sha256(input.afterText)}|${Math.random()}`).digest('hex').slice(0, 16),
      ts,
      actor: input.actor,
      action: input.action,
      path: policy.rel,
      zone: policy.zone,
      reason: (input.reason ?? '').trim(),
      before: makeContent(input.beforeText),
      after: makeContent(input.afterText),
      diff: diffLines(input.beforeText, input.afterText),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    };
    this.appendLine(JSON.stringify(entry) + '\n');
    return metaOf(entry);
  }

  private appendLine(line: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (e) {
      // 审计失败属于安全问题：不能静默，但也不该把主流程打挂
      this.logger?.warn('写审计日志失败', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private rotateIfNeeded(): void {
    try {
      const st = fs.statSync(this.file);
      if (st.size > this.maxBytes) fs.renameSync(this.file, this.file + '.1');
    } catch {
      /* 文件还不存在 */
    }
  }

  private readAll(): AuditEntry[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as AuditEntry;
        if (typeof item.id === 'string' && typeof item.path === 'string' && typeof item.ts === 'string') {
          entries.push(item);
        }
      } catch {
        /* 坏行跳过（例如进程被杀时写了半行） */
      }
    }
    return entries;
  }

  /** 按时间倒序（新→旧）列出，可按路径/actor 过滤 */
  list(query: AuditListQuery = {}): { entries: AuditMeta[]; total: number } {
    const all = this.readAll();
    const filtered = all.filter((e) => {
      if (query.path !== undefined && e.path !== toPosix(query.path)) return false;
      if (query.actor !== undefined && e.actor !== query.actor) return false;
      return true;
    });
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
    const entries = filtered.slice().reverse().slice(0, limit).map(metaOf);
    return { entries, total: filtered.length };
  }

  /** 单条完整记录（含正文与 diff） */
  get(id: string): AuditEntry {
    const found = this.readAll().find((e) => e.id === id);
    if (!found) throw new PetdError('E_NOT_FOUND', `没有这条审计记录：${id}`);
    return found;
  }

  /**
   * 按审计记录回滚一个动态文件。
   * - 只允许回滚 `.agent.*` 动态文件（workspace 记忆走 Git 回滚，不在这里）；
   * - 目标文件在那之后又被改过（hash 与记录的 after 不一致）时默认拒绝，force=true 才覆盖。
   */
  rollback(id: string, opts: { force?: boolean; reason?: string; actor?: AuditActor } = {}): AuditRollbackResult {
    const entry = this.get(id);
    const abs = path.resolve(this.home, entry.path);
    const policy = agentWritePolicy(this.home, abs);
    if (!policy.ok || policy.zone !== 'agent-file') {
      throw new PetdError('E_FORBIDDEN', `只能回滚带 .agent. 后缀的动态文件：${entry.path}`);
    }
    const current = readTextIfExists(abs);
    const currentHash = current === null ? '' : sha256(current);
    const expectedHash = entry.after === null ? '' : entry.after.hash;
    if (!opts.force && currentHash !== expectedHash) {
      throw new PetdError(
        'E_CONFLICT',
        `文件在那之后又被改过，不能直接回滚：${entry.path}（如需覆盖请带 force）`,
        { currentHash, expectedHash }
      );
    }
    const target = entry.before === null ? null : entry.before.text;
    if (target === null) {
      fs.rmSync(abs, { force: true });
    } else {
      writeTextAtomic(abs, target);
    }
    const meta = this.append({
      path: entry.path,
      actor: opts.actor ?? 'user',
      action: 'write',
      reason: (opts.reason ?? '').trim() || `按审计记录 ${entry.id} 回滚`,
      beforeText: current,
      afterText: target,
    });
    return { path: entry.path, restored: target === null ? 'deleted' : 'content', entry: meta };
  }
}
