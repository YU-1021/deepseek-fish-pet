/**
 * 自动化 / 自主任务：定时任务管理 + 手动触发 + 运行记录。
 *
 * - schedule 四种：interval（每 N 分钟）/ daily（每天 HH:MM）/ once（一次性）/ manual（只手动跑）。
 * - 定时执行由 AutomationStore 内部的 tick 驱动，这一层只做参数校验/转发。
 * - 总开关关闭时：读方法仍可用（看得到已有任务），写方法/手动跑返回 E_UNAVAILABLE。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { AutomationJobSnapshot, AutomationRunSnapshot, AutomationStore } from '../../automation/store.js';
import { validateScheduleInput } from '../../automation/store.js';
import type { MethodRegistry } from '../registry.js';

export interface AutomationMethodDeps {
  store: AutomationStore;
  enabled: () => boolean;
}

const ScheduleSchema = Type.Union([
  Type.Object({ kind: Type.Literal('interval'), everyMinutes: Type.Number({ minimum: 1, maximum: 43_200 }) }),
  Type.Object({ kind: Type.Literal('daily'), atClock: Type.String({ maxLength: 10 }) }),
  Type.Object({ kind: Type.Literal('once'), at: Type.Union([Type.Integer(), Type.String({ maxLength: 40 })]) }),
  Type.Object({ kind: Type.Literal('manual') }),
]);

const JobSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  prompt: Type.String(),
  schedule: ScheduleSchema,
  scheduleText: Type.String(),
  enabled: Type.Boolean(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  nextRunAt: Type.Union([Type.Integer(), Type.Null()]),
  nextInMinutes: Type.Union([Type.Integer(), Type.Null()]),
  lastRunAt: Type.Union([Type.Integer(), Type.Null()]),
  lastStatus: Type.Union([Type.String(), Type.Null()]),
  runCount: Type.Integer(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
});

const UsageSchema = Type.Object({
  promptTokens: Type.Optional(Type.Integer()),
  completionTokens: Type.Optional(Type.Integer()),
  totalTokens: Type.Optional(Type.Integer()),
});

const RunSchema = Type.Object({
  id: Type.String(),
  jobId: Type.String(),
  jobName: Type.String(),
  startedBy: Type.String(),
  status: Type.String(),
  startedAt: Type.Integer(),
  finishedAt: Type.Union([Type.Integer(), Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  output: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  usage: Type.Union([UsageSchema, Type.Null()]),
});

function jobOf(job: AutomationJobSnapshot): unknown {
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    scheduleText: job.scheduleText,
    enabled: job.enabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextRunAt: job.nextRunAt,
    nextInMinutes: job.nextInMinutes,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    runCount: job.runCount,
    sessionId: job.sessionId,
  };
}

function runOf(run: AutomationRunSnapshot): unknown {
  return {
    id: run.id,
    jobId: run.jobId,
    jobName: run.jobName,
    startedBy: run.startedBy,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    output: run.output,
    error: run.error,
    usage: run.usage,
  };
}

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }) });

function ensureEnabled(deps: AutomationMethodDeps): void {
  if (!deps.enabled()) throw new PetdError('E_UNAVAILABLE', '自动化已关闭（config.automation.enabled=false）');
}

export function registerAutomationMethods(reg: MethodRegistry, deps: AutomationMethodDeps): void {
  reg.register(
    {
      name: 'automation.status',
      scope: 'read',
      description: '自动化任务概况：总开关、任务数、下一次运行、是否正在跑',
      result: Type.Object({
        enabled: Type.Boolean(),
        jobs: Type.Integer(),
        enabledJobs: Type.Integer(),
        running: Type.Boolean(),
        nextAt: Type.Union([Type.Integer(), Type.Null()]),
        lastRunAt: Type.Union([Type.Integer(), Type.Null()]),
      }),
    },
    () => deps.store.status()
  );

  reg.register(
    {
      name: 'automation.list',
      scope: 'read',
      description: '全部自动化任务（按下一次运行时间排序，手动任务排最后）',
      result: Type.Object({ jobs: Type.Array(JobSchema) }),
    },
    () => ({ jobs: deps.store.listJobs().map(jobOf) })
  );

  reg.register(
    {
      name: 'automation.get',
      scope: 'read',
      description: '查看一条自动化任务',
      params: IdParams,
      result: JobSchema,
    },
    (params) => {
      const p = params as { id: string };
      const job = deps.store.getJob(p.id);
      if (!job) throw new PetdError('E_NOT_FOUND', `没有编号为 ${p.id} 的自动化任务`);
      return jobOf(job);
    }
  );

  reg.register(
    {
      name: 'automation.create',
      scope: 'write',
      description: '新建自动化任务：prompt + schedule（interval/daily/once/manual）',
      params: Type.Object({
        name: Type.Optional(Type.String({ maxLength: 40 })),
        prompt: Type.String({ minLength: 1, maxLength: 2000 }),
        schedule: ScheduleSchema,
        enabled: Type.Optional(Type.Boolean()),
      }),
      result: JobSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as {
        name?: string;
        prompt: string;
        schedule: unknown;
        enabled?: boolean;
      };
      const schedule = validateScheduleInput(p.schedule, Date.now());
      const job = deps.store.create({
        ...(p.name === undefined ? {} : { name: p.name }),
        prompt: p.prompt,
        schedule,
        ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
      });
      return jobOf(job);
    }
  );

  reg.register(
    {
      name: 'automation.update',
      scope: 'write',
      description: '修改自动化任务（名称/内容/计划/是否启用）',
      params: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 40 }),
        name: Type.Optional(Type.String({ maxLength: 40 })),
        prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        schedule: Type.Optional(ScheduleSchema),
        enabled: Type.Optional(Type.Boolean()),
      }),
      result: JobSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string; name?: string; prompt?: string; schedule?: unknown; enabled?: boolean };
      const schedule = p.schedule === undefined ? undefined : validateScheduleInput(p.schedule, Date.now());
      const job = deps.store.update(p.id, {
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.prompt === undefined ? {} : { prompt: p.prompt }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
      });
      return jobOf(job);
    }
  );

  reg.register(
    {
      name: 'automation.delete',
      scope: 'write',
      description: '删除一条自动化任务（运行记录保留）',
      params: IdParams,
      result: Type.Object({ deleted: Type.Boolean(), id: Type.String() }),
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      deps.store.delete(p.id);
      return { deleted: true, id: p.id };
    }
  );

  reg.register(
    {
      name: 'automation.pause',
      scope: 'write',
      description: '暂停一条自动化任务（保留任务与记录）',
      params: IdParams,
      result: JobSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return jobOf(deps.store.pause(p.id));
    }
  );

  reg.register(
    {
      name: 'automation.resume',
      scope: 'write',
      description: '恢复一条自动化任务（按当前时间重算下一次）',
      params: IdParams,
      result: JobSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return jobOf(deps.store.resume(p.id));
    }
  );

  reg.register(
    {
      name: 'automation.run',
      scope: 'write',
      description: '立刻手动跑一次任务（等它跑完再返回；不改变下次定时时间）',
      params: IdParams,
      result: RunSchema,
      timeoutMs: 240_000,
      idempotent: false,
    },
    async (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return runOf(await deps.store.runNow(p.id));
    }
  );

  reg.register(
    {
      name: 'automation.runs',
      scope: 'read',
      description: '最近的运行记录（可按任务过滤，新→旧）',
      params: Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      result: Type.Object({ runs: Type.Array(RunSchema) }),
    },
    (params) => {
      const p = params as { id?: string; limit?: number };
      return { runs: deps.store.listRuns(p.id, p.limit ?? 50).map(runOf) };
    }
  );
}
