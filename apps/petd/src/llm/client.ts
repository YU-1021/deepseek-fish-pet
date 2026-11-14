/**
 * LLM 客户端：OpenAI 兼容的 /chat/completions。
 *
 * 从旧 app/src/llm.js 学到了三件事，这里照做：
 *   1. 显式 thinking:{type:'disabled'} —— V4.1-Flash 默认开思考，会拖慢首字且按输出价计费；
 *   2. 错误必须说人话（网络/超时/401/402/429/5xx 各有中文提示，且要顺着 cause 找 code）；
 *   3. 可注入 fetchImpl，测试不碰网络。
 *
 * 不给 apiKey 时直接抛 E_LLM_AUTH，不做静默降级。
 */
import type { PetdConfig } from '../kernel/config.js';

export type LlmErrorCode =
  | 'E_LLM_AUTH'
  | 'E_LLM_QUOTA'
  | 'E_LLM_RATE'
  | 'E_LLM_TIMEOUT'
  | 'E_LLM_NETWORK'
  | 'E_LLM_HTTP'
  | 'E_LLM_EMPTY'
  | 'E_LLM_BAD_RESPONSE';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: LlmErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.details = details;
  }
}

export function isLlmError(v: unknown): v is LlmError {
  return v instanceof LlmError;
}

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmReply {
  text: string;
  model: string;
  usage: LlmUsage;
  /** 原始 usage 与 finish_reason，便于排障，日志里只记长度 */
  finishReason?: string;
}

export interface LlmClientOptions {
  config: PetdConfig['llm'];
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface CompleteOptions {
  messages: LlmMessage[];
  /** 覆盖配置的 maxTokens / temperature（例如标题生成用小的） */
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly config: PetdConfig['llm'];
  complete(opts: CompleteOptions): Promise<LlmReply>;
}

const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: '域名解析失败（检查 llm.apiBase 与网络/代理）',
  EAI_AGAIN: 'DNS 暂时解析失败（检查网络/代理）',
  ECONNREFUSED: '连接被拒绝（检查 base 地址与端口，或代理是否开启）',
  ECONNRESET: '连接被重置（网络不稳定或代理中断）',
  ENETUNREACH: '网络不可达（检查网络连接）',
  ETIMEDOUT: '连接超时（检查网络/代理）',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（检查网络/代理）',
  UND_ERR_SOCKET: '连接被异常关闭（网络不稳定或代理中断）',
  CERT_HAS_EXPIRED: 'TLS 证书过期（检查系统时间或代理）',
};

/** 顺着 cause / AggregateError 找网络错误码（旧 llm.js 踩过的坑） */
function findErrno(e: unknown, depth = 0): string | undefined {
  if (depth > 5 || e === null || typeof e !== 'object') return undefined;
  const rec = e as Record<string, unknown>;
  const code = rec['code'];
  if (typeof code === 'string' && code) return code;
  const cause = rec['cause'];
  if (cause) {
    const found = findErrno(cause, depth + 1);
    if (found) return found;
  }
  const errors = rec['errors'];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const found = findErrno(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function httpHint(status: number): { code: LlmErrorCode; text: string } {
  if (status === 401 || status === 403) return { code: 'E_LLM_AUTH', text: 'API Key 无效或没有权限（检查 secrets.json 或 PETD_LLM_API_KEY）' };
  if (status === 402) return { code: 'E_LLM_QUOTA', text: '账户余额不足，充值后再试' };
  if (status === 429) return { code: 'E_LLM_RATE', text: '请求太频繁被限流，稍后再试' };
  if (status === 400 || status === 404 || status === 422) return { code: 'E_LLM_HTTP', text: `请求被拒绝（HTTP ${status}，检查模型名 ${''} 与参数）` };
  if (status >= 500) return { code: 'E_LLM_HTTP', text: `模型服务暂时不可用（HTTP ${status}），稍后再试` };
  return { code: 'E_LLM_HTTP', text: `模型服务返回 HTTP ${status}` };
}

function pickString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' ? v : undefined;
}

function pickNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function createLlmClient(opts: LlmClientOptions): LlmClient {
  const cfg = opts.config;
  const apiKey = opts.apiKey.trim();
  const doFetch = opts.fetchImpl ?? fetch;

  async function complete(call: CompleteOptions): Promise<LlmReply> {
    if (!apiKey) {
      throw new LlmError('E_LLM_AUTH', '还没有配置模型 API Key（写入 home/secrets.json 的 llm.apiKey，或设 PETD_LLM_API_KEY）');
    }
    if (!call.messages.length) {
      throw new LlmError('E_LLM_BAD_RESPONSE', '内部错误：请求消息为空');
    }
    const url = cfg.apiBase.replace(/\/+$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: call.messages,
      temperature: call.temperature ?? cfg.temperature,
      max_tokens: call.maxTokens ?? cfg.maxTokens,
      stream: false,
    };
    if (cfg.thinkingDisabled) body['thinking'] = { type: 'disabled' };

    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (timeoutSignal.aborted) {
        throw new LlmError('E_LLM_TIMEOUT', `模型响应超时（${cfg.timeoutMs}ms），可稍后重试或调大 llm.timeoutMs`, { timeoutMs: cfg.timeoutMs });
      }
      if (call.signal?.aborted) {
        throw new LlmError('E_LLM_TIMEOUT', '请求已取消', { cancelled: true });
      }
      const errno = findErrno(e);
      if (errno === 'ABORT_ERR') {
        throw new LlmError('E_LLM_TIMEOUT', `模型响应超时（${cfg.timeoutMs}ms），可稍后重试或调大 llm.timeoutMs`, { timeoutMs: cfg.timeoutMs });
      }
      const hint = (errno && NETWORK_HINTS[errno]) || '网络请求失败（检查网络/代理/llm.apiBase）';
      throw new LlmError('E_LLM_NETWORK', `${hint}${errno ? '（' + errno + '）' : ''}`, { errno: errno ?? null });
    }

    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
      } catch {}
      const mapped = httpHint(res.status);
      throw new LlmError(mapped.code, mapped.text + (snippet ? `；服务端说：${snippet}` : ''), {
        status: res.status,
        snippet,
      });
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new LlmError('E_LLM_BAD_RESPONSE', '模型返回的不是合法 JSON');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new LlmError('E_LLM_BAD_RESPONSE', '模型返回结构异常（不是对象）');
    }
    const root = payload as Record<string, unknown>;
    const choices = root['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new LlmError('E_LLM_BAD_RESPONSE', '模型返回没有 choices');
    }
    const first = choices[0];
    const choice = first !== null && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>) : {};
    const message = choice['message'];
    const msgRec = message !== null && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>) : {};
    const text = (pickString(msgRec, 'content') ?? '').trim();
    if (!text) {
      throw new LlmError('E_LLM_EMPTY', '模型返回了空内容，稍后再试');
    }
    const usageRaw = root['usage'];
    const usageRec = usageRaw !== null && typeof usageRaw === 'object' && !Array.isArray(usageRaw) ? (usageRaw as Record<string, unknown>) : {};
    const usage: LlmUsage = {
      promptTokens: pickNumber(usageRec, 'prompt_tokens'),
      completionTokens: pickNumber(usageRec, 'completion_tokens'),
      totalTokens: pickNumber(usageRec, 'total_tokens'),
    };
    return {
      text,
      model: pickString(root, 'model') ?? cfg.model,
      usage,
      finishReason: pickString(choice, 'finish_reason'),
    };
  }

  return { config: cfg, complete };
}
