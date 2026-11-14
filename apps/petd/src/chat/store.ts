/**
 * 会话存储：stateDir/sessions/<id>.jsonl + index.json。
 *
 * 为什么是 JSONL：
 *   - 追加写 + 崩溃只会丢最后半行，不会像整文件 JSON 那样全丢（Cortico 的 session-main.jsonl 同思路）；
 *   - 单会话可 grep、可人工修。
 *
 * 为什么 index.json 单独存在：
 *   - list() 不需要打开每个会话文件；index 只是缓存，坏了可从文件名重建（这里暂不自动重建，抛错更诚实）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type StoredRole = 'user' | 'assistant';

export interface StoredMessage {
  role: StoredRole;
  content: string;
  /** ISO 时间 */
  ts: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Session extends SessionMeta {
  messages: StoredMessage[];
}

interface IndexFile {
  version: 1;
  sessions: SessionMeta[];
}

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const TITLE_MAX = 40;
const DEFAULT_TITLE = '新对话';

function nowIso(): string {
  return new Date().toISOString();
}

function clampTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX) + '…' : clean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isRole(v: unknown): v is StoredRole {
  return v === 'user' || v === 'assistant';
}

function newSessionId(): string {
  return 's-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
}

export interface ChatStoreOptions {
  dir: string;
  logger?: { warn(msg: string, data?: Record<string, unknown>): void };
}

export class ChatStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly logger?: ChatStoreOptions['logger'];
  private index: IndexFile | null = null;

  constructor(opts: ChatStoreOptions) {
    this.dir = opts.dir;
    this.indexPath = path.join(this.dir, INDEX_FILE);
    this.logger = opts.logger;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private sessionPath(id: string): string {
    return path.join(this.dir, id + '.jsonl');
  }

  private loadIndex(): IndexFile {
    if (this.index) return this.index;
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      raw = null;
    }
    if (isObject(raw) && Array.isArray(raw['sessions'])) {
      const sessions: SessionMeta[] = [];
      for (const item of raw['sessions']) {
        if (
          isObject(item) &&
          typeof item['id'] === 'string' &&
          typeof item['title'] === 'string' &&
          typeof item['createdAt'] === 'string' &&
          typeof item['updatedAt'] === 'string' &&
          typeof item['messageCount'] === 'number'
        ) {
          sessions.push({
            id: item['id'],
            title: item['title'],
            createdAt: item['createdAt'],
            updatedAt: item['updatedAt'],
            messageCount: item['messageCount'],
          });
        }
      }
      this.index = { version: INDEX_VERSION, sessions };
    } else {
      this.index = { version: INDEX_VERSION, sessions: [] };
    }
    return this.index;
  }

  private saveIndex(): void {
    const index = this.loadIndex();
    const tmp = this.indexPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.indexPath);
  }

  private writeMeta(meta: SessionMeta): void {
    const index = this.loadIndex();
    const i = index.sessions.findIndex((s) => s.id === meta.id);
    if (i >= 0) index.sessions[i] = meta;
    else index.sessions.push(meta);
    this.saveIndex();
  }

  list(): SessionMeta[] {
    const index = this.loadIndex();
    return [...index.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  get(id: string): Session | null {
    const index = this.loadIndex();
    const meta = index.sessions.find((s) => s.id === id);
    if (!meta) return null;
    const messages: StoredMessage[] = [];
    let text = '';
    try {
      text = fs.readFileSync(this.sessionPath(id), 'utf8');
    } catch {
      this.logger?.warn('会话文件缺失，返回空会话', { id });
      return { ...meta, messages };
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let v: unknown;
      try {
        v = JSON.parse(trimmed);
      } catch {
        this.logger?.warn('会话文件有半行损坏，已跳过', { id });
        continue;
      }
      if (isObject(v) && isRole(v['role']) && typeof v['content'] === 'string') {
        messages.push({ role: v['role'], content: v['content'], ts: typeof v['ts'] === 'string' ? v['ts'] : '' });
      }
    }
    return { ...meta, messages };
  }

  create(title?: string): SessionMeta {
    const ts = nowIso();
    const meta: SessionMeta = {
      id: newSessionId(),
      title: title ? clampTitle(title) : DEFAULT_TITLE,
      createdAt: ts,
      updatedAt: ts,
      messageCount: 0,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.sessionPath(meta.id), '', 'utf8');
    this.writeMeta(meta);
    return meta;
  }

  append(id: string, messages: StoredMessage[]): SessionMeta | null {
    const index = this.loadIndex();
    const meta = index.sessions.find((s) => s.id === id);
    if (!meta) return null;
    if (messages.length) {
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(this.sessionPath(id), lines, 'utf8');
      meta.messageCount += messages.length;
    }
    meta.updatedAt = nowIso();
    this.writeMeta(meta);
    return { ...meta };
  }

  rename(id: string, title: string): SessionMeta | null {
    const index = this.loadIndex();
    const meta = index.sessions.find((s) => s.id === id);
    if (!meta) return null;
    meta.title = clampTitle(title);
    meta.updatedAt = nowIso();
    this.writeMeta(meta);
    return { ...meta };
  }

  remove(id: string): boolean {
    const index = this.loadIndex();
    const i = index.sessions.findIndex((s) => s.id === id);
    if (i < 0) return false;
    index.sessions.splice(i, 1);
    this.saveIndex();
    try {
      fs.unlinkSync(this.sessionPath(id));
    } catch {}
    return true;
  }
}

export { clampTitle, newSessionId, DEFAULT_TITLE };
