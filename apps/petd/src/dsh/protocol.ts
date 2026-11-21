/**
 * DSH SDK 通道的最小协议层（newline-delimited JSON-RPC 2.0）。
 *
 * 只实现桥需要的子集，不依赖 DSH 安装包里的任何模块：
 *   client → server：initialize / session/prompt / shutdown（预留 query/resume）
 *   server → client：session.event / session.status / approval/request（server request）
 *
 * 协议事实（实测 dsh --profile sdk，0.2.2-rc.3）：
 * - 每帧是一行 JSON，\n 分隔；
 * - 方法调用带 id，响应同 id；通知没有 id；
 * - 审批是「服务器发请求、客户端回结果」：approval/request → {outcome}；
 * - 没有版本协商、没有 cancel；要停只能 shutdown/关进程。
 */

export interface DshJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface DshJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface DshJsonRpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface DshJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: DshJsonRpcErrorBody;
}

export type DshJsonRpcMessage = DshJsonRpcRequest | DshJsonRpcResponse | DshJsonRpcNotification;

export interface DshInitializeParams {
  /** SDK runtime 的工作目录：它跑工具时以这里为 cwd */
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  /** true = 审批请求转给客户端（默认 false；不接收时 runtime 会直接拒绝需要审批的动作） */
  approvalRequests?: boolean;
  capabilities?: Record<string, unknown>;
}

export interface DshInitializeResult {
  serverInfo: { name: string; version: string };
}

export interface DshPromptContentBlock {
  type: 'text';
  text: string;
}

export interface DshSessionPromptParams {
  sessionId: string;
  contentBlocks: DshPromptContentBlock[];
}

export interface DshSessionPromptResult {
  messageId: string;
}

export interface DshSessionEvent {
  sessionId: string;
  event: Record<string, unknown>;
}

export interface DshSessionStatus {
  sessionId: string;
  status: 'idle' | 'running';
}

export interface DshApprovalParams {
  sessionId?: string;
  toolName?: string;
  callId?: string;
  reason?: string;
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';

export interface DshApprovalResult {
  outcome: DshApprovalOutcome;
}

/** 未知 server→client 请求的统一回错（-32601 method not found） */
export const DSH_METHOD_NOT_FOUND = -32601;

export function encodeFrame(payload: unknown): string {
  return JSON.stringify(payload) + '\n';
}

/**
 * 把 stdout 的字节流切成 JSON 行并解析。
 * 解析失败的半行/脏行交给 onBadLine（默认忽略并计数），不让一条坏行打断整条通道。
 */
export class DshFrameDecoder {
  private buffer = '';
  private readonly onBadLine: (line: string, error: unknown) => void;

  constructor(onBadLine: (line: string, error: unknown) => void = () => {}) {
    this.onBadLine = onBadLine;
  }

  push(chunk: string): DshJsonRpcMessage[] {
    this.buffer += chunk;
    const out: DshJsonRpcMessage[] = [];
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') {
          out.push(parsed as DshJsonRpcMessage);
        } else {
          this.onBadLine(line, new Error('不是对象'));
        }
      } catch (error) {
        this.onBadLine(line, error);
      }
    }
    // 防御：一行超长却不带换行时别无限攒内存
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.onBadLine(this.buffer.slice(0, 200), new Error('单行超过 8MB，已丢弃'));
      this.buffer = '';
    }
    return out;
  }
}

export function isRequest(msg: DshJsonRpcMessage): msg is DshJsonRpcRequest {
  return typeof (msg as { id?: unknown }).id === 'number' && typeof (msg as { method?: unknown }).method === 'string';
}

export function isResponse(msg: DshJsonRpcMessage): msg is DshJsonRpcResponse {
  const m = msg as { id?: unknown; method?: unknown };
  return typeof m.id === 'number' && m.method === undefined;
}

export function isNotification(msg: DshJsonRpcMessage): msg is DshJsonRpcNotification {
  const m = msg as { id?: unknown; method?: unknown };
  return m.id === undefined && typeof m.method === 'string';
}

/** 从 session.event 里取事件类型（DSH 事件都有 type 字段） */
export function eventType(event: Record<string, unknown>): string {
  return viewDshEvent(event).type;
}

export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * DSH 事件的统一视图。
 *
 * 实测真实事件是 envelope 形状：
 *   { type: 'assistant/message', seq, time, data: { turn, step, message: { role, content }, usage, stream } }
 * 而早期 probe 记录过扁平形状（turn/step/message 直接在顶层）。两种都摊平成同一视图，
 * 否则 dsh.event 没 text、观察器的 turn/step/tool/lastText 全是空。
 */
export interface DshEventView {
  type: string;
  turn: number | null;
  step: number | null;
  tool: string | null;
  text: string | null;
}

export function viewDshEvent(event: Record<string, unknown>): DshEventView {
  const data = asRecord(event['data']) ?? event;
  const type = asString(event['type']) ?? asString(data['type']) ?? '';
  const turn = asNumber(data['turn']) ?? asNumber(event['turn']);
  const step = asNumber(data['step']) ?? asNumber(event['step']);
  let tool = asString(data['name']) ?? asString(event['name']);
  let text: string | null = null;
  const message = asRecord(data['message']);
  const content = message !== null && Array.isArray(message['content']) ? message['content'] : null;
  if (content !== null) {
    const texts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block === null) continue;
      const blockType = asString(block['type']);
      if (blockType === 'text') {
        const t = asString(block['text']);
        if (t !== null && t.trim() !== '') texts.push(t);
      } else if (blockType === 'tool-call' && tool === null) {
        tool = asString(block['name']);
      }
    }
    if (texts.length > 0) text = texts.join('\n').trim();
  }
  return { type, turn, step, tool, text };
}
