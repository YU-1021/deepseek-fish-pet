/**
 * 帧校验：把任意字符串/Buffer 解析成合法 InboundFrame，失败给结构化错误。
 * 用 TypeBox 的 Value.Check（与 schema 同源）。
 */
import { Value } from '@sinclair/typebox/value';
import { ConnectFrameSchema, ReqFrameSchema, errorBody, type InboundFrame, type ErrorBody } from './frame.js';

export type ParseResult = { ok: true; frame: InboundFrame } | { ok: false; error: ErrorBody };

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseInbound(raw: string | Buffer): ParseResult {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: errorBody('E_BAD_FRAME', '帧不是合法 JSON') };
  }
  const obj = asObject(parsed);
  if (!obj) {
    return { ok: false, error: errorBody('E_BAD_FRAME', '帧必须是 JSON 对象') };
  }
  switch (obj['type']) {
    case 'connect':
      if (!Value.Check(ConnectFrameSchema, obj)) {
        return { ok: false, error: errorBody('E_HANDSHAKE', 'connect 帧格式不合法') };
      }
      return { ok: true, frame: obj as InboundFrame };
    case 'req':
      if (!Value.Check(ReqFrameSchema, obj)) {
        return { ok: false, error: errorBody('E_BAD_FRAME', 'req 帧格式不合法') };
      }
      return { ok: true, frame: obj as InboundFrame };
    default:
      return { ok: false, error: errorBody('E_BAD_FRAME', '未知帧类型（客户端只允许 connect/req）') };
  }
}

export function assertParams(schema: import('@sinclair/typebox').TSchema | undefined, params: unknown): ErrorBody | null {
  if (!schema) return null;
  const v = params === undefined ? {} : params;
  if (Value.Check(schema, v)) return null;
  return errorBody('E_BAD_PARAMS', '参数不满足方法声明', { errors: [...Value.Errors(schema, v)].slice(0, 5).map((e) => `${e.path}: ${e.message}`) });
}
