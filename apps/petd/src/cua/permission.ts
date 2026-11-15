/**
 * 权限代理：把「能不能看屏幕 / 能不能操作」转成一次 UI 询问。
 * 通过事件 `cua.permission` 发给前端，前端用 cua.answer 回答；超时按拒绝处理。
 */
import type { AskPermission } from './types.js';

export interface PermissionRequest {
  id: string;
  kind: 'see' | 'act';
  question: string;
  deadlineAt: number;
}

export interface PermissionBrokerOptions {
  publish?: (event: string, data: unknown) => void;
  logger?: { warn: (msg: string, data?: Record<string, unknown>) => void };
  timeoutMs?: number;
  now?: () => number;
}

interface Pending {
  resolve: (value: boolean | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly options: PermissionBrokerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  readonly ask: AskPermission = async (kind, question) => {
    const publish = this.options.publish;
    if (!publish) {
      this.options.logger?.warn('没有 UI 可以询问权限，按拒绝处理');
      return null;
    }
    const id = `perm-${++this.seq}`;
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const req: PermissionRequest = { id, kind, question, deadlineAt: this.now() + timeoutMs };
    return new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      try {
        publish('cua.permission', req);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.options.logger?.warn('发送权限询问失败', { error: (e as Error).message });
        resolve(null);
      }
    });
  };

  answer(id: string, accepted: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(accepted);
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  cancelAll(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(null);
    }
  }
}
