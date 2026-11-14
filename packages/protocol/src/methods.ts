/**
 * 方法声明与执行上下文类型。
 *
 * 每个方法必须声明：name / scope / description；参数/结果可选 TypeBox schema。
 * 阶段 2 的「工具契约」会建在这套方法描述符上（工具 = 声明+执行+效果+坐标空间）。
 */
import type { TSchema } from '@sinclair/typebox';
import type { ClientInfo } from './frame.js';

export type MethodScope = 'read' | 'write' | 'system';

export interface MethodDescriptor<P extends TSchema | undefined = TSchema | undefined, R extends TSchema | undefined = TSchema | undefined> {
  /** 命名空间格式：domain.action，如 health.ping / config.get */
  name: string;
  scope: MethodScope;
  /** 给模型/前端看的一句话说明 */
  description: string;
  /** 参数 schema（缺省=不接受参数） */
  params?: P;
  /** 结果 schema（缺省=不校验） */
  result?: R;
  /** 执行超时，默认 15000ms */
  timeoutMs?: number;
  /** 相同 id 的重复请求是否复用结果（默认 true） */
  idempotent?: boolean;
  /** 是否危险（阶段 2 接审批门用） */
  dangerous?: boolean;
}

export interface GatewayContext {
  sessionId: string;
  client: ClientInfo;
  /** 超时会 abort，handler 应尽快退出 */
  signal: AbortSignal;
  /** 服务端启动毫秒时间戳 */
  startedAt: number;
}

export type MethodHandler = (params: unknown, ctx: GatewayContext) => unknown | Promise<unknown>;

/** 给 health.status 用的序列化描述（不含 schema，避免把内部结构全暴露给前端） */
export interface MethodSummary {
  name: string;
  scope: MethodScope;
  description: string;
  timeoutMs: number;
  idempotent: boolean;
  dangerous: boolean;
}
