/**
 * 自我迭代审计方法：agent.scope / agent.audit.list / agent.audit.get / agent.rollback。
 *
 * - 审计记录只追加，不提供修改/删除方法（INV-9）；
 * - agent.rollback 是「人」的撤销动作：AI 没有对应聊天工具，且标了 dangerous；
 * - 只允许回滚 `.agent.*` 动态文件；workspace 记忆的版本回滚走 memory.*。
 */
import { Type } from '@sinclair/typebox';
import type { GatewayContext } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import { AGENT_ZONES, MEMORY_ZONE, describeAgentWriteScope } from '../../kernel/agent-files.js';
import type { AgentAuditLog, AuditRollbackResult } from '../../kernel/agent-audit.js';

const ContentMeta = Type.Union([
  Type.Null(),
  Type.Object({ hash: Type.String(), bytes: Type.Integer({ minimum: 0 }), truncated: Type.Optional(Type.Boolean()) }),
]);

const AuditMeta = Type.Object({
  id: Type.String(),
  ts: Type.String(),
  actor: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]),
  action: Type.Union([Type.Literal('write'), Type.Literal('delete'), Type.Literal('rollback')]),
  path: Type.String(),
  zone: Type.Union([Type.Literal('agent-file'), Type.Literal('memory')]),
  reason: Type.String(),
  before: ContentMeta,
  after: ContentMeta,
  diffChars: Type.Integer({ minimum: 0 }),
  sessionId: Type.Optional(Type.String()),
});

const FullContent = Type.Union([
  Type.Null(),
  Type.Object({
    hash: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    text: Type.String(),
    truncated: Type.Optional(Type.Boolean()),
  }),
]);

const AuditFullEntry = Type.Object({
  id: Type.String(),
  ts: Type.String(),
  actor: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')]),
  action: Type.Union([Type.Literal('write'), Type.Literal('delete'), Type.Literal('rollback')]),
  path: Type.String(),
  zone: Type.Union([Type.Literal('agent-file'), Type.Literal('memory')]),
  reason: Type.String(),
  before: FullContent,
  after: FullContent,
  diff: Type.String(),
  sessionId: Type.Optional(Type.String()),
});

const RollbackResult = Type.Object({
  path: Type.String(),
  restored: Type.Union([Type.Literal('content'), Type.Literal('deleted')]),
  entry: AuditMeta,
});

export interface AgentMethodDeps {
  audit: AgentAuditLog;
  publish: (event: string, data?: unknown) => void;
}

export function registerAgentMethods(reg: MethodRegistry, deps: AgentMethodDeps): void {
  reg.register(
    {
      name: 'agent.scope',
      scope: 'read',
      description: 'AI 可写文件范围（后缀约定/可写目录）与审计文件位置',
      result: Type.Object({
        scope: Type.String(),
        memoryZone: Type.String(),
        zones: Type.Array(Type.String()),
        auditFile: Type.String(),
      }),
    },
    () => ({
      scope: describeAgentWriteScope(),
      memoryZone: MEMORY_ZONE,
      zones: [...AGENT_ZONES],
      auditFile: deps.audit.auditFile,
    })
  );

  reg.register(
    {
      name: 'agent.audit.list',
      scope: 'read',
      description: 'AI 动态文件的变更审计（新→旧，不含正文）：可按 path/actor 过滤',
      params: Type.Object({
        path: Type.Optional(Type.String({ minLength: 1 })),
        actor: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      result: Type.Object({ entries: Type.Array(AuditMeta), total: Type.Integer({ minimum: 0 }) }),
    },
    (params) => {
      const p = params as { path?: string; actor?: 'user' | 'agent' | 'system'; limit?: number };
      return deps.audit.list({
        ...(p.path === undefined ? {} : { path: p.path }),
        ...(p.actor === undefined ? {} : { actor: p.actor }),
        ...(p.limit === undefined ? {} : { limit: p.limit }),
      });
    }
  );

  reg.register(
    {
      name: 'agent.audit.get',
      scope: 'read',
      description: '单条审计详情：前后正文与行级 diff',
      params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      result: Type.Object({ entry: AuditFullEntry }),
    },
    (params) => {
      const p = params as { id: string };
      return { entry: deps.audit.get(p.id) };
    }
  );

  reg.register(
    {
      name: 'agent.rollback',
      scope: 'write',
      description: '人把某个动态文件回滚到某条审计记录之前（AI 不能调用；文件在那之后被改过需 force）',
      params: Type.Object({
        id: Type.String({ minLength: 1 }),
        force: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      result: RollbackResult,
      idempotent: false,
      dangerous: true,
      timeoutMs: 30_000,
    },
    (params: unknown, _ctx: GatewayContext) => {
      const p = params as { id: string; force?: boolean; reason?: string };
      const result: AuditRollbackResult = deps.audit.rollback(p.id, {
        ...(p.force === undefined ? {} : { force: p.force }),
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        actor: 'user',
      });
      deps.publish('agent.rollback', {
        id: result.entry.id,
        targetId: p.id,
        path: result.path,
        restored: result.restored,
      });
      return result;
    }
  );
}
