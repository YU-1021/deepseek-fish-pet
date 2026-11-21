/**
 * DSH 会话观察（只读）：看桌面 GUI 正在用的会话在干什么。
 *
 * 为什么要这层：
 * - SDK 通道只能看到 petd 自己起的 runtime 的会话；
 * - 用户桌面 GUI 里的会话是另一个进程，但它把事件实时写进
 *   `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`；
 * - 尾读这个文件就能得到「空闲/思考中/正在用工具」的即时状态，给桌宠表情用。
 *
 * 实现：zstd 分帧（magic 28 B5 2F FD）→ 尾部若干 MB → 解压 → 取最后若干事件 → 归纳状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DshLogger } from './runtime.js';
import { viewDshEvent } from './protocol.js';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE_RE = /^session\.v\d+\.jsonl\.zstd$/;

export type DshSessionState = 'idle' | 'thinking' | 'working';

export interface DshSessionSnapshot {
  sessionId: string;
  /** 解码后的工作目录（如 C:\deepseek）；解不出时同 workspaceRaw */
  workspace: string;
  workspaceRaw: string;
  file: string;
  mtimeMs: number;
  size: number;
  state: DshSessionState;
  active: boolean;
  turn: number | null;
  step: number | null;
  tool: string | null;
  lastText: string | null;
  lastEventType: string | null;
  updatedAt: number;
  events: number;
}

export interface DshObserverStatus {
  enabled: boolean;
  sessionsDir: string;
  scanning: boolean;
  scannedAt: number | null;
  session: DshSessionSnapshot | null;
  error: string | null;
}

export interface DshObserverOptions {
  sessionsDir: string;
  /** 多久没更新算「不活跃」（毫秒） */
  activeMs?: number;
  /** 轮询间隔（毫秒） */
  pollMs?: number;
  /** 只读文件尾部多少字节（默认 4MB） */
  tailBytes?: number;
  /** 最多解析尾部多少条事件 */
  maxEvents?: number;
  logger?: DshLogger;
  publish?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  /** 测试里关掉定时器，手动 scan() */
  armTimers?: boolean;
}

const DEFAULT_ACTIVE_MS = 15_000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 600;

function zstdDecompress(buffer: Buffer): Buffer | null {
  const mod = zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer };
  if (typeof mod.zstdDecompressSync !== 'function') return null;
  try {
    return mod.zstdDecompressSync(buffer);
  } catch {
    return null;
  }
}

/**
 * 把工作区目录名还原成路径：--C-deepseek-- → C:\deepseek
 *
 * DSH 把路径里的 `:` / `\` / 空格等统一替换成 `-`，所以解码只能是「尽力还原」：
 * 盘符形态 `C-deepseek` → `C:\deepseek`；其它形态原样返回（不猜，避免编造路径）。
 */
export function decodeWorkspaceName(name: string): string {
  const inner = name.replace(/^--/, '').replace(/--$/, '');
  if (inner === '') return name;
  const drive = /^([A-Za-z])-(.+)$/.exec(inner);
  if (drive !== null) {
    return `${drive[1]!.toUpperCase()}:\\${drive[2]!.split('-').join('\\')}`;
  }
  return inner;
}

export class DshObserver {
  private readonly opts: DshObserverOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private cached: DshSessionSnapshot | null = null;
  private cachedFile: string | null = null;
  private cachedMtime = -1;
  private cachedSize = -1;
  private scannedAt: number | null = null;
  private error: string | null = null;
  private scanning = false;
  private warnedZstd = false;

  constructor(options: DshObserverOptions) {
    this.opts = options;
    this.now = options.now ?? (() => Date.now());
  }

  status(): DshObserverStatus {
    return {
      enabled: this.timer !== null,
      sessionsDir: this.opts.sessionsDir,
      scanning: this.scanning,
      scannedAt: this.scannedAt,
      session: this.cached,
      error: this.error,
    };
  }

  start(): void {
    if (this.timer !== null) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 扫一次；文件没变时复用缓存（只刷新 active） */
  scan(): DshSessionSnapshot | null {
    if (this.scanning) return this.cached;
    this.scanning = true;
    try {
      const found = this.findNewest();
      if (found === null) {
        this.cached = null;
        this.cachedFile = null;
        this.cachedMtime = -1;
        this.cachedSize = -1;
        this.scannedAt = this.now();
        return null;
      }
      if (found.file === this.cachedFile && found.mtimeMs === this.cachedMtime && found.size === this.cachedSize) {
        if (this.cached !== null) {
          this.cached.active = this.now() - found.mtimeMs < (this.opts.activeMs ?? DEFAULT_ACTIVE_MS);
        }
        this.scannedAt = this.now();
        return this.cached;
      }
      const snapshot = this.parse(found);
      if (snapshot !== null) {
        this.emitActivity(snapshot);
      }
      this.cached = snapshot;
      this.cachedFile = found.file;
      this.cachedMtime = found.mtimeMs;
      this.cachedSize = found.size;
      this.scannedAt = this.now();
      this.error = null;
      return snapshot;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.opts.logger?.warn?.('DSH 会话观察失败', { error: this.error });
      return this.cached;
    } finally {
      this.scanning = false;
    }
  }

  private emitActivity(snapshot: DshSessionSnapshot): void {
    const prev = this.cached;
    const changed =
      prev === null ||
      prev.state !== snapshot.state ||
      prev.tool !== snapshot.tool ||
      prev.turn !== snapshot.turn ||
      prev.step !== snapshot.step ||
      prev.sessionId !== snapshot.sessionId;
    if (!changed) return;
    this.opts.publish?.('dsh.activity', { ...snapshot });
  }

  private findNewest(): { file: string; mtimeMs: number; size: number; workspaceRaw: string; sessionId: string } | null {
    const dir = this.opts.sessionsDir;
    let workspaces: fs.Dirent[];
    try {
      workspaces = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    let best: { file: string; mtimeMs: number; size: number; workspaceRaw: string; sessionId: string } | null = null;
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(dir, ws.name);
      let sessions: fs.Dirent[];
      try {
        sessions = fs.readdirSync(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const sessionDir = path.join(wsDir, session.name);
        let files: string[];
        try {
          files = fs.readdirSync(sessionDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!SESSION_FILE_RE.test(name)) continue;
          const file = path.join(sessionDir, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (best === null || stat.mtimeMs > best.mtimeMs) {
            best = {
              file,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              workspaceRaw: ws.name,
              sessionId: session.name,
            };
          }
        }
      }
    }
    return best;
  }

  private parse(found: { file: string; mtimeMs: number; size: number; workspaceRaw: string; sessionId: string }): DshSessionSnapshot | null {
    const tailBytes = this.opts.tailBytes ?? DEFAULT_TAIL_BYTES;
    const start = Math.max(0, found.size - tailBytes);
    let buffer: Buffer;
    try {
      const fd = fs.openSync(found.file, 'r');
      try {
        buffer = Buffer.alloc(found.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      this.opts.logger?.warn?.('读 DSH 会话文件失败', { file: found.file, error: String(error) });
      return null;
    }
    const events = this.decodeEvents(buffer);
    if (events === null) return null;
    const snapshot = this.derive(found, events);
    return snapshot;
  }

  private decodeEvents(buffer: Buffer): Array<Record<string, unknown>> | null {
    const firstMagic = buffer.indexOf(ZSTD_MAGIC);
    if (firstMagic < 0) return [];
    const offsets: number[] = [];
    let cursor = firstMagic;
    while (cursor >= 0) {
      offsets.push(cursor);
      cursor = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length);
    }
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < offsets.length; i += 1) {
      const from = offsets[i]!;
      const to = i + 1 < offsets.length ? offsets[i + 1]! : buffer.length;
      const decompressed = zstdDecompress(buffer.subarray(from, to));
      if (decompressed === null) continue;
      const text = decompressed.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
        } catch {
          // 尾部截断产生的半行
        }
      }
    }
    if (out.length === 0 && !this.warnedZstd) {
      this.warnedZstd = true;
      this.opts.logger?.warn?.('DSH 会话尾部解不出事件（zstd 不可用或文件格式变了）', { sessionsDir: this.opts.sessionsDir });
    }
    const maxEvents = this.opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    return out.length > maxEvents ? out.slice(-maxEvents) : out;
  }

  private derive(
    found: { file: string; mtimeMs: number; size: number; workspaceRaw: string; sessionId: string },
    events: Array<Record<string, unknown>>
  ): DshSessionSnapshot {
    let state: DshSessionState = 'idle';
    let turn: number | null = null;
    let step: number | null = null;
    let tool: string | null = null;
    let lastText: string | null = null;
    let lastEventType: string | null = null;
    for (const ev of events) {
      const view = viewDshEvent(ev);
      if (view.type === '') continue;
      lastEventType = view.type;
      if (view.turn !== null) turn = view.turn;
      if (view.step !== null) step = view.step;
      if (view.type === 'tool/call' || (view.type === 'assistant/message' && view.tool !== null)) {
        state = 'working';
        if (view.tool !== null) tool = view.tool;
      } else if (view.type === 'tool/result') {
        state = 'thinking';
      } else if (view.type === 'step/start' || view.type === 'step/end' || view.type === 'assistant/message' || view.type === 'turn/start') {
        state = 'thinking';
      } else if (view.type === 'turn/end') {
        state = 'idle';
        tool = null;
      }
      if (view.text !== null) {
        lastText = view.text.length > 300 ? view.text.slice(0, 300) + '…' : view.text;
      }
    }
    if (state === 'thinking' && lastEventType === 'step/end') {
      // 一步结束但回合还在继续，保持 thinking；回合真正结束由 turn/end 翻回 idle
    }
    return {
      sessionId: found.sessionId,
      workspace: decodeWorkspaceName(found.workspaceRaw),
      workspaceRaw: found.workspaceRaw,
      file: found.file,
      mtimeMs: found.mtimeMs,
      size: found.size,
      state,
      active: this.now() - found.mtimeMs < (this.opts.activeMs ?? DEFAULT_ACTIVE_MS),
      turn,
      step,
      tool,
      lastText,
      lastEventType,
      updatedAt: found.mtimeMs,
      events: events.length,
    };
  }
}
