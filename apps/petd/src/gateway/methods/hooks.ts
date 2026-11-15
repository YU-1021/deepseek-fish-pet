/**
 * hooks.* / approval.* 方法：规则 CRUD + 审批门状态与回答。
 *
 * hooks.status/list/get 是只读；create/update/delete/toggle 与 approval.answer 是写。
 * 规则本身可被用户规则覆盖（priority 更小的先命中），内置规则 priority=100。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { ApprovalBroker } from '../../hooks/approval.js';
import type { HookStore, HookRuleInput } from '../../hooks/store.js';
import type { HooksService } from '../../hooks/service.js';

const RuleIdSchema = Type.String({ minLength: 1, maxLength: 41 });
const KindSchema = Type.Union([Type.Literal('tool'), Type.Literal('method')]);
const ActionSchema = Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]);

const RuleSchema = Type.Object({
  id: RuleIdSchema,
  description: Type.String(),
  enabled: Type.Boolean(),
  kind: KindSchema,
  names: Type.Array(Type.String()),
  action: ActionSchema,
  message: Type.Optional(Type.String()),
  argContains: Type.Optional(Type.String()),
  priority: Type.Integer(),
  builtin: Type.Optional(Type.Boolean()),
});

const CreateSchema = Type.Object({
  id: Type.Optional(RuleIdSchema),
  description: Type.Optional(Type.String({ maxLength: 120 })),
  enabled: Type.Optional(Type.Boolean()),
  kind: KindSchema,
  names: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
  action: ActionSchema,
  message: Type.Optional(Type.String({ maxLength: 300 })),
  argContains: Type.Optional(Type.String({ maxLength: 200 })),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
});

const UpdateSchema = Type.Object({
  id: RuleIdSchema,
  description: Type.Optional(Type.String({ maxLength: 120 })),
  enabled: Type.Optional(Type.Boolean()),
  kind: Type.Optional(KindSchema),
  names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 })),
  action: Type.Optional(ActionSchema),
  message: Type.Optional(Type.String({ maxLength: 300 })),
  argContains: Type.Optional(Type.String({ maxLength: 200 })),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
});

export interface HooksMethodDeps {
  store: HookStore;
  approval: ApprovalBroker;
  service: HooksService;
  config: () => { enabled: boolean; approvalEnabled: boolean; approvalTimeoutMs: number };
}

export function registerHooksMethods(reg: MethodRegistry, deps: HooksMethodDeps): void {
  const cfg = deps.config;

  reg.register(
    {
      name: 'hooks.status',
      scope: 'read',
      description: '审批门状态：开关/规则数/本次允许数/待答数',
      result: Type.Object({
        enabled: Type.Boolean(),
        approvalEnabled: Type.Boolean(),
        approvalTimeoutMs: Type.Integer(),
        ruleCount: Type.Integer(),
        sessionAllowedCount: Type.Integer(),
        pendingCount: Type.Integer(),
      }),
    },
    () => ({
      enabled: cfg().enabled,
      approvalEnabled: cfg().approvalEnabled,
      approvalTimeoutMs: cfg().approvalTimeoutMs,
      ruleCount: deps.store.list().length,
      sessionAllowedCount: deps.service.sessionAllowedCount(),
      pendingCount: deps.approval.count(),
    })
  );

  reg.register(
    {
      name: 'hooks.list',
      scope: 'read',
      description: '列出所有钩子规则（内置 + 用户），按 priority 升序',
      result: Type.Object({ rules: Type.Array(RuleSchema) }),
    },
    () => ({ rules: deps.store.list() })
  );

  reg.register(
    {
      name: 'hooks.get',
      scope: 'read',
      description: '按 id 取一条钩子规则',
      params: Type.Object({ id: RuleIdSchema }),
      result: RuleSchema,
    },
    (params) => {
      const p = params as { id: string };
      const rule = deps.store.get(p.id);
      if (rule === null) throw new PetdError('E_NOT_FOUND', `规则不存在：${p.id}`);
      return rule;
    }
  );

  reg.register(
    {
      name: 'hooks.create',
      scope: 'write',
      description: '新建一条钩子规则（用户规则默认 priority=10，可覆盖内置规则）',
      params: CreateSchema,
      result: RuleSchema,
      idempotent: false,
    },
    (params) => {
      const p = params as HookRuleInput;
      const input: HookRuleInput = {
        kind: p.kind,
        names: p.names,
        action: p.action,
        ...(p.id === undefined ? {} : { id: p.id }),
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
        ...(p.message === undefined ? {} : { message: p.message }),
        ...(p.argContains === undefined ? {} : { argContains: p.argContains }),
        ...(p.priority === undefined ? {} : { priority: p.priority }),
      };
      return deps.store.create(input);
    }
  );

  reg.register(
    {
      name: 'hooks.update',
      scope: 'write',
      description: '改一条钩子规则（只改传入的字段）',
      params: UpdateSchema,
      result: RuleSchema,
      idempotent: false,
    },
    (params) => {
      const p = params as HookRuleInput & { id: string };
      const patch: Partial<HookRuleInput> = {};
      if (p.description !== undefined) patch.description = p.description;
      if (p.enabled !== undefined) patch.enabled = p.enabled;
      if (p.kind !== undefined) patch.kind = p.kind;
      if (p.names !== undefined) patch.names = p.names;
      if (p.action !== undefined) patch.action = p.action;
      if (p.message !== undefined) patch.message = p.message;
      if (p.argContains !== undefined) patch.argContains = p.argContains;
      if (p.priority !== undefined) patch.priority = p.priority;
      return deps.store.update(p.id, patch);
    }
  );

  reg.register(
    {
      name: 'hooks.delete',
      scope: 'write',
      description: '删除一条钩子规则',
      params: Type.Object({ id: RuleIdSchema }),
      result: Type.Object({ deleted: Type.Boolean() }),
      idempotent: false,
    },
    (params) => ({ deleted: deps.store.remove((params as { id: string }).id) })
  );

  reg.register(
    {
      name: 'hooks.toggle',
      scope: 'write',
      description: '启用/停用一条钩子规则',
      params: Type.Object({ id: RuleIdSchema, enabled: Type.Boolean() }),
      result: RuleSchema,
      idempotent: false,
    },
    (params) => {
      const p = params as { id: string; enabled: boolean };
      return deps.store.toggle(p.id, p.enabled);
    }
  );

  reg.register(
    {
      name: 'approval.list',
      scope: 'read',
      description: '当前还在等用户回答的审批请求',
      result: Type.Object({
        pending: Type.Array(
          Type.Object({
            id: Type.String(),
            kind: KindSchema,
            name: Type.String(),
            ruleId: Type.String(),
            title: Type.String(),
            detail: Type.Optional(Type.String()),
            requestedAt: Type.Integer(),
            deadlineAt: Type.Integer(),
          })
        ),
      }),
    },
    () => ({ pending: deps.approval.pendingApprovals() })
  );

  reg.register(
    {
      name: 'approval.answer',
      scope: 'write',
      description: '回答一个审批请求（同意/拒绝，可选「本次记住」）',
      params: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 40 }),
        accepted: Type.Boolean(),
        remember: Type.Optional(Type.Boolean()),
      }),
      result: Type.Object({ found: Type.Boolean() }),
      idempotent: false,
    },
    (params) => {
      const p = params as { id: string; accepted: boolean; remember?: boolean };
      return { found: deps.approval.answer(p.id, p.accepted, p.remember === true) };
    }
  );
}
