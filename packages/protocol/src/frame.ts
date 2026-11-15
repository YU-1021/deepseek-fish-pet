/**
 * 协议帧定义（pet-ui ⇄ petd，WebSocket JSON 文本帧）
 *
 * 设计依据：docs/petd-架构蓝图.md 第三节「通信协议」。
 * 约束：
 *   - 所有帧 JSON 对象，必须带 type 字段；
 *   - 客户端→服务端只允许 connect / req（其余丢弃并关闭）；
 *   - 服务端→客户端只有 hello / res / event；
 *   - 帧校验用 TypeBox，编译期/运行期同一份 schema，避免两份定义漂移。
 */
import { Type, type Static } from '@sinclair/typebox';

export const PROTOCOL_VERSION = 1 as const;
export const SERVER_NAME = 'petd' as const;

/** 客户端身份（连接时声明，用于日志/审计） */
export const ClientInfoSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  version: Type.String({ minLength: 1, maxLength: 64 }),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  /** pet-ui 额外信息，不参与鉴权 */
  extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ClientInfo = Static<typeof ClientInfoSchema>;

/** 首帧：握手 */
export const ConnectFrameSchema = Type.Object({
  type: Type.Literal('connect'),
  protocol: Type.Optional(Type.Integer({ minimum: 1 })),
  token: Type.String({ minLength: 8, maxLength: 256 }),
  client: ClientInfoSchema,
});
export type ConnectFrame = Static<typeof ConnectFrameSchema>;

/** 服务端应答握手 */
export const HelloFrameSchema = Type.Object({
  type: Type.Literal('hello'),
  server: Type.Object({
    name: Type.String(),
    version: Type.String(),
    protocol: Type.Integer(),
    pid: Type.Integer(),
  }),
  sessionId: Type.String(),
});
export type HelloFrame = Static<typeof HelloFrameSchema>;

/** 请求 */
export const ReqFrameSchema = Type.Object({
  type: Type.Literal('req'),
  id: Type.String({ minLength: 1, maxLength: 128 }),
  method: Type.String({ minLength: 1, maxLength: 128 }),
  params: Type.Optional(Type.Unknown()),
});
export type ReqFrame = Static<typeof ReqFrameSchema>;

/** 错误体：机器可读 code + 人类可读 message */
export const ErrorBodySchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});
export type ErrorBody = Static<typeof ErrorBodySchema>;

/** 响应 */
export const ResFrameSchema = Type.Object({
  type: Type.Literal('res'),
  id: Type.String(),
  ok: Type.Boolean(),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(ErrorBodySchema),
});
export type ResFrame = Static<typeof ResFrameSchema>;

/** 服务端事件推送（单调递增 seq，前端可据此检测丢帧） */
export const EventFrameSchema = Type.Object({
  type: Type.Literal('event'),
  event: Type.String({ minLength: 1, maxLength: 128 }),
  seq: Type.Integer({ minimum: 1 }),
  ts: Type.Integer(),
  data: Type.Optional(Type.Unknown()),
});
export type EventFrame = Static<typeof EventFrameSchema>;

export type Frame = ConnectFrame | HelloFrame | ReqFrame | ResFrame | EventFrame;

/** 客户端允许发送的帧 */
export type InboundFrame = ConnectFrame | ReqFrame;
/** 服务端允许发送的帧 */
export type OutboundFrame = HelloFrame | ResFrame | EventFrame;

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { code, message } : { code, message, details };
}
