/**
 * 钩子守卫：把规则匹配 + 审批门串成一次「能不能做」的判断。
 *
 * guard 被两类调用方使用：
 *   - 聊天工具执行前（kind='tool'，模型想删文件/移动文件时问人）
 *   - 网关方法执行前（kind='method'，UI/ automate 想删会话/删记忆时问人）
 */
import type { ApprovalBroker } from './approval.js';
import type { HookStore } from './store.js';
import type { HookContext, HookDecision } from './types.js';

export interface HooksServiceOptions {
  store: HookStore;
  approval: ApprovalBroker;
  publish: (event: string, data?: unknown) => void;
  enabled: () => boolean;
  approvalEnabled: () => boolean;
  logger?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface HooksStatus {
  enabled: boolean;
  approvalEnabled: boolean;
  ruleCount: number;
  sessionAllowedCount: number;
  pendingCount: number;
}

export class HooksService {
  /** 按连接（sessionId）记住「本次允许过」的规则：用户点「记住」后不再反复问。 */
  private readonly sessionAllows = new Map<string, Set<string>>();

  constructor(private readonly opts: HooksServiceOptions) {}

  async guard(ctx: HookContext): Promise<HookDecision> {
    if (!this.opts.enabled()) return { allowed: true, reason: 'hooks 已关闭' };
    let action: 'allow' | 'ask' | 'deny';
    let ruleId: string | undefined;
    let message: string;
    try {
      const match = this.opts.store.evaluate(ctx);
      if (match.rule === null) return { allowed: true, reason: '没有规则命中' };
      action = match.action;
      ruleId = match.rule.id;
      message = match.message;
      if (action === 'allow') return { allowed: true, reason: `规则「${ruleId}」放行`, ruleId };
    } catch (e) {
      this.opts.logger?.('hooks: 规则匹配失败，按拒绝处理', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { allowed: false, reason: '审批门规则读取失败，已拒绝这次操作' };
    }
    const sessionId = ctx.meta?.sessionId;
    const extra = sessionId === undefined ? {} : { sessionId };
    if (action === 'deny') {
      this.opts.publish('hooks.blocked', {
        kind: ctx.kind,
        name: ctx.name,
        ruleId,
        action: 'deny',
        message,
        ...extra,
      });
      return { allowed: false, reason: message, ruleId };
    }
    // action === 'ask'
    if (!this.opts.approvalEnabled()) {
      const reason = `这次操作需要你确认，但审批门已关闭（hooks.approvalEnabled=false）：${message}`;
      this.opts.publish('hooks.blocked', { kind: ctx.kind, name: ctx.name, ruleId, action: 'ask', message: reason, ...extra });
      return { allowed: false, reason, ruleId };
    }
    const key = sessionId ?? '_';
    const allowed = this.sessionAllows.get(key);
    if (allowed !== undefined && allowed.has(ruleId)) {
      return { allowed: true, reason: `本次连接已允许过「${ruleId}」`, ruleId, approved: true };
    }
    const outcome = await this.opts.approval.ask({
      kind: ctx.kind,
      name: ctx.name,
      ruleId,
      title: '需要你确认一下',
      detail: message,
      ...extra,
    });
    if (!outcome.accepted) {
      const reason =
        outcome.reason === 'timeout'
          ? `等待确认超时，已拒绝：${message}`
          : outcome.reason === 'cancelled'
            ? '服务正在退出，已拒绝这次操作'
            : `你拒绝了这次操作：${message}`;
      this.opts.publish('hooks.blocked', {
        kind: ctx.kind,
        name: ctx.name,
        ruleId,
        action: 'ask',
        message: reason,
        ...extra,
      });
      return { allowed: false, reason, ruleId };
    }
    if (outcome.remembered) {
      let set = this.sessionAllows.get(key);
      if (set === undefined) {
        set = new Set();
        this.sessionAllows.set(key, set);
      }
      set.add(ruleId);
    }
    return { allowed: true, reason: `你允许了这次操作（${ruleId}）`, ruleId, approved: true };
  }

  status(): HooksStatus {
    let count = 0;
    for (const set of this.sessionAllows.values()) count += set.size;
    return {
      enabled: this.opts.enabled(),
      approvalEnabled: this.opts.approvalEnabled(),
      ruleCount: this.opts.store.list().length,
      sessionAllowedCount: count,
      pendingCount: this.opts.approval.count(),
    };
  }

  sessionAllowedCount(): number {
    let count = 0;
    for (const set of this.sessionAllows.values()) count += set.size;
    return count;
  }

  /** 清掉所有「本次允许」，下次重新问。 */
  clearSessionAllows(): void {
    this.sessionAllows.clear();
  }
}
