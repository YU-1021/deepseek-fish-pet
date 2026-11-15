/**
 * 工作区记忆服务：读写操作 + 每次写入后的 Git 提交（串行队列）。
 *
 * 这一层不懂 WebSocket：方法层（gateway/methods/memory.ts）只做参数校验与转发。
 * 每次写成功都提交一次，提交信息形如「petd wrote partner/作息.md」，与 Cormini 的形状一致。
 */
import { createHash } from 'node:crypto';
import { PetdError } from '@petd/protocol';
import { AUTHOR_PETD, type CommitInfo, type GitStatus, WorkspaceGit } from './git.js';
import { assertNonEmptyPath, isResident, SEED_DIRS, SEED_FILES } from './prefix.js';
import type { WorkspaceEntry, WorkspaceMemory } from './store.js';

export interface MemoryLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface MemoryServiceOptions {
  memory: WorkspaceMemory;
  git: WorkspaceGit;
  /** petd 版本号，用于启动快照 tag（start-<version>）。 */
  version: string;
  logger?: MemoryLogger;
  /** 写成功后的广播出口（WebSocket 事件：memory.changed） */
  publish?: (event: string, data: Record<string, unknown>) => void;
}

/** 文件内容的乐观并发版本号：sha256(utf8 内容) 的十六进制前 32 位 */
export function contentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

export interface MemoryReadResult {
  path: string;
  content: string;
  /** 当前内容的版本号，UI 保存时作为 baseRevision 传回来做冲突检测 */
  revision: string;
}

export interface MemoryWriteResult {
  path: string;
  bytes: number;
  /** 写完后内容的版本号 */
  revision: string;
  /** 本次生成的提交 hash；null = 没有改动或 Git 不可用。 */
  commit: string | null;
}

export interface MemoryWriteOptions {
  /**
   * 乐观并发：客户端读到的版本号。传了且与当前内容不一致 → E_CONFLICT。
   * 文件不存在时传空字符串表示「新建」；不传则不做检查（整份覆盖）。
   */
  baseRevision?: string;
}

export interface MemoryGrepHit {
  path: string;
  line: number;
  text: string;
}

export interface MemoryServiceStatus {
  dir: string;
  fileCount: number;
  git: GitStatus;
}

export class MemoryService {
  private readonly memory: WorkspaceMemory;
  private readonly git: WorkspaceGit;
  private readonly version: string;
  private readonly logger?: MemoryLogger;
  private readonly publish?: (event: string, data: Record<string, unknown>) => void;
  /** 同一仓上的提交必须串行（Git index 只允许一个写者）。 */
  private commitQueue: Promise<string | null> = Promise.resolve(null);

  constructor(opts: MemoryServiceOptions) {
    this.memory = opts.memory;
    this.git = opts.git;
    this.version = opts.version;
    this.logger = opts.logger;
    this.publish = opts.publish;
  }

  /** 建目录骨架、播种文件、建仓、打启动快照 tag。可重复调用。 */
  ensure(): void {
    this.memory.ensureDirs(SEED_DIRS);
    this.memory.seed(SEED_FILES);
    this.git.ensureRepo();
    this.ensureStartTag();
  }

  private ensureStartTag(): void {
    if (!this.git.available() || !this.git.isRepo()) return;
    const name = `start-${this.version}`;
    try {
      if (this.git.listTags().some((t) => t.name === name)) return;
      this.git.tag(name, `petd ${this.version} 首次启动`);
      this.logger?.info('已打工作区启动快照', { tag: name });
    } catch (e) {
      this.logger?.warn('打启动快照失败（不影响使用）', { tag: name, err: e instanceof Error ? e.message : String(e) });
    }
  }

  status(): MemoryServiceStatus {
    return { dir: this.memory.dir, fileCount: this.memory.walkFiles('').length, git: this.git.status() };
  }

  tree(): string {
    return this.memory.tree();
  }

  list(dir = ''): WorkspaceEntry[] {
    return this.memory.listDir(dir);
  }

  read(relPath: string): MemoryReadResult {
    const p = assertNonEmptyPath(relPath);
    const normalized = this.memory.normalize(p);
    const content = this.memory.readFile(p);
    return { path: normalized, content, revision: contentRevision(content) };
  }

  /** 读当前版本号（文件不存在返回 null），用于写前乐观并发检查 */
  revisionOf(relPath: string): string | null {
    const p = assertNonEmptyPath(relPath);
    if (!this.memory.exists(p)) return null;
    return contentRevision(this.memory.readFile(p));
  }

  private checkBaseRevision(relPath: string, baseRevision: string | undefined): void {
    if (baseRevision === undefined) return;
    const current = this.revisionOf(relPath);
    if (current === baseRevision) return;
    throw new PetdError('E_CONFLICT', `${this.memory.normalize(relPath)} 已被别处改动，请刷新后再保存`, {
      currentRevision: current,
      baseRevision,
    });
  }

  async write(relPath: string, content: string, opts: MemoryWriteOptions = {}): Promise<MemoryWriteResult> {
    const p = assertNonEmptyPath(relPath);
    this.checkBaseRevision(p, opts.baseRevision);
    this.memory.writeFileAtomic(p, content);
    const normalized = this.memory.normalize(p);
    const revision = contentRevision(content);
    const commit = await this.commit(`petd wrote ${normalized}`);
    this.publish?.('memory.changed', { path: normalized, kind: 'write', revision });
    return { path: normalized, bytes: Buffer.byteLength(content, 'utf8'), revision, commit };
  }

  async append(relPath: string, content: string, opts: MemoryWriteOptions = {}): Promise<MemoryWriteResult> {
    const p = assertNonEmptyPath(relPath);
    this.checkBaseRevision(p, opts.baseRevision);
    this.memory.appendFile(p, content);
    const normalized = this.memory.normalize(p);
    const revision = contentRevision(this.memory.readFile(p));
    const commit = await this.commit(`petd appended to ${normalized}`);
    this.publish?.('memory.changed', { path: normalized, kind: 'append', revision });
    return { path: normalized, bytes: Buffer.byteLength(content, 'utf8'), revision, commit };
  }

  async remove(relPath: string): Promise<{ path: string; commit: string | null }> {
    const p = assertNonEmptyPath(relPath);
    this.guardResident(p, '删除');
    this.memory.deleteFile(p);
    this.memory.pruneEmptyDirs(p);
    const path = this.memory.normalize(p);
    this.publish?.('memory.changed', { path, kind: 'delete' });
    return { path, commit: await this.commit(`petd deleted ${path}`) };
  }

  async move(fromRel: string, toRel: string): Promise<{ from: string; to: string; commit: string | null }> {
    const from = assertNonEmptyPath(fromRel);
    const to = assertNonEmptyPath(toRel);
    this.guardResident(from, '移动');
    this.memory.renameFile(from, to);
    this.memory.pruneEmptyDirs(from);
    const commit = await this.commit(`petd moved ${this.memory.normalize(from)} → ${this.memory.normalize(to)}`);
    this.publish?.(`memory.changed`, {
      path: this.memory.normalize(to),
      from: this.memory.normalize(from),
      kind: 'move',
    });
    return { from: this.memory.normalize(from), to: this.memory.normalize(to), commit };
  }

  glob(pattern: string, dir = ''): string[] {
    return this.memory.globFiles(pattern, dir);
  }

  /** 子串或正则检索，按行返回；默认最多 50 行。 */
  grep(query: string, opts: { path?: string; limit?: number; regex?: boolean } = {}): MemoryGrepHit[] {
    const limit = opts.limit ?? 50;
    const match = opts.regex ? new RegExp(query) : query;
    const hits: MemoryGrepHit[] = [];
    for (const hit of this.memory.grep({ match, ...(opts.path === undefined ? {} : { path: opts.path }) })) {
      for (const line of hit.hits) {
        hits.push({ path: hit.path, line: line + 1, text: hit.lines[line] ?? '' });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  history(opts: { path?: string; limit?: number } = {}): CommitInfo[] {
    return this.git.log({ ...(opts.path === undefined ? {} : { path: opts.path }), limit: opts.limit ?? 30 });
  }

  diff(hash: string, opts: { path?: string } = {}): string {
    return this.git.diff(hash, { ...(opts.path === undefined ? {} : { path: opts.path }) });
  }

  /** 常驻文件（PARTNER.md）不允许删除或整份移动：它们决定前缀。 */
  private guardResident(relPath: string, action: string): void {
    if (isResident(relPath)) {
      throw new PetdError('E_FORBIDDEN', `${this.memory.normalize(relPath)} 是常驻文件，不能${action}；直接改它的内容`);
    }
  }

  private commit(message: string): Promise<string | null> {
    this.commitQueue = this.commitQueue.then(() => this.git.commitAllAsync(message, AUTHOR_PETD));
    return this.commitQueue;
  }
}
