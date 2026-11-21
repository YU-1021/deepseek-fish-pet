/**
 * dsh.* 方法：petd ⇄ DSH 双向桥的门面。
 *
 * 读方向（不花钱）：dsh.status / dsh.observe —— 看桌面 GUI 会话在空闲还是干活。
 * 写方向（会花钱）：dsh.prompt 发任务不等待；dsh.ask 发任务并等这回合的回答。
 * 启动：dsh.start（观察默认已开，这会把 SDK runtime 也拉起来）；dsh.stop 全停。
 * 审批：dsh.approval.answer 回答 DSH 的审批请求（仅 approvalPolicy='ask' 时会有）。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { DshBridge } from '../../dsh/bridge.js';

const NullableInt = Type.Union([Type.Integer(), Type.Null()]);

const SessionSchema = Type.Object({
  sessionId: Type.String(),
  workspace: Type.String(),
  workspaceRaw: Type.String(),
  file: Type.String(),
  mtimeMs: Type.Integer(),
  size: Type.Integer(),
  state: Type.Union([Type.Literal('idle'), Type.Literal('thinking'), Type.Literal('working')]),
  active: Type.Boolean(),
  turn: Type.Union([Type.Integer(), Type.Null()]),
  step: Type.Union([Type.Integer(), Type.Null()]),
  tool: Type.Union([Type.String(), Type.Null()]),
  lastText: Type.Union([Type.String(), Type.Null()]),
  lastEventType: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Integer(),
  events: Type.Integer(),
});

const ObserverSchema = Type.Object({
  enabled: Type.Boolean(),
  sessionsDir: Type.String(),
  scanning: Type.Boolean(),
  scannedAt: NullableInt,
  session: Type.Union([Type.Null(), SessionSchema]),
  error: Type.Union([Type.String(), Type.Null()]),
});

const RuntimeSchema = Type.Union([
  Type.Null(),
  Type.Object({
    running: Type.Boolean(),
    pid: NullableInt,
    provider: Type.String(),
    model: Type.String(),
    cwd: Type.String(),
    serverInfo: Type.Union([Type.Null(), Type.Object({ name: Type.String(), version: Type.String() })]),
    startedAt: NullableInt,
    lastExitCode: NullableInt,
  }),
]);

const StatusSchema = Type.Object({
  enabled: Type.Boolean(),
  observe: Type.Boolean(),
  started: Type.Boolean(),
  runtime: RuntimeSchema,
  observer: ObserverSchema,
  paths: Type.Object({
    exePath: Type.String(),
    cliPath: Type.String(),
    cwd: Type.String(),
    sessionsDir: Type.String(),
  }),
  counters: Type.Object({
    prompts: Type.Integer(),
    asks: Type.Integer(),
    errors: Type.Integer(),
  }),
  lastError: Type.Union([Type.String(), Type.Null()]),
  lastPromptAt: NullableInt,
  pendingApprovals: Type.Integer(),
});

export interface DshMethodDeps {
  bridge: DshBridge;
}

export function registerDshMethods(reg: MethodRegistry, deps: DshMethodDeps): void {
  reg.register(
    {
      name: 'dsh.status',
      scope: 'read',
      description: 'DSH 桥状态：总开关/观察/运行时进程/路径/计数/待审批数',
      result: StatusSchema,
    },
    () => deps.bridge.status()
  );

  reg.register(
    {
      name: 'dsh.observe',
      scope: 'read',
      description: '观察桌面 GUI 最近活跃的 DSH 会话（只读）：空闲/思考中/正在用哪个工具',
      result: ObserverSchema,
    },
    () => deps.bridge.observe()
  );

  reg.register(
    {
      name: 'dsh.start',
      scope: 'write',
      description: '启动 DSH 桥：开观察并拉起私有 SDK runtime（约 1–2s；之后 prompt/ask 才不冷启动）',
      result: Type.Object({ started: Type.Boolean(), runtime: RuntimeSchema }),
      timeoutMs: 60_000,
      idempotent: false,
    },
    async () => {
      deps.bridge.start();
      // 顺手把 runtime 拉起来：失败时也要把真实错误给 UI，而不是假装成功
      await deps.bridge.warmup();
      return { started: true, runtime: deps.bridge.status().runtime };
    }
  );

  reg.register(
    {
      name: 'dsh.stop',
      scope: 'write',
      description: '停止 DSH 桥：关观察并结束私有 SDK runtime（不影响桌面 GUI 自己的会话）',
      result: Type.Object({ stopped: Type.Boolean() }),
      timeoutMs: 30_000,
      idempotent: false,
    },
    async () => {
      await deps.bridge.stop();
      return { stopped: true };
    }
  );

  reg.register(
    {
      name: 'dsh.prompt',
      scope: 'write',
      description: '给 DSH 发一条任务，立刻返回（回答/工具调用走 dsh.event 事件）',
      params: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
        sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      result: Type.Object({ sessionId: Type.String(), messageId: Type.String() }),
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = (params ?? {}) as { text?: unknown; sessionId?: unknown };
      if (typeof p.text !== 'string') throw new PetdError('E_BAD_PARAMS', '缺少参数 text');
      return deps.bridge.prompt(p.text, typeof p.sessionId === 'string' ? p.sessionId : undefined);
    }
  );

  reg.register(
    {
      name: 'dsh.ask',
      scope: 'write',
      description: '给 DSH 发一条任务并等这一回合结束，返回最终文字（含它自己用工具的时间）',
      params: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 5_000, maximum: 600_000 })),
      }),
      result: Type.Object({
        text: Type.String(),
        sessionId: Type.String(),
        turn: Type.Union([Type.Integer(), Type.Null()]),
        durationMs: Type.Integer(),
      }),
      timeoutMs: 620_000,
      idempotent: false,
    },
    async (params) => {
      const p = (params ?? {}) as { text?: unknown; timeoutMs?: unknown };
      if (typeof p.text !== 'string') throw new PetdError('E_BAD_PARAMS', '缺少参数 text');
      return deps.bridge.ask(p.text, typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined);
    }
  );

  reg.register(
    {
      name: 'dsh.approval.answer',
      scope: 'write',
      description: '回答 DSH 的审批请求（allowed-once/rejected/cancelled）；默认策略 reject 时不会有请求',
      params: Type.Object({
        id: Type.String({ minLength: 1 }),
        outcome: Type.Union([Type.Literal('allowed-once'), Type.Literal('rejected'), Type.Literal('cancelled')]),
      }),
      result: Type.Object({ resolved: Type.Boolean() }),
      idempotent: false,
    },
    (params) => {
      const p = (params ?? {}) as { id?: unknown; outcome?: unknown };
      if (typeof p.id !== 'string') throw new PetdError('E_BAD_PARAMS', '缺少参数 id');
      if (p.outcome !== 'allowed-once' && p.outcome !== 'rejected' && p.outcome !== 'cancelled') {
        throw new PetdError('E_BAD_PARAMS', 'outcome 必须是 allowed-once/rejected/cancelled');
      }
      return { resolved: deps.bridge.answerApproval(p.id, p.outcome) };
    }
  );
}
