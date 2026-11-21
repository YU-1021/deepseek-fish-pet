/**
 * 风险评审员：让模型给「一次危险操作」打分（low / medium / high），
 * 智能审批门据此决定「直接放行 / 问用户」——人只确认高风险。
 *
 * 设计取舍：
 *   - 只在小模型调用上做「分类」，不追求解释完整；提示词要求输出一行 JSON。
 *   - 结果按 (kind,name,args) 缓存：同一操作短期内不重复问模型。
 *   - 模型不可用/超时/输出不合法 → 回退到配置的 fallback（默认 high，保守）。
 *   - 评审本身失败不阻断主流程：由调用方（HooksService）按 fallback 处理。
 */
import { createHash } from 'node:crypto';
import type { LlmClient, LlmMessage } from '../llm/client.js';
import type { HookContext } from './types.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskVerdict {
  level: RiskLevel;
  /** 模型给的一句话原因（中文） */
  reason: string;
  /** 是否命中缓存 */
  cached: boolean;
  /** 是否是回退结果（模型不可用/输出不合法） */
  fallback: boolean;
}

export interface RiskConfig {
  enabled: boolean;
  timeoutMs: number;
  cacheTtlSeconds: number;
  maxCacheEntries: number;
  /** 传给模型的操作参数最多截取多少字符（避免提示词过长） */
  maxArgsChars: number;
  /** 模型失败/不确定时按哪个等级处理（high = 问人） */
  fallback: RiskLevel;
}

export interface RiskAssessorOptions {
  llm: Pick<LlmClient, 'complete'>;
  /** 每次评审时读取最新配置（支持热改） */
  config: () => RiskConfig;
  logger?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

interface CacheEntry {
  verdict: RiskVerdict;
  expiresAt: number;
}

const RISK_VALUES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

const SYSTEM_PROMPT = [
  '你是桌宠的安全评审员。桌宠的模型可能想执行一个操作，你要判断这次操作的风险，决定是否需要打扰用户确认。',
  '',
  '只输出一行 JSON：{"risk":"low|medium|high","reason":"一句话中文原因"}',
  '',
  '判定标准：',
  '- low：只读/可逆/无副作用。读文件、列目录、截图、搜索、查状态、聊天、普通记忆读写、创建可撤销的提醒。',
  '- medium：会写数据但容易撤回，或影响范围有限。写/追加工作区文件、改配置、建任务、切换窗口、普通点击。',
  '- high：不可逆、破坏性、对外生效、涉及私密或金钱。删除/移动/覆盖文件、删除会话与记忆、锁文件、跑命令/终端、输入密码、发消息、提交表单、购买支付、安装软件、修改系统设置、键鼠批量注入。',
  '',
  '规则：拿不准时选 high；理由要具体（做了什么、为什么）。',
].join('\n');

function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canon(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
    .join(',')}}`;
}

function cacheKey(ctx: HookContext): string {
  const raw = `${ctx.kind}|${ctx.name}|${canon(ctx.args ?? {})}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export class RiskAssessor {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly opts: RiskAssessorOptions) {
    this.now = opts.now ?? Date.now;
  }

  async assess(ctx: HookContext): Promise<RiskVerdict> {
    const cfg = this.opts.config();
    if (!cfg.enabled) {
      return { level: cfg.fallback, reason: '风险评审已关闭，按保守等级处理', cached: false, fallback: true };
    }
    const key = cacheKey(ctx);
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) {
      return { ...hit.verdict, cached: true };
    }
    if (hit !== undefined) this.cache.delete(key);
    try {
      const verdict = await this.ask(ctx, cfg);
      this.remember(key, verdict, cfg);
      return verdict;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.opts.logger?.('hooks: 风险评审失败，按回退等级处理', { error: message, kind: ctx.kind, name: ctx.name });
      return {
        level: cfg.fallback,
        reason: `风险评估失败（${message}），按${cfg.fallback === 'high' ? '高风险' : cfg.fallback}处理`,
        cached: false,
        fallback: true,
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  private remember(key: string, verdict: RiskVerdict, cfg: RiskConfig): void {
    if (this.cache.size >= Math.max(1, cfg.maxCacheEntries)) {
      // 简单 LRU：删最早插入的一条（Map 保持插入序）
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(key, { verdict, expiresAt: this.now() + Math.max(1, cfg.cacheTtlSeconds) * 1000 });
  }

  private async ask(ctx: HookContext, cfg: RiskConfig): Promise<RiskVerdict> {
    const argsText = truncate(safeJson(ctx.args), Math.max(80, cfg.maxArgsChars));
    const user = [
      `操作类型：${ctx.kind === 'tool' ? '聊天工具' : '网关方法'}`,
      `操作名：${ctx.name}`,
      `参数：${argsText}`,
      ctx.meta?.sessionId === undefined ? '来源：未知连接' : `来源会话：${ctx.meta.sessionId}`,
    ].join('\n');
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
    timer.unref?.();
    try {
      const reply = await this.opts.llm.complete({
        messages,
        temperature: 0,
        maxTokens: 160,
        signal: controller.signal,
      });
      const parsed = parseRiskReply(reply.text);
      if (parsed === null) {
        return {
          level: cfg.fallback,
          reason: '风险评审输出不合法，按保守等级处理',
          cached: false,
          fallback: true,
        };
      }
      return { level: parsed.level, reason: parsed.reason, cached: false, fallback: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseRiskReply(text: string): { level: RiskLevel; reason: string } | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const level = typeof obj['risk'] === 'string' ? obj['risk'].trim().toLowerCase() : '';
  const reason = typeof obj['reason'] === 'string' ? obj['reason'].trim() : '';
  if (!RISK_VALUES.has(level)) return null;
  return { level: level as RiskLevel, reason: reason || '（模型没有给原因）' };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? '{}';
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（已截断）`;
}
