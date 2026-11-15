/**
 * @petd/protocol 入口：帧类型 + 校验 + 错误码 + 方法声明类型。
 */
export {
  PROTOCOL_VERSION,
  SERVER_NAME,
  ClientInfoSchema,
  ConnectFrameSchema,
  HelloFrameSchema,
  ReqFrameSchema,
  ResFrameSchema,
  ErrorBodySchema,
  EventFrameSchema,
  errorBody,
  type ClientInfo,
  type ConnectFrame,
  type HelloFrame,
  type ReqFrame,
  type ResFrame,
  type EventFrame,
  type ErrorBody,
  type Frame,
  type InboundFrame,
  type OutboundFrame,
} from './frame.js';
export { parseInbound, assertParams, type ParseResult } from './validate.js';
export { ErrorCodes, PetdError, isPetdError, type PetdErrorCode } from './errors.js';
export type { MethodScope, MethodDescriptor, MethodHandler, GatewayContext, MethodSummary } from './methods.js';
