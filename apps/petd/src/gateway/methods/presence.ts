/**
 * presence.* 方法：静默活动状态与手动触发。
 *
 * 静静活动默认自动进行（定时器），只广播 presence.activity 给前端做小动画；
 * 不写聊天、不朗读、不调模型。presence.run_once 供 UI/冒烟手动来一次。
 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { PresenceService } from '../../presence/service.js';

const KindSchema = Type.Union([
  Type.Literal('groom'),
  Type.Literal('stretch'),
  Type.Literal('window'),
  Type.Literal('nap'),
  Type.Literal('tidy'),
  Type.Literal('idle'),
]);

const ActivitySchema = Type.Object({
  id: Type.String(),
  kind: KindSchema,
  label: Type.String(),
  at: Type.Number(),
});

const StatusSchema = Type.Object({
  enabled: Type.Boolean(),
  quiet: Type.Boolean(),
  intervalMinutes: Type.Integer(),
  idleMinutes: Type.Integer(),
  maxPerDay: Type.Integer(),
  nightQuiet: Type.Object({
    enabled: Type.Boolean(),
    start: Type.String(),
    end: Type.String(),
  }),
  nextAt: Type.Union([Type.Integer(), Type.Null()]),
  countToday: Type.Integer(),
  total: Type.Integer(),
  last: Type.Union([ActivitySchema, Type.Null()]),
});

export interface PresenceMethodDeps {
  presence: PresenceService;
}

export function registerPresenceMethods(reg: MethodRegistry, deps: PresenceMethodDeps): void {
  reg.register(
    {
      name: 'presence.status',
      scope: 'read',
      description: '静默活动状态：开关/间隔/闲置门槛/每日上限/夜间安静/下一次时间/今天次数',
      result: StatusSchema,
    },
    () => deps.presence.status()
  );

  reg.register(
    {
      name: 'presence.list',
      scope: 'read',
      description: '最近的静默活动记录（新→旧）',
      params: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      result: Type.Object({ activities: Type.Array(ActivitySchema) }),
    },
    (params) => {
      const p = (params ?? {}) as { limit?: number };
      return { activities: deps.presence.list(p.limit ?? 50) };
    }
  );

  reg.register(
    {
      name: 'presence.run_once',
      scope: 'write',
      description: '手动触发一次静默活动（忽略间隔/夜间/闲置，仍受开关与每日上限限制）',
      result: ActivitySchema,
      timeoutMs: 30_000,
      idempotent: false,
    },
    () => deps.presence.runOnce()
  );
}
