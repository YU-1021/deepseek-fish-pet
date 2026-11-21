/**
 * 钩子守卫：规则匹配 + （可选）模型风险评审 + 审批门，串成一次「能不能做」的判断。
 *
 * 两种模式（config.hooks.mode）：
 *   - rules：只看规则；没有规则命中就放行（原行为）。
 *   - smart（默认）：规则 deny/allow 优先；无规则时，只对「敏感操作」调用模型风险评审：
 *       low / medium → 自动放行；high → 弹审批给人确认。模型失败按 fallback（默认 high）。
 *
 * guard 被两类调用方使用：
 *   - 聊天工具执行前（kind='tool'，模型想删文件/移动文件/键鼠注入时评估）
 *   - 网关方法执行前（kind='method'，只评 write scope）
 */
import type { ApprovalBroker } from './approval.js';
import type { RiskVerdict } from './risk.js';
import type { HookStore } from './store.js';
import type { HookContext, HookDecision, HookMode } from './types.js';

/** 敏感聊天工具：只有这些会走智能风险评审（读类工具直接放行，省 token）。 */
export const SENSITIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'delete_file',
  'move_file',
  'save_blob',
  'schedule_task',
  'cancel_task',
  'cua_click',
  'cua_move',
  'cua_drag',
  'cua_mouse_down',
  'cua_mouse_up',
  'cua_scroll',
  'cua_type',
  'cua_key',
  'cua_focus',
]);

export interface HooksServiceOptions {
  store: HookStore;
  approval: ApprovalBroker;
  publish: (event: string, data?: unknown) => void;
  enabled: () => boolean;
  approvalEnabled: () => boolean;
  /** 返回 'smart' 时启用模型风险评审（默认走 rules 行为） */
  mode?: () => HookMode;
  /** 风险评审器；没有时不评审（smart 模式退化：无规则即放行） */
  risk?: { assess(ctx: HookContext): Promise<RiskVerdict> };
  logger?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface HooksStatus {
  enabled: boolean;
  mode: HookMode;
  approvalEnabled: boolean;
  ruleCount: number;
  sessionAllowedCount: number;
  pendingCount: number;
  riskEnabled: boolean;
  riskCacheSize: number;
}

export class HooksService {
  /** 按连接（sessionId）记住「本次允许过」的规则：用户点「记住」后不再反复问。 */
  private readonly sessionAllows = new Map<string, Set<string>>();

  constructor(private readonly opts: HooksServiceOptions) {}

  private get mode(): HookMode {
    return this.opts.mode?.() ?? 'rules';
  }

  /** 显式请求一次风险评审（hooks.assess 方法与测试用）。 */
  async assess(ctx: HookContext): Promise<RiskVerdict> {
    if (this.opts.risk === undefined) {
      return { level: 'high', reason: '没有配置风险评审器，按高风险处理', cached: false, fallback: true };
    }
    return this.opts.risk.assess(ctx);
  }

  async guard(ctx: HookContext): Promise<HookDecision> {
    if (!this.opts.enabled()) return { allowed: true, reason: 'hooks 已关闭' };
    const sessionId = ctx.meta?.sessionId;
    const extra = sessionId === undefined ? {} : { sessionId };

    let action: 'allow' | 'ask' | 'deny';
    let ruleId: string | undefined;
    let message: string;
    try {
      const match = this.opts.store.evaluate(ctx);
      if (match.rule === null) {
        // 没有规则命中：rules 模式放行；smart 模式只评敏感操作
        if (this.mode !== 'smart') return { allowed: true, reason: '没有规则命中' };
        return this.smartGuard(ctx, extra);
      }
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
    // action === 'ask'：规则明确要求人工确认
    return this.askUser(ctx, ruleId, message, extra);
  }

  /** smart 模式：只评敏感操作；low/medium 放行，high 弹审批，unknown 按保守处理。 */
  private async smartGuard(
    ctx: HookContext,
    extra: { sessionId?: string }
  ): Promise<HookDecision> {
    const sensitive =
      ctx.kind === 'method'
        ? ctx.scope === 'write'
        : SENSITIVE_TOOL_NAMES.has(ctx.name);
    if (!sensitive) return { allowed: true, reason: '非敏感操作，智能门直接放行' };

    const verdict = await this.assess(ctx);
    this.opts.publish('hooks.assessed', {
      kind: ctx.kind,
      name: ctx.name,
      risk: verdict.level,
      reason: verdict.reason,
      cached: verdict.cached,
      fallback: verdict.fallback,
      ...extra,
    });
    if (verdict.level === 'low' || verdict.level === 'medium') {
      return {
        allowed: true,
        reason: `风险${verdict.level === 'low' ? '低' : '中'}，自动放行：${verdict.reason}`,
        risk: verdict.level,
      };
    }
    const ruleKey = `risk:${verdict.level}:${riskKey(ctx)}`;
    return this.askUser(
      ctx,
      ruleKey,
      `风险等级：${verdict.level === 'high' ? '高' : '未知'}；${verdict.reason}`,
      extra,
      { risk: verdict.level, riskReason: verdict.reason, title: '高风险操作，需要你确认' }
    );
  }

  private async askUser(
    ctx: HookContext,
    ruleId: string,
    message: string,
    extra: { sessionId?: string },
    opts: { risk?: 'low' | 'medium' | 'high'; riskReason?: string; title?: string } = {}
  ): Promise<HookDecision> {
    if (!this.opts.approvalEnabled()) {
      const reason = `这次操作需要你确认，但审批门已关闭（hooks.approvalEnabled=false）：${message}`;
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
    const key = extra.sessionId ?? '_';
    const allowed = this.sessionAllows.get(key);
    if (allowed !== undefined && allowed.has(ruleId)) {
      return { allowed: true, reason: `本次连接已允许过「${ruleId}」`, ruleId, approved: true, ...(opts.risk === undefined ? {} : { risk: opts.risk }) };
    }
    const outcome = await this.opts.approval.ask({
      kind: ctx.kind,
      name: ctx.name,
      ruleId,
      title: opts.title ?? '需要你确认一下',
      detail: message,
      ...extra,
      ...(opts.risk === undefined ? {} : { risk: opts.risk }),
      ...(opts.riskReason === undefined ? {} : { riskReason: opts.riskReason }),
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
        ...(opts.risk === undefined ? {} : { risk: opts.risk }),
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
    return { allowed: true, reason: `你允许了这次操作（${ruleId}）`, ruleId, approved: true, ...(opts.risk === undefined ? {} : { risk: opts.risk }) };
  }

  status(): HooksStatus {
    let count = 0;
    for (const set of this.sessionAllows.values()) count += set.size;
    return {
      enabled: this.opts.enabled(),
      mode: this.mode,
      approvalEnabled: this.opts.approvalEnabled(),
      ruleCount: this.opts.store.list().length,
      sessionAllowedCount: count,
      pendingCount: this.opts.approval.count(),
      riskEnabled: this.opts.risk !== undefined,
      riskCacheSize: 0,
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

function riskKey(ctx: HookContext): string {
  const raw = `${ctx.kind}|${ctx.name}|${JSON.stringify(ctx.args ?? {})}`;
  // 轻量哈希：只用于规则 id 的区分，不需要加密强度
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
