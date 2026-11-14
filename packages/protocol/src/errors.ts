/**
 * 错误码表：所有跨进程错误必须用这里的 code（禁止把内部异常字符串直接透给前端）。
 */
export const ErrorCodes = {
  /** 首帧不是 connect / connect 格式非法 */
  HANDSHAKE: 'E_HANDSHAKE',
  /** token 不匹配 */
  UNAUTHORIZED: 'E_UNAUTHORIZED',
  /** JSON 解析失败或帧 schema 不合法 */
  BAD_FRAME: 'E_BAD_FRAME',
  /** 方法不存在 */
  UNKNOWN_METHOD: 'E_UNKNOWN_METHOD',
  /** 参数不满足方法声明 */
  BAD_PARAMS: 'E_BAD_PARAMS',
  /** 方法执行超时 */
  TIMEOUT: 'E_TIMEOUT',
  /** 方法内部错误 */
  INTERNAL: 'E_INTERNAL',
  /** 目标不存在 */
  NOT_FOUND: 'E_NOT_FOUND',
  /** 乐观并发冲突（expectedVersion/锁版本不匹配） */
  CONFLICT: 'E_CONFLICT',
  /** 权限/策略拒绝 */
  FORBIDDEN: 'E_FORBIDDEN',
  /** 服务正在关闭 */
  UNAVAILABLE: 'E_UNAVAILABLE',
} as const;

export type PetdErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class PetdError extends Error {
  readonly code: PetdErrorCode;
  readonly details?: unknown;

  constructor(code: PetdErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PetdError';
    this.code = code;
    this.details = details;
  }
}

export function isPetdError(e: unknown): e is PetdError {
  return e instanceof PetdError;
}
