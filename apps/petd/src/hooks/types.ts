/** 审批门/钩子：危险动作二次确认 + allow/ask/deny 规则 + 模型风险评审。 */

export type HookKind = 'tool' | 'method';
export type HookAction = 'allow' | 'ask' | 'deny';
export type HookMode = 'rules' | 'smart';

export interface HookRule {
  /** 稳定 id（小写字母/数字/短横线） */
  id: string;
  /** 人话描述，审批气泡里显示 */
  description: string;
  enabled: boolean;
  /** 作用对象：聊天工具 / 网关方法 */
  kind: HookKind;
  /** 名字 glob（支持 * 和 ?），例如 ["memory.*"] / ["delete_file"] */
  names: string[];
  action: HookAction;
  /** ask/deny 时给人看的原因 */
  message?: string;
  /** 参数 JSON 里包含这个子串才匹配（可选） */
  argContains?: string;
  /** 优先级：越小越先匹配；用户规则默认 10，内置规则 100 */
  priority: number;
  /** true = 系统内置（可改可删，但会标记） */
  builtin?: boolean;
}

export interface HookContext {
  kind: HookKind;
  name: string;
  /** 网关方法的 scope；工具调用没有 scope */
  scope?: 'read' | 'write' | 'system';
  /** 工具参数或方法参数（可选，用于 argContains / 风险评审） */
  args?: Record<string, unknown>;
  meta?: {
    sessionId?: string;
    client?: { name: string; version: string };
  };
}

export interface HookMatchResult {
  action: HookAction;
  rule: HookRule | null;
  message: string;
}

export interface HookDecision {
  allowed: boolean;
  /** 给调用方/错误文案用的原因 */
  reason: string;
  ruleId?: string;
  /** 是否经历过用户审批 */
  approved?: boolean;
  /** 智能门给出的风险等级（仅 smart 模式） */
  risk?: 'low' | 'medium' | 'high';
}

export interface ApprovalRequestInput {
  kind: HookKind;
  name: string;
  ruleId: string;
  title: string;
  detail?: string;
  /** 哪个连接触发的（方便 UI 对应到会话） */
  sessionId?: string;
  /** 智能门风险等级（展示用） */
  risk?: 'low' | 'medium' | 'high';
  /** 模型给的风险原因 */
  riskReason?: string;
}

export type ApprovalReason = 'answered' | 'timeout' | 'cancelled';

export interface ApprovalOutcome {
  accepted: boolean;
  reason: ApprovalReason;
  remembered: boolean;
}

export interface PendingApproval {
  id: string;
  kind: HookKind;
  name: string;
  ruleId: string;
  title: string;
  detail?: string;
  risk?: 'low' | 'medium' | 'high';
  riskReason?: string;
  requestedAt: number;
  deadlineAt: number;
}
