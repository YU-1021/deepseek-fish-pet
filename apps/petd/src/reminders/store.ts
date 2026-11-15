/**
 * 提醒 / 日程：一次性提醒（绝对时间戳落盘 + 到点广播事件）。
 *
 * 设计参考旧桌宠 app/src/remind.js（同项目 MIT），按常驻进程重写：
 * - 落盘 home/state/reminders.json，重启不丢；存**绝对时间戳**，不存「还有多少分钟」（重启后会算错）；
 * - 定时器只 arm 到最近一条，到点 tick() 统一处理；进程内也有兜底（tick 后重新 arm）；
 * - 到点只广播 `reminder.due` 事件（UI/聊天决定怎么提醒），不在 store 里偷偷发消息；
 * - 过期太久的（超过 catchUpHours）标 skipped 而不是集中补报——重启后一次性弹十几条很糟；
 * - 事件：reminder.created / reminder.due / reminder.skipped / reminder.cancelled / reminder.snoozed。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';

export type ReminderStatus = 'pending' | 'fired' | 'cancelled' | 'skipped';
export type ReminderSource = 'user' | 'chat' | 'tool' | 'system';

export interface ReminderItem {
  id: string;
  text: string;
  /** 绝对时间戳（毫秒），到点判定用它 */
  at: number;
  createdAt: number;
  status: ReminderStatus;
  source: ReminderSource;
  firedAt?: number;
  /** 实际到点晚了多少毫秒（>0 表示补报） */
  firedLateMs?: number;
  snoozes?: number;
  skippedReason?: string;
}

interface ReminderFile {
  version: 1;
  seq: number;
  items: ReminderItem[];
}

/** 给 UI/方法返回的轻量视图（不含内部字段） */
export interface ReminderSnapshot {
  id: string;
  text: string;
  at: number;
  /** 距离到点还有多少分钟（向上取整；已过点为 0 或负数） */
  inMinutes: number;
  createdAt: number;
  snoozes: number;
  source: ReminderSource;
}

export interface ReminderStatusSummary {
  pending: number;
  nextAt: number | null;
  armed: boolean;
}

export interface ReminderStoreOptions {
  /** 状态文件绝对路径（通常是 home/state/reminders.json） */
  file: string;
  now?: () => number;
  log?: { warn(msg: string, data?: unknown): void };
  publish?: (event: string, data: unknown) => void;
  maxPending?: number;
  catchUpHours?: number;
  keepFiredDays?: number;
  /** 是否真的装 setTimeout（单测里传 false，用 tick() 手动驱动） */
  armTimers?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const MAX_TEXT_CHARS = 300;
const MAX_MINUTES_AHEAD = 60 * 24 * 30;
const MAX_ITEMS_KEPT = 500;
const MAX_TIMER_DELAY = 2_147_000_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 把「N 分钟后 / HH:MM / 绝对时间」换算成绝对时间戳；非法/已过去抛 E_BAD_PARAMS */
export function computeReminderAt(
  input: { inMinutes?: number; atClock?: string; at?: number | string },
  now: number
): number {
  const given = [input.inMinutes, input.atClock, input.at].filter((v) => v !== undefined).length;
  if (given === 0) throw new PetdError('E_BAD_PARAMS', '要给时间：inMinutes（N 分钟后）、atClock（HH:MM）或 at（时间戳）');
  if (given > 1) throw new PetdError('E_BAD_PARAMS', '时间只能给一种：inMinutes / atClock / at');

  if (input.inMinutes !== undefined) {
    const m = Number(input.inMinutes);
    if (!Number.isFinite(m) || m <= 0) throw new PetdError('E_BAD_PARAMS', 'inMinutes 要是正数（分钟）');
    if (m > MAX_MINUTES_AHEAD) throw new PetdError('E_BAD_PARAMS', '太远了（最多 30 天）——这么远的提醒不如到时候再说');
    return now + Math.round(m * 60_000);
  }

  if (input.atClock !== undefined) {
    const m = String(input.atClock).trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
    if (!m) throw new PetdError('E_BAD_PARAMS', 'atClock 格式要像 14:30 或 9:05');
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) throw new PetdError('E_BAD_PARAMS', '时间不合法（小时 0-23、分钟 0-59）');
    const d = new Date(now);
    d.setHours(h, mi, 0, 0);
    let at = d.getTime();
    if (at <= now) at += 24 * 3_600_000; // 今天过了就明天
    return at;
  }

  const raw = input.at;
  const at = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(at)) throw new PetdError('E_BAD_PARAMS', 'at 不是合法的时间戳/ISO 时间');
  if (at <= now + 500) throw new PetdError('E_BAD_PARAMS', '这个提醒时间已经过去了');
  return Math.round(at);
}

/** 解析状态文件（坏条目跳过，不整体报废） */
export function parseReminderFile(text: string): ReminderFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const seq = typeof raw['seq'] === 'number' && Number.isFinite(raw['seq']) ? Math.max(0, Math.floor(raw['seq'])) : 0;
  const items: ReminderItem[] = [];
  const list = Array.isArray(raw['items']) ? raw['items'] : [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    const text = typeof entry['text'] === 'string' ? entry['text'] : '';
    const at = entry['at'];
    if (!id || !text || typeof at !== 'number' || !Number.isFinite(at)) continue;
    const status = entry['status'];
    const st: ReminderStatus =
      status === 'fired' || status === 'cancelled' || status === 'skipped' || status === 'pending' ? status : 'pending';
    items.push({
      id,
      text: text.slice(0, MAX_TEXT_CHARS),
      at: Math.round(at),
      createdAt: typeof entry['createdAt'] === 'number' ? Math.round(entry['createdAt']) : Math.round(at),
      status: st,
      source: typeof entry['source'] === 'string' ? (entry['source'] as ReminderSource) : 'user',
      ...(typeof entry['firedAt'] === 'number' ? { firedAt: Math.round(entry['firedAt']) } : {}),
      ...(typeof entry['firedLateMs'] === 'number' ? { firedLateMs: Math.round(entry['firedLateMs']) } : {}),
      ...(typeof entry['snoozes'] === 'number' ? { snoozes: Math.max(0, Math.round(entry['snoozes'])) } : {}),
      ...(typeof entry['skippedReason'] === 'string' ? { skippedReason: entry['skippedReason'].slice(0, 200) } : {}),
    });
  }
  return { version: 1, seq: Math.max(seq, items.length), items };
}

function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, data, 'utf8');
  }
}

function toSnapshot(item: ReminderItem, now: number): ReminderSnapshot {
  return {
    id: item.id,
    text: item.text,
    at: item.at,
    inMinutes: Math.ceil((item.at - now) / 60_000),
    createdAt: item.createdAt,
    snoozes: item.snoozes ?? 0,
    source: item.source,
  };
}

export class ReminderStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log?: ReminderStoreOptions['log'];
  private readonly publish?: ReminderStoreOptions['publish'];
  private readonly maxPending: number;
  private readonly catchUpHours: number;
  private readonly keepFiredDays: number;
  private readonly armTimers: boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private seq = 0;
  private items: ReminderItem[] = [];
  private timer: unknown = null;

  constructor(opts: ReminderStoreOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.publish = opts.publish;
    this.maxPending = opts.maxPending ?? 50;
    this.catchUpHours = opts.catchUpHours ?? 24;
    this.keepFiredDays = opts.keepFiredDays ?? 7;
    this.armTimers = opts.armTimers ?? true;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  ensure(): ReminderStatusSummary {
    this.load();
    this.cleanup();
    this.arm();
    return this.status();
  }

  stop(): void {
    this.disarm();
  }

  private load(): void {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = parseReminderFile(text);
      if (!parsed) return;
      this.items = parsed.items;
      this.seq = parsed.seq;
    } catch {
      this.items = [];
      this.seq = 0;
    }
  }

  private save(): void {
    const data: ReminderFile = { version: 1, seq: this.seq, items: this.items.slice(-MAX_ITEMS_KEPT) };
    try {
      writeFileAtomic(this.file, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log?.warn('提醒状态写入失败', { error: (e as Error).message });
    }
  }

  private pendingItems(): ReminderItem[] {
    return this.items.filter((x) => x.status === 'pending').sort((a, b) => a.at - b.at);
  }

  list(): ReminderSnapshot[] {
    const now = this.now();
    return this.pendingItems().map((item) => toSnapshot(item, now));
  }

  get(id: string): ReminderSnapshot | null {
    const item = this.pendingItems().find((x) => x.id === id);
    return item ? toSnapshot(item, this.now()) : null;
  }

  status(): ReminderStatusSummary {
    const pending = this.pendingItems();
    return { pending: pending.length, nextAt: pending[0]?.at ?? null, armed: this.timer !== null };
  }

  create(input: {
    text: string;
    inMinutes?: number;
    atClock?: string;
    at?: number | string;
    source?: ReminderSource;
  }): ReminderSnapshot {
    const text = String(input.text ?? '').trim();
    if (!text) throw new PetdError('E_BAD_PARAMS', '提醒内容不能为空');
    if (text.length > MAX_TEXT_CHARS) throw new PetdError('E_BAD_PARAMS', `提醒内容太长（最多 ${MAX_TEXT_CHARS} 字）`);
    if (this.pendingItems().length >= this.maxPending) {
      throw new PetdError('E_UNAVAILABLE', `待响提醒太多（最多 ${this.maxPending} 条），先取消几条再设`);
    }
    const now = this.now();
    const at = computeReminderAt(
      {
        ...(input.inMinutes === undefined ? {} : { inMinutes: input.inMinutes }),
        ...(input.atClock === undefined ? {} : { atClock: input.atClock }),
        ...(input.at === undefined ? {} : { at: input.at }),
      },
      now
    );
    this.seq += 1;
    const item: ReminderItem = {
      id: `r${this.seq}`,
      text,
      at,
      createdAt: now,
      status: 'pending',
      source: input.source ?? 'user',
    };
    this.items.push(item);
    this.save();
    this.arm();
    const snapshot = toSnapshot(item, now);
    this.publish?.('reminder.created', { item: snapshot });
    return snapshot;
  }

  cancel(id: string): ReminderSnapshot {
    const item = this.items.find((x) => x.id === id);
    if (!item) throw new PetdError('E_NOT_FOUND', `没有编号为 ${id} 的提醒`);
    if (item.status !== 'pending') throw new PetdError('E_NOT_FOUND', `提醒 ${id} 已经不是待响状态了`);
    item.status = 'cancelled';
    this.save();
    this.arm();
    const snapshot = toSnapshot(item, this.now());
    this.publish?.('reminder.cancelled', { item: snapshot });
    return snapshot;
  }

  snooze(id: string, minutes = 5): ReminderSnapshot {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0 || m > 1440) throw new PetdError('E_BAD_PARAMS', 'snooze 的分钟数要在 1–1440 之间');
    const item = this.items.find((x) => x.id === id);
    if (!item) throw new PetdError('E_NOT_FOUND', `没有编号为 ${id} 的提醒`);
    if (item.status !== 'pending') throw new PetdError('E_NOT_FOUND', `提醒 ${id} 已经不是待响状态了`);
    const now = this.now();
    item.at = now + Math.round(m * 60_000);
    item.snoozes = (item.snoozes ?? 0) + 1;
    this.save();
    this.arm();
    const snapshot = toSnapshot(item, now);
    this.publish?.('reminder.snoozed', { item: snapshot, minutes: m });
    return snapshot;
  }

  /** 到点检查；由定时器调用，也可手动驱动（测试）。返回本次真正响了的条目。 */
  tick(): ReminderItem[] {
    const now = this.now();
    const due = this.items.filter((x) => x.status === 'pending' && x.at <= now);
    const fired: ReminderItem[] = [];
    for (const item of due) {
      const late = now - item.at;
      if (late > this.catchUpHours * 3_600_000) {
        item.status = 'skipped';
        item.skippedReason = `过期超过 ${this.catchUpHours} 小时，不再补报`;
        this.publish?.('reminder.skipped', { item: toSnapshot(item, now), reason: item.skippedReason });
        continue;
      }
      item.status = 'fired';
      item.firedAt = now;
      item.firedLateMs = late;
      fired.push(item);
      this.publish?.('reminder.due', {
        item: { ...toSnapshot(item, now), firedLateMs: late },
      });
    }
    if (due.length > 0) {
      this.save();
      this.cleanup();
      this.arm();
    }
    return fired;
  }

  private cleanup(): void {
    const now = this.now();
    const keepMs = this.keepFiredDays * 86_400_000;
    const before = this.items.length;
    this.items = this.items.filter((item) => {
      if (item.status === 'pending') return true;
      const endedAt = item.firedAt ?? item.at;
      return now - endedAt <= keepMs;
    });
    if (this.items.length !== before) this.save();
  }

  private arm(): void {
    this.disarm();
    if (!this.armTimers) return;
    const next = this.pendingItems()[0];
    if (!next) return;
    const wait = Math.max(0, Math.min(MAX_TIMER_DELAY, next.at - this.now()));
    try {
      const handle = this.setTimer(() => {
        this.timer = null;
        try {
          this.tick();
        } catch (e) {
          this.log?.warn('提醒 tick 失败', { error: (e as Error).message });
        }
        this.arm();
      }, wait);
      if (isObject(handle) && 'unref' in handle && typeof (handle as { unref?: unknown }).unref === 'function') {
        (handle as { unref: () => void }).unref();
      }
      this.timer = handle;
    } catch (e) {
      this.log?.warn('提醒定时器安装失败', { error: (e as Error).message });
    }
  }

  private disarm(): void {
    if (this.timer === null) return;
    try {
      this.clearTimer(this.timer);
    } catch {
      /* 忽略 */
    }
    this.timer = null;
  }
}
