/**
 * 提醒：创建/查看/取消/稍后提醒，到点由 ReminderStore 广播 `reminder.due`。
 *
 * - 时间三种给法（三选一）：inMinutes（N 分钟后）、atClock（HH:MM，今天过了算明天）、at（绝对时间戳/ISO）。
 * - 到点只发事件，不自动发消息——UI 可以弹窗/朗读，也可以调 chat.send 让她说出来。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { ReminderSnapshot, ReminderStore } from '../../reminders/store.js';
import type { MethodRegistry } from '../registry.js';

export interface ReminderMethodDeps {
  store: ReminderStore;
  enabled: () => boolean;
}

const ItemSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  at: Type.Integer(),
  inMinutes: Type.Integer(),
  createdAt: Type.Integer(),
  snoozes: Type.Integer(),
  source: Type.String(),
});

function itemOf(item: ReminderSnapshot): unknown {
  return {
    id: item.id,
    text: item.text,
    at: item.at,
    inMinutes: item.inMinutes,
    createdAt: item.createdAt,
    snoozes: item.snoozes,
    source: item.source,
  };
}

function ensureEnabled(deps: ReminderMethodDeps): void {
  if (!deps.enabled()) throw new PetdError('E_UNAVAILABLE', '提醒功能已关闭（config.reminders.enabled=false）');
}

export function registerReminderMethods(reg: MethodRegistry, deps: ReminderMethodDeps): void {
  reg.register(
    {
      name: 'reminder.status',
      scope: 'read',
      description: '提醒系统状态：待响条数、下一条的时间、定时器是否就绪',
      result: Type.Object({
        enabled: Type.Boolean(),
        pending: Type.Integer(),
        nextAt: Type.Union([Type.Integer(), Type.Null()]),
        armed: Type.Boolean(),
      }),
    },
    () => {
      const s = deps.store.status();
      return { enabled: deps.enabled(), pending: s.pending, nextAt: s.nextAt, armed: s.armed };
    }
  );

  reg.register(
    {
      name: 'reminder.list',
      scope: 'read',
      description: '待响的提醒（按时间先后）',
      result: Type.Object({ items: Type.Array(ItemSchema) }),
    },
    () => ({ items: deps.store.list().map(itemOf) })
  );

  reg.register(
    {
      name: 'reminder.create',
      scope: 'write',
      description: '新建一次性提醒：text + 时间（inMinutes / atClock / at 三选一）',
      params: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 300 }),
        inMinutes: Type.Optional(Type.Number({ minimum: 0.01, maximum: 43_200 })),
        atClock: Type.Optional(Type.String({ maxLength: 10 })),
        at: Type.Optional(Type.Union([Type.Integer(), Type.String({ maxLength: 40 })])),
      }),
      result: ItemSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { text: string; inMinutes?: number; atClock?: string; at?: number | string };
      const item = deps.store.create({
        text: p.text,
        ...(p.inMinutes === undefined ? {} : { inMinutes: p.inMinutes }),
        ...(p.atClock === undefined ? {} : { atClock: p.atClock }),
        ...(p.at === undefined ? {} : { at: p.at }),
        source: 'user',
      });
      return itemOf(item);
    }
  );

  reg.register(
    {
      name: 'reminder.cancel',
      scope: 'write',
      description: '取消一条还没响的提醒',
      params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }) }),
      result: ItemSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return itemOf(deps.store.cancel(p.id));
    }
  );

  reg.register(
    {
      name: 'reminder.snooze',
      scope: 'write',
      description: '稍后提醒：把一条待响提醒推迟 N 分钟（默认 5）',
      params: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 40 }),
        minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
      }),
      result: ItemSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string; minutes?: number };
      return itemOf(deps.store.snooze(p.id, p.minutes ?? 5));
    }
  );
}
