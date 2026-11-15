/** 运行控制：run.pause / run.resume / run.status（暂停后聊天、自主任务、电脑操作都停）。 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { PauseGate, PauseStatus } from '../../kernel/pause.js';

const PauseStatusSchema = Type.Object({
  paused: Type.Boolean(),
  reason: Type.Union([Type.String(), Type.Null()]),
  changedAt: Type.Integer(),
});

export interface RunMethodDeps {
  pauseGate: PauseGate;
  publish?: (event: string, data: unknown) => void;
}

export function registerRunMethods(reg: MethodRegistry, deps: RunMethodDeps): void {
  const publish = (status: PauseStatus, event: string) => {
    try {
      deps.publish?.(event, status);
    } catch {
      /* 忽略广播失败 */
    }
  };

  reg.register(
    {
      name: 'run.status',
      scope: 'read',
      description: '当前是否被用户暂停（暂停后聊天、自主任务、电脑操作都停）',
      params: Type.Object({}),
      result: PauseStatusSchema,
    },
    () => deps.pauseGate.status()
  );

  reg.register(
    {
      name: 'run.pause',
      scope: 'write',
      description: '暂停运行：当前轮会尽快停手，新的聊天/自主任务/电脑操作都不再执行',
      params: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 200 })) }),
      result: PauseStatusSchema,
      idempotent: true,
    },
    async (params) => {
      const p = params as { reason?: string };
      const status = deps.pauseGate.pause(p.reason ?? '用户暂停了运行');
      publish(status, 'run.paused');
      return status;
    }
  );

  reg.register(
    {
      name: 'run.resume',
      scope: 'write',
      description: '继续运行',
      params: Type.Object({}),
      result: PauseStatusSchema,
      idempotent: true,
    },
    async () => {
      const status = deps.pauseGate.resume();
      publish(status, 'run.resumed');
      return status;
    }
  );
}
