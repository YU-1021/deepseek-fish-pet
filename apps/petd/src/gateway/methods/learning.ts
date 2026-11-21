/**
 * 学习闭环方法：learning.status / list / get / propose / approve / reject / rollback。
 *
 * - `learning.propose` 是 AI 写候选的通道：只写到 proposals/ 或 skills/staging/，不直接影响运行时；
 * - `learning.approve` / `learning.reject` / `learning.rollback` 是人的动作：AI 的聊天工具里不暴露这三个；
 * - 批准技能会把它转正成 `skills/<name>/SKILL.md`（下一轮提示词就加载）；批准其他类型写成
 *   `learning/<name>.agent.json`，由学习服务拼进系统提示词（灰度按配置抽样）。
 */
import { Type } from '@sinclair/typebox';
import type { GatewayContext } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { LearningItemDetail, LearningKind, LearningService, LearningStatus } from '../../learning/service.js';
import { LEARNING_KINDS } from '../../learning/service.js';

const Kind = Type.Union(LEARNING_KINDS.map((kind) => Type.Literal(kind)));
const Status = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('gray'),
  Type.Literal('rejected'),
  Type.Literal('rolledback'),
]);

const Gray = Type.Object({
  percent: Type.Integer({ minimum: 0, maximum: 100 }),
  startedAt: Type.Integer({ minimum: 0 }),
  rollbackAfterDays: Type.Integer({ minimum: 0 }),
});

const LearningItemSchema = Type.Object({
  id: Type.String(),
  kind: Kind,
  name: Type.String(),
  reason: Type.String(),
  path: Type.String(),
  createdAt: Type.Integer({ minimum: 0 }),
  status: Status,
  diff: Type.Optional(Type.String()),
  contentChars: Type.Integer({ minimum: 0 }),
  gray: Type.Optional(Gray),
});

const LearningItemDetailSchema = Type.Composite([LearningItemSchema, Type.Object({ body: Type.String() })]);

export interface LearningMethodDeps {
  learning: LearningService;
}

export function registerLearningMethods(reg: MethodRegistry, deps: LearningMethodDeps): void {
  reg.register(
    {
      name: 'learning.status',
      scope: 'read',
      description: '学习闭环状态：开关/各类数量/待审提案/生效中的灰度',
      result: Type.Object({
        enabled: Type.Boolean(),
        requireApproval: Type.Boolean(),
        counts: Type.Object({
          pending: Type.Integer({ minimum: 0 }),
          approved: Type.Integer({ minimum: 0 }),
          gray: Type.Integer({ minimum: 0 }),
          rejected: Type.Integer({ minimum: 0 }),
          rolledback: Type.Integer({ minimum: 0 }),
        }),
        pending: Type.Array(LearningItemSchema),
        activeGray: Type.Array(
          Type.Object({
            id: Type.String(),
            name: Type.String(),
            kind: Kind,
            gray: Type.Optional(Gray),
          })
        ),
        dirs: Type.Object({ proposals: Type.String(), staging: Type.String(), approved: Type.String() }),
        maxPending: Type.Integer({ minimum: 1 }),
      }),
    },
    () => deps.learning.status()
  );

  reg.register(
    {
      name: 'learning.list',
      scope: 'read',
      description: '学习条目（提案/候选技能/已批准结果），新→旧；可按 kind/status 过滤',
      params: Type.Object({
        kind: Type.Optional(Kind),
        status: Type.Optional(Status),
      }),
      result: Type.Object({ items: Type.Array(LearningItemSchema) }),
    },
    (params) => {
      const p = params as { kind?: LearningKind; status?: LearningStatus };
      return {
        items: deps.learning.list({
          ...(p.kind === undefined ? {} : { kind: p.kind }),
          ...(p.status === undefined ? {} : { status: p.status }),
        }),
      };
    }
  );

  reg.register(
    {
      name: 'learning.get',
      scope: 'read',
      description: '单条学习条目：候选正文（技能是 SKILL.md 正文，提案是原文）',
      params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      result: Type.Object({ item: LearningItemDetailSchema }),
    },
    (params) => {
      const p = params as { id: string };
      return { item: deps.learning.get(p.id) };
    }
  );

  reg.register(
    {
      name: 'learning.propose',
      scope: 'write',
      description: 'AI 写候选：技能写 skills/staging，其他写 proposals（不影响运行时，等主人批准）',
      params: Type.Object({
        kind: Kind,
        name: Type.String({ minLength: 1, maxLength: 64 }),
        content: Type.String({ minLength: 1, maxLength: 20_000 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
        diff: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      result: Type.Object({ item: LearningItemDetailSchema }),
      timeoutMs: 20_000,
    },
    (params: unknown, _ctx: GatewayContext) => {
      const p = params as { kind: LearningKind; name: string; content: string; reason: string; diff?: string };
      const item = deps.learning.propose({
        kind: p.kind,
        name: p.name,
        content: p.content,
        reason: p.reason,
        ...(p.diff === undefined ? {} : { diff: p.diff }),
      });
      return { item };
    }
  );

  reg.register(
    {
      name: 'learning.approve',
      scope: 'write',
      description: '人批准：技能转正到 skills/<name>/SKILL.md，其他写 learning/ 并在提示词里生效（可灰度）',
      params: Type.Object({
        id: Type.String({ minLength: 1 }),
        gray: Type.Optional(Type.Boolean()),
        force: Type.Optional(Type.Boolean()),
      }),
      result: Type.Object({ item: LearningItemDetailSchema }),
      idempotent: false,
      dangerous: true,
      timeoutMs: 30_000,
    },
    (params, _ctx: GatewayContext) => {
      const p = params as { id: string; gray?: boolean; force?: boolean };
      const item: LearningItemDetail = deps.learning.approve(p.id, {
        ...(p.gray === undefined ? {} : { gray: p.gray }),
        ...(p.force === undefined ? {} : { force: p.force }),
      });
      return { item };
    }
  );

  reg.register(
    {
      name: 'learning.reject',
      scope: 'write',
      description: '人拒绝一条提案（保留文件做历史，只改状态）',
      params: Type.Object({
        id: Type.String({ minLength: 1 }),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      result: Type.Object({ item: LearningItemDetailSchema }),
      idempotent: false,
      timeoutMs: 20_000,
    },
    (params) => {
      const p = params as { id: string; reason?: string };
      const item = deps.learning.reject(p.id, p.reason);
      return { item };
    }
  );

  reg.register(
    {
      name: 'learning.rollback',
      scope: 'write',
      description: '人把已生效的学习条目撤掉（删技能/删学习结果，记审计）',
      params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      result: Type.Object({ item: LearningItemDetailSchema }),
      idempotent: false,
      dangerous: true,
      timeoutMs: 30_000,
    },
    (params) => {
      const p = params as { id: string };
      const item = deps.learning.rollback(p.id);
      return { item };
    }
  );
}
