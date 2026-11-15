/**
 * 审批经纪人：把一个危险操作变成「问用户是/否」的一次异步等待。
 *
 * 事件（广播给 UI）：
 *   - approval.requested {id,kind,name,ruleId,title,detail,requestedAt,deadlineAt,sessionId?}
 *   - approval.resolved  {id,accepted,reason,remember}
 *
 * UI 用 approval.list 拉当前待答，用 approval.answer 回答；超时无人答 = 拒绝。
 */
import type { ApprovalOutcome, ApprovalReason, ApprovalRequestInput, PendingApproval } from './types.js';

export interface ApprovalBrokerOptions {
  publish: (event: string, data?: unknown) => void;
  /** 单个审批最多等多久（毫秒），超时按拒绝 */
  timeoutMs: number;
  logger?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

interface PendingEntry {
  id: string;
  input: ApprovalRequestInput;
  requestedAt: number;
  deadlineAt: number;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private seq = 0;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly now: () => number;

  constructor(private readonly opts: ApprovalBrokerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 提问并等待回答；返回时一定带结果（answered/timeout/cancelled）。 */
  ask(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const id = `ap-${String(++this.seq).padStart(4, '0')}`;
    const requestedAt = this.now();
    const deadlineAt = requestedAt + Math.max(1, this.opts.timeoutMs);
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.opts.publish('approval.resolved', { id, accepted: false, reason: 'timeout', remember: false });
        this.opts.logger?.('审批超时，按拒绝处理', { id, kind: input.kind, name: input.name, ruleId: input.ruleId });
        resolve({ accepted: false, reason: 'timeout', remembered: false });
      }, Math.max(1, this.opts.timeoutMs));
      timer.unref?.();
      this.pending.set(id, { id, input, requestedAt, deadlineAt, resolve, timer });
      this.opts.publish('approval.requested', {
        id,
        kind: input.kind,
        name: input.name,
        ruleId: input.ruleId,
        title: input.title,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        requestedAt,
        deadlineAt,
      });
    });
  }

  /** UI 回答；找不到（已超时/已答过）返回 false。 */
  answer(id: string, accepted: boolean, remember = false): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.opts.publish('approval.resolved', { id, accepted, reason: 'answered', remember });
    this.opts.logger?.('审批已回答', { id, accepted, remember, kind: entry.input.kind, name: entry.input.name });
    entry.resolve({ accepted, reason: 'answered', remembered: remember });
    return true;
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.pending.values()]
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((e) => ({
        id: e.id,
        kind: e.input.kind,
        name: e.input.name,
        ruleId: e.input.ruleId,
        title: e.input.title,
        ...(e.input.detail === undefined ? {} : { detail: e.input.detail }),
        requestedAt: e.requestedAt,
        deadlineAt: e.deadlineAt,
      }));
  }

  count(): number {
    return this.pending.size;
  }

  /** 退出时把还在等的审批全部按取消拒绝。 */
  cancelAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      const reason: ApprovalReason = 'cancelled';
      this.opts.publish('approval.resolved', { id: entry.id, accepted: false, reason, remember: false });
      entry.resolve({ accepted: false, reason, remembered: false });
    }
  }
}
