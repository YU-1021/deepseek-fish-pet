/**
 * 人格方法与自编辑：persona.get / patch / lock / history / rollback / evolve。
 *
 * 权限模型（阶段 2 简化版，审批门还没接）：
 *   - persona.patch：默认按「用户」处理，可改任何小节、忽略锁；
 *   - persona.lock：只对 AI 可编辑小节有效（世界观本来就只允许用户改）；
 *   - persona.evolve：AI 自演化，只改未上锁的 AI 小节，结果作为 persona.changed 广播。
 */
import { Type } from '@sinclair/typebox';
import type { GatewayContext } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { EvolveResult } from '../../persona/evolve.js';
import type { PersonaStore } from '../../persona/store.js';

const SectionView = Type.Object({
  key: Type.String(),
  heading: Type.String(),
  content: Type.String(),
  locked: Type.Boolean(),
  aiEditable: Type.Boolean(),
  userOnly: Type.Boolean(),
  source: Type.Optional(Type.Union([Type.Literal('core'), Type.Literal('agent')])),
});

const PersonaSnapshotResult = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String(),
  hash: Type.String(),
  title: Type.String(),
  preamble: Type.String(),
  content: Type.String(),
  sections: Type.Array(SectionView),
  locks: Type.Record(Type.String(), Type.Boolean()),
  coreFile: Type.String(),
  agentFile: Type.String(),
  hasAgentOverrides: Type.Boolean(),
});

const PatchResult = Type.Object({
  changed: Type.Boolean(),
  version: Type.Integer({ minimum: 1 }),
  applied: Type.Array(Type.String()),
  skipped: Type.Array(Type.String()),
  rejected: Type.Array(Type.Object({ key: Type.String(), reason: Type.String() })),
});

const EvolveResultSchema = Type.Intersect([
  PatchResult,
  Type.Object({
    reason: Type.String(),
    raw: Type.Optional(Type.String()),
  }),
]);

const HistoryItem = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  ts: Type.String(),
  actor: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]),
  reason: Type.String(),
  changedKeys: Type.Array(Type.String()),
});

export interface PersonaMethodDeps {
  store: PersonaStore;
  evolve: (input: { sessionId?: string; signal?: AbortSignal }) => Promise<EvolveResult>;
  publish: (event: string, data?: unknown) => void;
}

export function registerPersonaMethods(reg: MethodRegistry, deps: PersonaMethodDeps): void {
  reg.register(
    {
      name: 'persona.get',
      scope: 'read',
      description: '读取当前人格：SOUL.md 全文 + 按小节拆开的视图 + 锁状态 + 版本',
      result: PersonaSnapshotResult,
    },
    () => deps.store.read()
  );

  reg.register(
    {
      name: 'persona.patch',
      scope: 'write',
      description: '用户改人格（按小节）：sections={key: 完整新正文}；忽略锁；可带 expectedVersion 防并发覆盖',
      params: Type.Object({
        sections: Type.Record(Type.String(), Type.String({ maxLength: 8000 })),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
        expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      result: PatchResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { sections: Record<string, string>; reason?: string; expectedVersion?: number };
      const result = deps.store.patch({
        sections: p.sections,
        actor: 'user',
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        ...(p.expectedVersion === undefined ? {} : { expectedVersion: p.expectedVersion }),
      });
      if (result.changed) {
        deps.publish('persona.changed', {
          version: result.version,
          actor: 'user',
          applied: result.applied,
          reason: p.reason ?? '',
        });
      }
      return result;
    }
  );

  reg.register(
    {
      name: 'persona.lock',
      scope: 'write',
      description: '给 AI 可编辑小节上锁/解锁（上锁后 AI 不能改，用户仍可改）',
      params: Type.Object({ key: Type.String({ minLength: 1 }), locked: Type.Boolean() }),
      result: Type.Object({ locks: Type.Record(Type.String(), Type.Boolean()) }),
      idempotent: true,
    },
    (params) => {
      const p = params as { key: string; locked: boolean };
      const locks = deps.store.setLock(p.key, p.locked);
      deps.publish('persona.changed', { version: deps.store.read().version, actor: 'user', applied: [], reason: p.locked ? '上锁' : '解锁' });
      return { locks };
    }
  );

  reg.register(
    {
      name: 'persona.history',
      scope: 'read',
      description: '人格历史版本（新→旧，含改动小节与原因，不含全文快照）',
      params: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      result: Type.Object({ revisions: Type.Array(HistoryItem) }),
    },
    (params) => {
      const p = params as { limit?: number };
      return { revisions: deps.store.history(p.limit ?? 20) };
    }
  );

  reg.register(
    {
      name: 'persona.rollback',
      scope: 'write',
      description: '回滚人格到某个历史版本（内容取该版本完整快照）',
      params: Type.Object({ version: Type.Integer({ minimum: 1 }) }),
      result: PatchResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { version: number };
      const result = deps.store.rollback(p.version);
      deps.publish('persona.changed', { version: result.version, actor: 'user', applied: ['*'], reason: `回滚到 v${p.version}` });
      return result;
    }
  );

  reg.register(
    {
      name: 'persona.evolve',
      scope: 'write',
      description: 'AI 自演化：根据最近对话提出一次小额人格改动，只改未上锁的 AI 可编辑小节',
      params: Type.Object({
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      result: EvolveResultSchema,
      timeoutMs: 120_000,
      idempotent: false,
      dangerous: false,
    },
    async (params, ctx: GatewayContext) => {
      const p = params as { sessionId?: string; reason?: string };
      const result = await deps.evolve({
        ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
        signal: ctx.signal,
      });
      if (result.changed) {
        deps.publish('persona.changed', {
          version: result.version,
          actor: 'agent',
          applied: result.applied,
          reason: result.reason,
        });
      }
      return result;
    }
  );
}
