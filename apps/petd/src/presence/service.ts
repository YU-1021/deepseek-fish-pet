import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';

export type PresenceConfig = PetdConfig['presence'];
export type PresenceKind = 'groom' | 'stretch' | 'window' | 'nap' | 'tidy' | 'idle';

export interface PresenceActivity {
  id: string;
  kind: PresenceKind;
  label: string;
  at: number;
}

export interface PresenceStatus {
  enabled: boolean;
  quiet: boolean;
  intervalMinutes: number;
  idleMinutes: number;
  maxPerDay: number;
  nightQuiet: PresenceConfig['nightQuiet'];
  nextAt: number | null;
  countToday: number;
  total: number;
  last: PresenceActivity | null;
}

export interface PresenceServiceOptions {
  file: string;
  config: () => PresenceConfig;
  publish?: (event: string, data: Record<string, unknown>) => void;
  logger?: { debug?: (msg: string, data?: Record<string, unknown>) => void };
  now?: () => number;
  /** 返回用户空闲毫秒数；负数/缺失表示拿不到（此时跳过空闲检查） */
  idleProvider?: () => number;
  /** 是否启动定时器（测试里关掉、手动 tick） */
  armTimers?: boolean;
  /** 定时检查间隔（毫秒） */
  tickMs?: number;
}

interface PresenceFile {
  version: 1;
  seq: number;
  entries: PresenceActivity[];
  day: string;
  countToday: number;
  lastAt: number | null;
}

const MAX_ENTRIES = 200;
const DEFAULT_TICK_MS = 60_000;

const KINDS: Array<{ kind: PresenceKind; label: string }> = [
  { kind: 'groom', label: '整理了一下羽毛' },
  { kind: 'stretch', label: '伸了个懒腰' },
  { kind: 'window', label: '盯着窗外看了一会儿' },
  { kind: 'nap', label: '趴在桌角打了个盹' },
  { kind: 'tidy', label: '把身边的小东西归置了一下' },
  { kind: 'idle', label: '安静地发了一会儿呆' },
];

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function minuteOfDay(clock: string): number {
  const [h, m] = clock.split(':').map((v) => Number(v));
  return (h ?? 0) * 60 + (m ?? 0);
}

function inNightQuiet(ts: number, cfg: PresenceConfig): boolean {
  if (!cfg.nightQuiet.enabled) return false;
  const start = minuteOfDay(cfg.nightQuiet.start);
  const end = minuteOfDay(cfg.nightQuiet.end);
  if (start === end) return false;
  const d = new Date(ts);
  const now = d.getHours() * 60 + d.getMinutes();
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function parsePresenceFile(text: string): PresenceFile | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw['version'] !== 'number' || raw['version'] !== 1) return null;
    const entries: PresenceActivity[] = [];
    const list = raw['entries'];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const r = item as Record<string, unknown>;
        if (
          typeof r['id'] === 'string' &&
          typeof r['kind'] === 'string' &&
          typeof r['label'] === 'string' &&
          typeof r['at'] === 'number'
        ) {
          entries.push({ id: r['id'] as string, kind: r['kind'] as PresenceKind, label: r['label'] as string, at: r['at'] as number });
        }
      }
    }
    const seq = typeof raw['seq'] === 'number' ? raw['seq'] : entries.length;
    const day = typeof raw['day'] === 'string' ? (raw['day'] as string) : dayKey(Date.now());
    const countToday = typeof raw['countToday'] === 'number' ? (raw['countToday'] as number) : 0;
    const lastAt = typeof raw['lastAt'] === 'number' ? (raw['lastAt'] as number) : null;
    return { version: 1, seq, entries, day, countToday, lastAt };
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 静默活动：大部分时间自己安静待着。
 * 只按间隔/夜间安静/用户闲置/每日上限挑一个小动作，广播 presence.activity 给前端做小动画，
 * 不发聊天消息、不朗读、不调用模型。
 */
export class PresenceService {
  private readonly file: string;
  private readonly config: () => PresenceConfig;
  private readonly publish: (event: string, data: Record<string, unknown>) => void;
  private readonly logger: { debug?: (msg: string, data?: Record<string, unknown>) => void };
  private readonly now: () => number;
  private readonly idleProvider?: () => number;
  private readonly armTimers: boolean;
  private readonly tickMs: number;
  private data: PresenceFile;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: PresenceServiceOptions) {
    this.file = options.file;
    this.config = options.config;
    this.publish = options.publish ?? (() => undefined);
    this.logger = options.logger ?? {};
    this.now = options.now ?? (() => Date.now());
    this.idleProvider = options.idleProvider;
    this.armTimers = options.armTimers ?? true;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.data = { version: 1, seq: 0, entries: [], day: dayKey(this.now()), countToday: 0, lastAt: null };
  }

  ensure(): void {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = parsePresenceFile(text);
      if (parsed) {
        this.data = parsed;
        this.rollDay();
      }
    } catch {
      // 文件不存在/读不了：用空状态，首次活动时再写
    }
    if (this.armTimers) this.start();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.logger.debug?.('静默活动 tick 失败', { error: String(error) });
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): PresenceStatus {
    this.rollDay();
    const cfg = this.config();
    return {
      enabled: cfg.enabled,
      quiet: cfg.quiet,
      intervalMinutes: cfg.intervalMinutes,
      idleMinutes: cfg.idleMinutes,
      maxPerDay: cfg.maxPerDay,
      nightQuiet: { ...cfg.nightQuiet },
      nextAt: cfg.enabled && this.data.lastAt !== null ? this.data.lastAt + cfg.intervalMinutes * 60_000 : null,
      countToday: this.data.countToday,
      total: this.data.entries.length,
      last: this.data.entries.length > 0 ? this.data.entries[this.data.entries.length - 1] ?? null : null,
    };
  }

  list(limit = 50): PresenceActivity[] {
    this.rollDay();
    const n = Math.max(1, Math.min(limit, 200));
    return this.data.entries.slice(-n).reverse();
  }

  /** 定时检查：满足间隔/夜间/用户闲置/每日上限才活动 */
  tick(): PresenceActivity | null {
    const cfg = this.config();
    if (!cfg.enabled) return null;
    this.rollDay();
    const now = this.now();
    if (inNightQuiet(now, cfg)) return null;
    if (cfg.maxPerDay > 0 && this.data.countToday >= cfg.maxPerDay) return null;
    if (this.data.lastAt !== null && now - this.data.lastAt < cfg.intervalMinutes * 60_000) return null;
    if (cfg.idleMinutes > 0 && this.idleProvider) {
      let idle = -1;
      try {
        idle = this.idleProvider();
      } catch {
        idle = -1;
      }
      if (idle >= 0 && idle < cfg.idleMinutes * 60_000) return null;
    }
    return this.record(cfg, now);
  }

  /** 手动触发一次（忽略间隔/夜间/闲置，仍受 enabled 与每日上限限制） */
  runOnce(): PresenceActivity {
    const cfg = this.config();
    if (!cfg.enabled) throw new PetdError('E_UNAVAILABLE', '静默活动已关闭（config.presence.enabled=false）');
    this.rollDay();
    if (cfg.maxPerDay > 0 && this.data.countToday >= cfg.maxPerDay) {
      throw new PetdError('E_UNAVAILABLE', `今天的安静活动次数已到上限（${cfg.maxPerDay} 次）`);
    }
    return this.record(cfg, this.now());
  }

  private rollDay(): void {
    const today = dayKey(this.now());
    if (this.data.day !== today) {
      this.data.day = today;
      this.data.countToday = 0;
    }
  }

  private record(cfg: PresenceConfig, now: number): PresenceActivity {
    const entry = KINDS[this.data.seq % KINDS.length] as { kind: PresenceKind; label: string };
    this.data.seq += 1;
    const activity: PresenceActivity = {
      id: `p-${String(this.data.seq).padStart(4, '0')}`,
      kind: entry.kind,
      label: entry.label,
      at: now,
    };
    this.data.entries.push(activity);
    if (this.data.entries.length > MAX_ENTRIES) this.data.entries = this.data.entries.slice(-MAX_ENTRIES);
    this.data.countToday += 1;
    this.data.lastAt = now;
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    } catch (error) {
      this.logger.debug?.('静默活动落盘失败', { error: String(error) });
    }
    this.publish('presence.activity', {
      id: activity.id,
      kind: activity.kind,
      label: activity.label,
      at: activity.at,
      quiet: cfg.quiet,
    });
    this.logger.debug?.('静默活动', { kind: activity.kind, quiet: cfg.quiet });
    return activity;
  }
}
