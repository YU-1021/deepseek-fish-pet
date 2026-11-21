/**
 * WS 网关：握手 → 请求分发 → 事件推送。
 *
 * 顺序约束（蓝图第三节）：
 *   - 每个连接第一帧必须是 connect，否则 E_HANDSHAKE 断开；
 *   - token 错误 → E_UNAUTHORIZED 断开；
 *   - 协议版本不匹配 → E_HANDSHAKE 断开；
 *   - req 走 method 注册表：先校验存在性 → 参数 schema → scope/权限（阶段 1 只有 token 级鉴权）→ 执行。
 *
 * 请求语义：
 *   - 超时：descriptor.timeoutMs（默认 15s），到点 abort 并回 E_TIMEOUT；
 *   - 幂等：idempotent !== false 的方法按「连接内 req.id」缓存 60s，重发回同一结果；
 *   - 错误一律结构化回包，不让异常穿透进程。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  SERVER_NAME,
  errorBody,
  isPetdError,
  parseInbound,
  PetdError,
  type ClientInfo,
  type ErrorBody,
  type EventFrame,
  type HelloFrame,
  type ResFrame,
} from '@petd/protocol';
import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../kernel/logger.js';
import { MethodRegistry } from './registry.js';
import { verifyToken } from './auth.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const IDEMPOTENCY_TTL_MS = 60_000;
const MAX_CLIENTS = 32;
const MAX_PAYLOAD = 4 * 1024 * 1024;

export interface GatewayOptions {
  host: string;
  port: number;
  token: string;
  version: string;
  startedAt: number;
  registry: MethodRegistry;
  bus: EventBus;
  logger: Logger;
  clock: Clock;
  /** 审批门：参数校验通过后、handler 执行前调用；返回 not allowed 时拒绝 */
  guard?: (ctx: {
    kind: 'method';
    name: string;
    scope?: 'read' | 'write' | 'system';
    params?: unknown;
    sessionId?: string;
    client?: ClientInfo;
  }) => Promise<{ allowed: boolean; reason?: string }>;
}

interface ClientState {
  id: string;
  ws: WebSocket;
  client: ClientInfo | null;
  authed: boolean;
}

interface CachedResponse {
  at: number;
  frame: ResFrame;
}

export class Gateway {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<string, ClientState>();
  private readonly cache = new Map<string, Map<string, CachedResponse>>();
  private stopping = false;

  constructor(private readonly opts: GatewayOptions) {}

  get port(): number | null {
    const addr = this.httpServer?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<number> {
    if (this.wss) throw new Error('网关已启动');
    const server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('petd 只接受 WebSocket 连接');
    });
    const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
    wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? 'local'));
    wss.on('error', (err) => this.opts.logger.error('wss error', { error: String(err) }));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.opts.port, this.opts.host);
    });

    this.httpServer = server;
    this.wss = wss;
    const port = this.port;
    if (port === null) throw new Error('监听失败：无法取得端口');
    this.opts.logger.info('gateway listening', { host: this.opts.host, port });
    return port;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const c of this.clients.values()) {
      try {
        c.ws.close(1001, 'petd shutting down');
      } catch {}
    }
    this.clients.clear();
    this.cache.clear();
    const wss = this.wss;
    const server = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 兜底：避免 keep-alive 连接拖住退出
        setTimeout(resolve, 1000).unref?.();
      });
    }
  }

  /** 向所有已握手客户端广播事件（seq 来自 EventBus，全局单调） */
  publish(event: string, data?: unknown): void {
    const ev = this.opts.bus.emit(event, data);
    const frame: EventFrame = {
      type: 'event',
      event: ev.event,
      seq: ev.seq,
      ts: ev.ts,
      ...(ev.data === undefined ? {} : { data: ev.data }),
    };
    for (const c of this.clients.values()) {
      if (c.authed) this.send(c.ws, frame);
    }
  }

  private onConnection(ws: WebSocket, remote: string): void {
    if (this.clients.size >= MAX_CLIENTS) {
      this.send(ws, { type: 'res', id: 'handshake', ok: false, error: errorBody('E_UNAVAILABLE', '连接数已满') });
      ws.close(4005, 'too many clients');
      return;
    }
    const state: ClientState = { id: randomUUID(), ws, client: null, authed: false };
    this.clients.set(state.id, state);
    this.opts.logger.debug('client connected', { sessionId: state.id, remote });

    ws.on('message', (raw) => {
      this.onMessage(state, raw).catch((err) => {
        this.opts.logger.error('message handler crashed', { error: String(err) });
        this.send(state.ws, { type: 'res', id: 'internal', ok: false, error: errorBody('E_INTERNAL', '内部错误') });
      });
    });
    ws.on('close', () => {
      this.clients.delete(state.id);
      this.cache.delete(state.id);
      this.opts.logger.debug('client disconnected', { sessionId: state.id });
    });
    ws.on('error', (err) => {
      this.opts.logger.warn('client socket error', { sessionId: state.id, error: String(err) });
    });
  }

  private async onMessage(state: ClientState, raw: RawData): Promise<void> {
    if (this.stopping) return;
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw as Buffer[]).toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
    const parsed = parseInbound(text);
    if (!parsed.ok) {
      this.fail(state, 'handshake', parsed.error, 4002);
      return;
    }
    const frame = parsed.frame;
    if (!state.authed) {
      if (frame.type !== 'connect') {
        this.fail(state, 'handshake', errorBody('E_HANDSHAKE', '第一帧必须是 connect'), 4001);
        return;
      }
      this.handleConnect(state, frame);
      return;
    }
    if (frame.type === 'connect') {
      this.fail(state, 'handshake', errorBody('E_HANDSHAKE', '重复握手'), 4001);
      return;
    }
    await this.handleRequest(state, frame.id, frame.method, frame.params);
  }

  private handleConnect(state: ClientState, frame: { protocol?: number; token: string; client: ClientInfo }): void {
    if (frame.protocol !== undefined && frame.protocol !== PROTOCOL_VERSION) {
      this.fail(state, 'connect', errorBody('E_HANDSHAKE', `协议版本不匹配：客户端 ${frame.protocol}，服务端 ${PROTOCOL_VERSION}`), 4004);
      return;
    }
    if (!verifyToken(this.opts.token, frame.token)) {
      this.opts.logger.warn('handshake rejected: bad token', { sessionId: state.id, client: frame.client.name });
      this.fail(state, 'connect', errorBody('E_UNAUTHORIZED', 'token 不正确'), 4003);
      return;
    }
    state.authed = true;
    state.client = frame.client;
    const hello: HelloFrame = {
      type: 'hello',
      server: { name: SERVER_NAME, version: this.opts.version, protocol: PROTOCOL_VERSION, pid: process.pid },
      sessionId: state.id,
    };
    this.send(state.ws, hello);
    this.opts.logger.info('client authenticated', { sessionId: state.id, client: frame.client.name });
  }

  private async handleRequest(state: ClientState, id: string, method: string, params: unknown): Promise<void> {
    const started = this.opts.clock.mono();
    const cached = this.lookupCache(state.id, id);
    if (cached) {
      this.send(state.ws, cached.frame);
      return;
    }

    let frame: ResFrame;
    try {
      const reg = this.opts.registry.requireMethod(method);
      const paramError = this.opts.registry.validate(method, params);
      if (paramError) {
        frame = { type: 'res', id, ok: false, error: paramError };
      } else {
        const verdict =
          this.opts.guard === undefined
            ? { allowed: true as const }
            : await this.opts.guard({
                kind: 'method',
                name: method,
                scope: reg.descriptor.scope,
                params,
                sessionId: state.id,
                ...(state.client === null ? {} : { client: state.client }),
              });
        if (!verdict.allowed) {
          frame = {
            type: 'res',
            id,
            ok: false,
            error: errorBody('E_FORBIDDEN', verdict.reason ?? '这次操作没有通过审批门'),
          };
        } else {
          const timeoutMs = reg.descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
          const ctx = {
            sessionId: state.id,
            client: state.client ?? { name: 'unknown', version: '0' },
            signal: controller.signal,
            startedAt: this.opts.clock.now(),
          };
          // 超时以 abort 为准：handler 不配合时也不能把请求挂死
          const data = await new Promise<unknown>((resolve, reject) => {
            const onAbort = (): void => reject(new PetdError('E_TIMEOUT', '方法执行超时'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(reg.handler(params, ctx)).then(
              (value) => {
                controller.signal.removeEventListener('abort', onAbort);
                resolve(value);
              },
              (err: unknown) => {
                controller.signal.removeEventListener('abort', onAbort);
                reject(err);
              }
            );
          });
          frame = { type: 'res', id, ok: true, ...(data === undefined ? {} : { data }) };
          } finally {
            clearTimeout(timer);
          }
        }
      }
    } catch (err) {
      frame = { type: 'res', id, ok: false, error: this.toErrorBody(err) };
      if (!isPetdError(err)) {
        this.opts.logger.error('method failed', { method, error: String(err) });
      }
    }

    const durationMs = Math.max(0, this.opts.clock.mono() - started);
    this.opts.logger.debug('req done', { method, id, ok: frame.ok, durationMs });
    if (frame.ok && this.opts.registry.get(method)?.descriptor.idempotent !== false) {
      this.storeCache(state.id, id, frame);
    }
    this.send(state.ws, frame);
  }

  private toErrorBody(err: unknown): ErrorBody {
    if (isPetdError(err)) {
      return errorBody(err.code, err.message, err.details);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return errorBody('E_TIMEOUT', '方法执行超时');
    }
    return errorBody('E_INTERNAL', '内部错误');
  }

  private lookupCache(sessionId: string, id: string): CachedResponse | null {
    const m = this.cache.get(sessionId);
    if (!m) return null;
    const hit = m.get(id);
    if (!hit) return null;
    if (this.opts.clock.now() - hit.at > IDEMPOTENCY_TTL_MS) {
      m.delete(id);
      return null;
    }
    return hit;
  }

  private storeCache(sessionId: string, id: string, frame: ResFrame): void {
    let m = this.cache.get(sessionId);
    if (!m) {
      m = new Map();
      this.cache.set(sessionId, m);
    }
    m.set(id, { at: this.opts.clock.now(), frame });
    if (m.size > 256) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
  }

  private fail(state: ClientState, id: string, error: ErrorBody, closeCode: number): void {
    this.send(state.ws, { type: 'res', id, ok: false, error });
    try {
      state.ws.close(closeCode, error.code);
    } catch {}
  }

  private send(ws: WebSocket, frame: HelloFrame | ResFrame | EventFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.opts.logger.warn('send failed', { error: String(err) });
    }
  }
}

/** 供 health.status 等只读方法使用的小工具 */
export function clientInfoSummary(state: Pick<ClientState, 'client'>): string {
  return state.client ? `${state.client.name}@${state.client.version}` : 'anonymous';
}
