/**
 * 工作区记忆服务：读写操作 + 每次写入后的 Git 提交（串行队列）。
 *
 * 这一层不懂 WebSocket：方法层（gateway/methods/memory.ts）只做参数校验与转发。
 * 每次写成功都提交一次，提交信息形如「petd wrote partner/作息.md」，与 Cormini 的形状一致。
 */
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
}

export interface MemoryWriteResult {
  path: string;
  bytes: number;
  /** 本次生成的提交 hash；null = 没有改动或 Git 不可用。 */
  commit: string | null;
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
  /** 同一仓上的提交必须串行（Git index 只允许一个写者）。 */
  private commitQueue: Promise<string | null> = Promise.resolve(null);

  constructor(opts: MemoryServiceOptions) {
    this.memory = opts.memory;
    this.git = opts.git;
    this.version = opts.version;
    this.logger = opts.logger;
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

  read(relPath: string): { path: string; content: string } {
    const p = assertNonEmptyPath(relPath);
    return { path: this.memory.normalize(p), content: this.memory.readFile(p) };
  }

  async write(relPath: string, content: string): Promise<MemoryWriteResult> {
    const p = assertNonEmptyPath(relPath);
    this.memory.writeFileAtomic(p, content);
    return { path: this.memory.normalize(p), bytes: Buffer.byteLength(content, 'utf8'), commit: await this.commit(`petd wrote ${this.memory.normalize(p)}`) };
  }

  async append(relPath: string, content: string): Promise<MemoryWriteResult> {
    const p = assertNonEmptyPath(relPath);
    this.memory.appendFile(p, content);
    return {
      path: this.memory.normalize(p),
      bytes: Buffer.byteLength(content, 'utf8'),
      commit: await this.commit(`petd appended to ${this.memory.normalize(p)}`),
    };
  }

  async remove(relPath: string): Promise<{ path: string; commit: string | null }> {
    const p = assertNonEmptyPath(relPath);
    this.guardResident(p, '删除');
    this.memory.deleteFile(p);
    this.memory.pruneEmptyDirs(p);
    return { path: this.memory.normalize(p), commit: await this.commit(`petd deleted ${this.memory.normalize(p)}`) };
  }

  async move(fromRel: string, toRel: string): Promise<{ from: string; to: string; commit: string | null }> {
    const from = assertNonEmptyPath(fromRel);
    const to = assertNonEmptyPath(toRel);
    this.guardResident(from, '移动');
    this.memory.renameFile(from, to);
    this.memory.pruneEmptyDirs(from);
    const commit = await this.commit(`petd moved ${this.memory.normalize(from)} → ${this.memory.normalize(to)}`);
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
