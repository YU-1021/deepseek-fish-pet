/**
 * 自动化 / 自主任务：定时任务（interval / daily / once / manual）+ 后台运行记录。
 *
 * 形状参考 OpenClaw 的 cron 与常驻 agent runtime（MIT 生态，只取思路），按 petd 常驻进程重写：
 * - 任务落盘 home/state/automations.json，重启后保留定义与运行记录；
 * - 到期由 tick() 统一驱动，串行执行（同一时间只跑一个任务，避免并发 token 爆炸）；
 * - 任务执行体由外部注入（index.ts 接 ChatService：在专用会话里跑一轮聊天），
 *   store 本身不懂聊天/工具，单测可以注入 fake runner；
 * - 每次运行都记一条 AutomationRun（状态 / 输出 / usage / 错误），只保留最近 maxRunsKept 条；
 * - 关停期间错过的任务超过 catchUpMinutes 就不再补跑，直接排下一次（避免开机连跑一堆）；
 * - 事件：automation.job.created / updated / deleted、
 *   automation.run.started / succeeded / failed / cancelled、automation.skipped。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';

export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; atClock: string }
  | { kind: 'once'; at: number }
  | { kind: 'manual' };

export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationRunStartedBy = 'schedule' | 'manual';
export type AutomationLastStatus = 'succeeded' | 'failed' | 'cancelled';

export interface AutomationUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AutomationJob {
  id: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastStatus?: AutomationLastStatus;
  runCount: number;
  /** 专用会话 id：第一次跑的时候由 runner 建好并回写 */
  sessionId?: string;
}

export interface AutomationRun {
  id: string;
  jobId: string;
  jobName: string;
  prompt: string;
  startedBy: AutomationRunStartedBy;
  status: AutomationRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  output?: string;
  error?: string;
  usage?: AutomationUsage;
}

interface AutomationFile {
  version: 1;
  jobSeq: number;
  runSeq: number;
  jobs: AutomationJob[];
  runs: AutomationRun[];
}

/** 给 UI/方法返回的轻量视图 */
export interface AutomationJobSnapshot {
  id: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  scheduleText: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  /** 距下一次还有多少分钟（向上取整；没有下一次为 null） */
  nextInMinutes: number | null;
  lastRunAt: number | null;
  lastStatus: AutomationLastStatus | null;
  runCount: number;
  sessionId: string | null;
}

export interface AutomationRunSnapshot {
  id: string;
  jobId: string;
  jobName: string;
  startedBy: AutomationRunStartedBy;
  status: AutomationRunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  usage: AutomationUsage | null;
}

export interface AutomationStatusSummary {
  enabled: boolean;
  jobs: number;
  enabledJobs: number;
  running: boolean;
  nextAt: number | null;
  lastRunAt: number | null;
}

/** runner 的返回：output 会成为运行记录；sessionId 第一次建好后回写 */
export interface AutomationRunOutput {
  output: string;
  usage?: AutomationUsage;
  sessionId?: string;
}

export interface AutomationStoreOptions {
  /** 状态文件绝对路径（通常是 home/state/automations.json） */
  file: string;
  now?: () => number;
  log?: {
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
  };
  publish?: (event: string, data: unknown) => void;
  /** 总开关（config.automation.enabled）；返回 false 时定时任务不跑 */
  enabled?: () => boolean;
  tickSeconds?: number;
  catchUpMinutes?: number;
  maxJobs?: number;
  maxRunsKept?: number;
  runTimeoutMs?: number;
  /** 是否真的装 setInterval（单测里传 false，用 tick() 手动驱动） */
  armTimers?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 执行一次任务；抛错 = 失败；signal 用于超时取消 */
  runJob: (job: AutomationJob, signal: AbortSignal) => Promise<AutomationRunOutput>;
}

const MAX_NAME_CHARS = 40;
const MAX_PROMPT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_ERROR_CHARS = 500;
const MAX_MINUTES_AHEAD = 60 * 24 * 30;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时间（给模型/UI 看的，形如 2026-11-15 20:30） */
export function formatAt(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function clampName(raw: string | undefined, prompt: string): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (name) return name.slice(0, MAX_NAME_CHARS);
  const firstLine = prompt.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '未命名任务';
  return firstLine.slice(0, 20);
}

function parseAtClock(value: string, now: number): number {
  const m = String(value).trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) throw new PetdError('E_BAD_PARAMS', 'atClock 格式要像 08:30 或 21:05');
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new PetdError('E_BAD_PARAMS', '时间不合法（小时 0-23、分钟 0-59）');
  const d = new Date(now);
  d.setHours(h, mi, 0, 0);
  let at = d.getTime();
  if (at <= now) at += 24 * 3_600_000;
  return at;
}

/** 把外部输入（TypeBox 校验过但仍可能是 any）规范成 AutomationSchedule；非法抛 E_BAD_PARAMS */
export function validateScheduleInput(input: unknown, now: number): AutomationSchedule {
  if (!isObject(input)) throw new PetdError('E_BAD_PARAMS', 'schedule 必须是对象');
  const kind = input['kind'];
  if (kind === 'interval') {
    const raw = input['everyMinutes'];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1 || raw > MAX_MINUTES_AHEAD) {
      throw new PetdError('E_BAD_PARAMS', `everyMinutes 要在 1–${MAX_MINUTES_AHEAD} 之间`);
    }
    return { kind: 'interval', everyMinutes: Math.round(raw) };
  }
  if (kind === 'daily') {
    const raw = input['atClock'];
    if (typeof raw !== 'string') throw new PetdError('E_BAD_PARAMS', 'daily 要给 atClock（HH:MM）');
    const at = parseAtClock(raw, now);
    const d = new Date(at);
    return { kind: 'daily', atClock: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
  }
  if (kind === 'once') {
    const raw = input['at'];
    const at = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(at)) throw new PetdError('E_BAD_PARAMS', 'once 要给合法的 at（时间戳或 ISO 时间）');
    if (at <= now + 500) throw new PetdError('E_BAD_PARAMS', '这个任务时间已经过去了');
    return { kind: 'once', at: Math.round(at) };
  }
  if (kind === 'manual') return { kind: 'manual' };
  throw new PetdError('E_BAD_PARAMS', 'schedule.kind 只能是 interval / daily / once / manual');
}

/** 下一次运行时间；manual 返回 null；once 已过返回 null */
export function computeNextRun(schedule: AutomationSchedule, from: number, now: number): number | null {
  const ref = Math.max(from, now);
  if (schedule.kind === 'interval') return ref + Math.round(schedule.everyMinutes * 60_000);
  if (schedule.kind === 'daily') {
    const d = new Date(ref);
    const m = schedule.atClock.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    let at = d.getTime();
    if (at <= ref) at += 24 * 3_600_000;
    return at;
  }
  if (schedule.kind === 'once') return schedule.at > ref ? schedule.at : null;
  return null;
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`;
  if (schedule.kind === 'daily') return `每天 ${schedule.atClock}`;
  if (schedule.kind === 'once') return `一次性 ${formatAt(schedule.at)}`;
  return '手动';
}

function scheduleFromRaw(raw: unknown): AutomationSchedule | null {
  if (!isObject(raw)) return null;
  const kind = raw['kind'];
  if (kind === 'interval') {
    const v = raw['everyMinutes'];
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? { kind: 'interval', everyMinutes: Math.round(v) } : null;
  }
  if (kind === 'daily') {
    const v = raw['atClock'];
    return typeof v === 'string' && /^\d{1,2}:\d{1,2}$/.test(v) ? { kind: 'daily', atClock: v } : null;
  }
  if (kind === 'once') {
    const v = raw['at'];
    return typeof v === 'number' && Number.isFinite(v) ? { kind: 'once', at: Math.round(v) } : null;
  }
  if (kind === 'manual') return { kind: 'manual' };
  return null;
}

/** 解析状态文件（坏条目跳过，不整体报废） */
export function parseAutomationFile(text: string): AutomationFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const toInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const jobs: AutomationJob[] = [];
  for (const entry of Array.isArray(raw['jobs']) ? raw['jobs'] : []) {
    if (!isObject(entry)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    const prompt = typeof entry['prompt'] === 'string' ? entry['prompt'] : '';
    const schedule = scheduleFromRaw(entry['schedule']);
    if (!id || !prompt || !schedule) continue;
    const nextRunAt = typeof entry['nextRunAt'] === 'number' && Number.isFinite(entry['nextRunAt']) ? Math.round(entry['nextRunAt']) : null;
    const lastStatusRaw = entry['lastStatus'];
    const lastStatus: AutomationLastStatus | undefined =
      lastStatusRaw === 'succeeded' || lastStatusRaw === 'failed' || lastStatusRaw === 'cancelled' ? lastStatusRaw : undefined;
    jobs.push({
      id,
      name: typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim().slice(0, MAX_NAME_CHARS) : clampName(undefined, prompt),
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      schedule,
      enabled: entry['enabled'] === true,
      createdAt: toInt(entry['createdAt']),
      updatedAt: toInt(entry['updatedAt']),
      nextRunAt,
      ...(typeof entry['lastRunAt'] === 'number' && Number.isFinite(entry['lastRunAt']) ? { lastRunAt: Math.round(entry['lastRunAt']) } : {}),
      ...(lastStatus === undefined ? {} : { lastStatus }),
      runCount: toInt(entry['runCount']),
      ...(typeof entry['sessionId'] === 'string' && entry['sessionId'].trim() ? { sessionId: entry['sessionId'].trim() } : {}),
    });
  }
  const runs: AutomationRun[] = [];
  for (const entry of Array.isArray(raw['runs']) ? raw['runs'] : []) {
    if (!isObject(entry)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    const jobId = typeof entry['jobId'] === 'string' ? entry['jobId'].trim() : '';
    const statusRaw = entry['status'];
    if (!id || !jobId) continue;
    const status: AutomationRunStatus =
      statusRaw === 'succeeded' || statusRaw === 'failed' || statusRaw === 'cancelled' || statusRaw === 'running' ? statusRaw : 'failed';
    const usageRaw = entry['usage'];
    const usage: AutomationUsage | undefined = isObject(usageRaw)
      ? {
          ...(typeof usageRaw['promptTokens'] === 'number' ? { promptTokens: Math.round(usageRaw['promptTokens']) } : {}),
          ...(typeof usageRaw['completionTokens'] === 'number' ? { completionTokens: Math.round(usageRaw['completionTokens']) } : {}),
          ...(typeof usageRaw['totalTokens'] === 'number' ? { totalTokens: Math.round(usageRaw['totalTokens']) } : {}),
        }
      : undefined;
    runs.push({
      id,
      jobId,
      jobName: typeof entry['jobName'] === 'string' ? entry['jobName'] : '',
      prompt: typeof entry['prompt'] === 'string' ? entry['prompt'].slice(0, MAX_PROMPT_CHARS) : '',
      startedBy: entry['startedBy'] === 'manual' ? 'manual' : 'schedule',
      status,
      startedAt: toInt(entry['startedAt']),
      ...(typeof entry['finishedAt'] === 'number' && Number.isFinite(entry['finishedAt']) ? { finishedAt: Math.round(entry['finishedAt']) } : {}),
      ...(typeof entry['durationMs'] === 'number' && Number.isFinite(entry['durationMs']) ? { durationMs: Math.round(entry['durationMs']) } : {}),
      ...(typeof entry['output'] === 'string' ? { output: entry['output'].slice(0, MAX_OUTPUT_CHARS) } : {}),
      ...(typeof entry['error'] === 'string' ? { error: entry['error'].slice(0, MAX_ERROR_CHARS) } : {}),
      ...(usage === undefined ? {} : { usage }),
    });
  }
  return {
    version: 1,
    jobSeq: Math.max(toInt(raw['jobSeq']), jobs.length),
    runSeq: Math.max(toInt(raw['runSeq']), runs.length),
    jobs,
    runs,
  };
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

function jobSnapshot(job: AutomationJob, now: number): AutomationJobSnapshot {
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    scheduleText: describeSchedule(job.schedule),
    enabled: job.enabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextRunAt: job.nextRunAt,
    nextInMinutes: job.nextRunAt === null ? null : Math.ceil((job.nextRunAt - now) / 60_000),
    lastRunAt: job.lastRunAt ?? null,
    lastStatus: job.lastStatus ?? null,
    runCount: job.runCount,
    sessionId: job.sessionId ?? null,
  };
}

function runSnapshot(run: AutomationRun): AutomationRunSnapshot {
  return {
    id: run.id,
    jobId: run.jobId,
    jobName: run.jobName,
    startedBy: run.startedBy,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    output: run.output ?? null,
    error: run.error ?? null,
    usage: run.usage ?? null,
  };
}

export class AutomationStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log?: AutomationStoreOptions['log'];
  private readonly publish?: AutomationStoreOptions['publish'];
  private readonly enabled: () => boolean;
  private readonly tickSeconds: number;
  private readonly catchUpMinutes: number;
  private readonly maxJobs: number;
  private readonly maxRunsKept: number;
  private readonly runTimeoutMs: number;
  private readonly armTimers: boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly runJob: AutomationStoreOptions['runJob'];

  private jobSeq = 0;
  private runSeq = 0;
  private jobs: AutomationJob[] = [];
  private runs: AutomationRun[] = [];
  private timer: unknown = null;
  private busy = false;

  constructor(opts: AutomationStoreOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.publish = opts.publish;
    this.enabled = opts.enabled ?? (() => true);
    this.tickSeconds = Math.max(5, Math.round(opts.tickSeconds ?? 30));
    this.catchUpMinutes = opts.catchUpMinutes ?? 15;
    this.maxJobs = Math.max(1, Math.round(opts.maxJobs ?? 10));
    this.maxRunsKept = Math.max(1, Math.round(opts.maxRunsKept ?? 100));
    this.runTimeoutMs = Math.max(5_000, Math.round(opts.runTimeoutMs ?? 180_000));
    this.armTimers = opts.armTimers ?? true;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.runJob = opts.runJob;
  }

  ensure(): AutomationStatusSummary {
    this.load();
    this.cleanupRuns();
    // 重启后：禁用/manual 的任务没有下一次；已启用的补算一次（错过由 tick 的 catchUp 决定）
    const now = this.now();
    let changed = false;
    for (const job of this.jobs) {
      if (!job.enabled) {
        if (job.nextRunAt !== null) {
          job.nextRunAt = null;
          changed = true;
        }
        continue;
      }
      if (job.nextRunAt === null && job.schedule.kind !== 'manual' && job.schedule.kind !== 'once') {
        job.nextRunAt = computeNextRun(job.schedule, now, now);
        changed = true;
      }
    }
    if (changed) this.save();
    this.arm();
    return this.status();
  }

  stop(): void {
    this.disarm();
  }

  isEnabled(): boolean {
    try {
      return this.enabled();
    } catch {
      return false;
    }
  }

  private load(): void {
    try {
      const parsed = parseAutomationFile(fs.readFileSync(this.file, 'utf8'));
      if (!parsed) return;
      this.jobs = parsed.jobs;
      this.runs = parsed.runs;
      this.jobSeq = parsed.jobSeq;
      this.runSeq = parsed.runSeq;
    } catch {
      this.jobs = [];
      this.runs = [];
      this.jobSeq = 0;
      this.runSeq = 0;
    }
  }

  private save(): void {
    const data: AutomationFile = { version: 1, jobSeq: this.jobSeq, runSeq: this.runSeq, jobs: this.jobs, runs: this.runs };
    try {
      writeFileAtomic(this.file, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log?.warn('自动化状态写入失败', { error: (e as Error).message });
    }
  }

  status(): AutomationStatusSummary {
    const enabledJobs = this.jobs.filter((j) => j.enabled).length;
    const next = this.jobs
      .filter((j) => j.enabled && j.nextRunAt !== null)
      .map((j) => j.nextRunAt as number)
      .sort((a, b) => a - b)[0];
    const lastRun = this.runs.filter((r) => r.finishedAt !== undefined).map((r) => r.finishedAt as number).sort((a, b) => b - a)[0];
    return {
      enabled: this.isEnabled(),
      jobs: this.jobs.length,
      enabledJobs,
      running: this.busy,
      nextAt: next ?? null,
      lastRunAt: lastRun ?? null,
    };
  }

  listJobs(): AutomationJobSnapshot[] {
    const now = this.now();
    return [...this.jobs]
      .sort((a, b) => {
        const an = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
        const bn = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
        return an - bn;
      })
      .map((job) => jobSnapshot(job, now));
  }

  getJob(id: string): AutomationJobSnapshot | null {
    const job = this.jobs.find((j) => j.id === id);
    return job ? jobSnapshot(job, this.now()) : null;
  }

  create(input: {
    name?: string;
    prompt: string;
    schedule: AutomationSchedule;
    enabled?: boolean;
  }): AutomationJobSnapshot {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new PetdError('E_BAD_PARAMS', '任务内容（prompt）不能为空');
    if (prompt.length > MAX_PROMPT_CHARS) throw new PetdError('E_BAD_PARAMS', `任务内容太长（最多 ${MAX_PROMPT_CHARS} 字）`);
    if (this.jobs.length >= this.maxJobs) {
      throw new PetdError('E_UNAVAILABLE', `任务太多（最多 ${this.maxJobs} 条），先删掉几条再建`);
    }
    const now = this.now();
    const enabled = input.enabled ?? true;
    this.jobSeq += 1;
    const job: AutomationJob = {
      id: `a${this.jobSeq}`,
      name: clampName(input.name, prompt),
      prompt,
      schedule: input.schedule,
      enabled,
      createdAt: now,
      updatedAt: now,
      nextRunAt: null,
      runCount: 0,
    };
    if (enabled) job.nextRunAt = computeNextRun(job.schedule, now, now);
    this.jobs.push(job);
    this.save();
    this.publish?.('automation.job.created', { job: jobSnapshot(job, now) });
    return jobSnapshot(job, now);
  }

  update(
    id: string,
    patch: { name?: string; prompt?: string; schedule?: AutomationSchedule; enabled?: boolean }
  ): AutomationJobSnapshot {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new PetdError('E_NOT_FOUND', `没有编号为 ${id} 的自动化任务`);
    const now = this.now();
    if (patch.name !== undefined) job.name = clampName(patch.name, job.prompt);
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt) throw new PetdError('E_BAD_PARAMS', '任务内容（prompt）不能为空');
      if (prompt.length > MAX_PROMPT_CHARS) throw new PetdError('E_BAD_PARAMS', `任务内容太长（最多 ${MAX_PROMPT_CHARS} 字）`);
      job.prompt = prompt;
    }
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    job.updatedAt = now;
    job.nextRunAt = job.enabled ? computeNextRun(job.schedule, now, now) : null;
    this.save();
    this.publish?.('automation.job.updated', { job: jobSnapshot(job, now) });
    return jobSnapshot(job, now);
  }

  delete(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new PetdError('E_NOT_FOUND', `没有编号为 ${id} 的自动化任务`);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    this.publish?.('automation.job.deleted', { id, name: job.name });
  }

  pause(id: string): AutomationJobSnapshot {
    return this.update(id, { enabled: false });
  }

  resume(id: string): AutomationJobSnapshot {
    return this.update(id, { enabled: true });
  }

  listRuns(jobId?: string, limit = 50): AutomationRunSnapshot[] {
    const list = jobId ? this.runs.filter((r) => r.jobId === jobId) : this.runs;
    return list.slice(-Math.max(1, Math.min(500, limit))).reverse().map(runSnapshot);
  }

  /** 手动立刻跑一次（不改变下次定时时间） */
  async runNow(id: string): Promise<AutomationRunSnapshot> {
    if (!this.isEnabled()) throw new PetdError('E_UNAVAILABLE', '自动化已关闭（config.automation.enabled=false）');
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new PetdError('E_NOT_FOUND', `没有编号为 ${id} 的自动化任务`);
    const run = await this.execute(job, 'manual');
    return runSnapshot(run);
  }

  /** 到点检查；由定时器调用，也可手动驱动（测试）。返回本次启动的运行。 */
  async tick(): Promise<AutomationRunSnapshot[]> {
    if (!this.isEnabled() || this.busy) return [];
    const started: AutomationRunSnapshot[] = [];
    this.busy = true;
    try {
      const now = this.now();
      const due = this.jobs
        .filter((j) => j.enabled && j.nextRunAt !== null && (j.nextRunAt as number) <= now)
        .sort((a, b) => (a.nextRunAt as number) - (b.nextRunAt as number));
      for (const job of due) {
        const scheduledAt = job.nextRunAt as number;
        const lateMs = this.now() - scheduledAt;
        if (lateMs > this.catchUpMinutes * 60_000) {
          // 错过太久：不补跑，直接排下一次（一次性任务直接结束）
          this.advance(job, this.now());
          this.save();
          this.publish?.('automation.skipped', {
            jobId: job.id,
            name: job.name,
            reason: 'missed',
            scheduledAt,
            lateMs,
          });
          continue;
        }
        const run = await this.execute(job, 'schedule');
        started.push(runSnapshot(run));
      }
    } finally {
      this.busy = false;
    }
    return started;
  }

  private async execute(job: AutomationJob, startedBy: AutomationRunStartedBy): Promise<AutomationRun> {
    const startedAt = this.now();
    this.runSeq += 1;
    const run: AutomationRun = {
      id: `x${this.runSeq}`,
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
      startedBy,
      status: 'running',
      startedAt,
    };
    this.runs.push(run);
    this.cleanupRuns();
    this.save();
    this.publish?.('automation.run.started', { run: runSnapshot(run) });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.runTimeoutMs);
    timeout.unref?.();
    try {
      const result = await this.runJob(job, controller.signal);
      run.status = 'succeeded';
      run.output = String(result.output ?? '').slice(0, MAX_OUTPUT_CHARS);
      if (result.usage !== undefined) run.usage = result.usage;
      if (result.sessionId) job.sessionId = result.sessionId;
    } catch (e) {
      if (controller.signal.aborted) {
        run.status = 'cancelled';
        run.error = `运行超时（${this.runTimeoutMs}ms）`;
      } else {
        run.status = 'failed';
        run.error = String(e instanceof Error ? e.message : e).slice(0, MAX_ERROR_CHARS);
      }
    } finally {
      clearTimeout(timeout);
      const finishedAt = this.now();
      run.finishedAt = finishedAt;
      run.durationMs = Math.max(0, finishedAt - startedAt);
      job.lastRunAt = finishedAt;
      job.lastStatus = run.status === 'running' ? 'failed' : run.status;
      job.runCount += 1;
      if (startedBy === 'schedule') this.advance(job, finishedAt);
      this.save();
      this.publish?.(`automation.run.${run.status}`, { run: runSnapshot(run) });
    }
    return run;
  }

  /** 排下一次；一次性任务跑完即结束（enabled=false、nextRunAt=null） */
  private advance(job: AutomationJob, from: number): void {
    if (job.schedule.kind === 'once') {
      job.nextRunAt = null;
      job.enabled = false;
      return;
    }
    job.nextRunAt = job.enabled ? computeNextRun(job.schedule, from, this.now()) : null;
  }

  private cleanupRuns(): void {
    if (this.runs.length > this.maxRunsKept) {
      this.runs = this.runs.slice(-this.maxRunsKept);
    }
  }

  private arm(): void {
    this.disarm();
    if (!this.armTimers) return;
    try {
      const handle = this.setTimer(() => {
        void this.tick().catch((e) => this.log?.warn('自动化 tick 失败', { error: (e as Error).message }));
      }, this.tickSeconds * 1000);
      if (isObject(handle) && typeof (handle as { unref?: unknown }).unref === 'function') {
        (handle as { unref: () => void }).unref();
      }
      this.timer = handle;
    } catch (e) {
      this.log?.warn('自动化定时器安装失败', { error: (e as Error).message });
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
