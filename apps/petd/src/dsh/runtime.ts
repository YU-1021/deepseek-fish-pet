/**
 * DSH SDK runtime：用 Desktop 自带的 Electron 当 Node 起一个私有 runtime，
 * 通过 stdio 上的 JSON-RPC 和它对话（实测 `--profile sdk` 通）。
 *
 * 为什么起私有 runtime 而不是连桌面 GUI：
 * - 桌面 GUI 跑的是 desktop profile，不挂 SDK stdio 服务；
 * - SDK 的 session/resume 只能恢复「没被占用」的会话，无法同时附着到 GUI 正在用的会话；
 * - 私有 runtime 的会话仍落在同一个 $DSH_HOME/sessions 里，GUI 之后能 resume。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { PetdError } from '@petd/protocol';
import {
  DshFrameDecoder,
  encodeFrame,
  isNotification,
  isRequest,
  isResponse,
  viewDshEvent,
  type DshApprovalParams,
  type DshApprovalOutcome,
  type DshApprovalResult,
  type DshInitializeResult,
  type DshJsonRpcMessage,
  type DshSessionEvent,
  type DshSessionPromptResult,
  type DshSessionStatus,
} from './protocol.js';

export interface DshLogger {
  debug?: (msg: string, data?: Record<string, unknown>) => void;
  info?: (msg: string, data?: Record<string, unknown>) => void;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
  error?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface DshRuntimeHandlers {
  onEvent?: (event: DshSessionEvent) => void;
  onStatus?: (status: DshSessionStatus) => void;
  /** 审批请求：返回结果；不处理或抛错都按拒绝 */
  onApproval?: (params: DshApprovalParams) => Promise<DshApprovalOutcome> | DshApprovalOutcome;
  onNotice?: (method: string, params: unknown) => void;
  onExit?: (code: number | null) => void;
}

export interface DshRuntimeOptions {
  exePath: string;
  cliPath: string;
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  approvalRequests?: boolean;
  logger?: DshLogger;
  handlers?: DshRuntimeHandlers;
  initTimeoutMs?: number;
  /** 测试注入：默认 node:child_process.spawn */
  spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
}

export interface DshRuntimeStatus {
  running: boolean;
  pid: number | null;
  provider: string;
  model: string;
  cwd: string;
  serverInfo: { name: string; version: string } | null;
  startedAt: number | null;
  lastExitCode: number | null;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

export class DshRuntime {
  private readonly opts: DshRuntimeOptions;
  private child: ChildProcess | null = null;
  private decoder: DshFrameDecoder | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private serverInfo: { name: string; version: string } | null = null;
  private startedAt: number | null = null;
  private lastExitCode: number | null = null;
  private starting: Promise<void> | null = null;
  private exiting = false;

  constructor(options: DshRuntimeOptions) {
    this.opts = options;
  }

  status(): DshRuntimeStatus {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      provider: this.opts.provider,
      model: this.opts.model,
      cwd: this.opts.cwd,
      serverInfo: this.serverInfo,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
    };
  }

  async start(): Promise<void> {
    if (this.child !== null) return;
    if (this.starting !== null) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const { opts } = this;
    if (!fs.existsSync(opts.exePath)) {
      throw new PetdError('E_UNAVAILABLE', `找不到 DeepSeek Harness 可执行文件：${opts.exePath}（可改 config.dsh.exePath）`);
    }
    // app.asar 里的文件普通 Node fs 看不见，但 Electron 运行时（ELECTRON_RUN_AS_NODE）能读
    const cliInAsar = /[\\/]app\.asar[\\/]/i.test(opts.cliPath);
    if (!cliInAsar && !fs.existsSync(opts.cliPath)) {
      throw new PetdError('E_UNAVAILABLE', `找不到 DSH CLI 入口：${opts.cliPath}（可改 config.dsh.cliPath）`);
    }
    if (!fs.existsSync(opts.cwd)) {
      try {
        fs.mkdirSync(opts.cwd, { recursive: true });
      } catch {
        throw new PetdError('E_UNAVAILABLE', `无法创建 DSH 工作目录：${opts.cwd}`);
      }
    }
    const spawnFn = opts.spawnImpl ?? spawn;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawnFn(opts.exePath, ['--expose-internals', opts.cliPath, '--profile', 'sdk'], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    this.exiting = false;
    this.decoder = new DshFrameDecoder((_line, error) => {
      opts.logger?.warn?.('DSH 输出里有无法解析的行', { error: String(error) });
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const messages = this.decoder?.push(chunk) ?? [];
      for (const msg of messages) this.handleMessage(msg);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // DSH 的模型列表/调试信息都往 stderr 写，降级成 debug
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() !== '') opts.logger?.debug?.('DSH stderr', { line: line.slice(0, 500) });
      }
    });
    child.on('error', (error) => {
      opts.logger?.error?.('DSH runtime 进程错误', { error: String(error) });
      this.failAll(new PetdError('E_UNAVAILABLE', `DSH runtime 进程错误：${String(error)}`));
    });
    child.on('exit', (code) => {
      this.lastExitCode = code;
      this.child = null;
      this.decoder = null;
      this.failAll(new PetdError('E_UNAVAILABLE', `DSH runtime 已退出（code=${String(code)}）`));
      opts.handlers?.onExit?.(code);
    });
    const initParams: Record<string, unknown> = {
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
    };
    if (opts.reasoningEffort) initParams['reasoningEffort'] = opts.reasoningEffort;
    if (typeof opts.maxTokens === 'number') initParams['maxTokens'] = opts.maxTokens;
    if (opts.approvalRequests) initParams['approvalRequests'] = true;
    try {
      const result = (await this.request('initialize', initParams, opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS)) as
        | DshInitializeResult
        | undefined;
      this.serverInfo = result?.serverInfo ?? null;
    } catch (error) {
      this.child?.kill();
      this.child = null;
      this.decoder = null;
      throw new PetdError(
        'E_UNAVAILABLE',
        `DSH SDK runtime 握手失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async prompt(sessionId: string, text: string, timeoutMs: number): Promise<DshSessionPromptResult> {
    if (this.child === null) await this.start();
    const result = (await this.request(
      'session/prompt',
      { sessionId, contentBlocks: [{ type: 'text', text }] },
      timeoutMs
    )) as DshSessionPromptResult;
    return { messageId: String(result?.messageId ?? '') };
  }

  /** 恢复一个已持久化的会话（对已存在的 sessionId，session/prompt 会报 already exists） */
  async resume(sessionId: string, timeoutMs: number): Promise<void> {
    if (this.child === null) await this.start();
    await this.request('session/resume', { sessionId }, timeoutMs);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new PetdError('E_UNAVAILABLE', 'DSH runtime 未运行'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PetdError('E_UNAVAILABLE', `DSH 方法 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        child.stdin?.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PetdError('E_UNAVAILABLE', `写 DSH stdin 失败：${String(error)}`));
      }
    });
  }

  private handleMessage(msg: DshJsonRpcMessage): void {
    if (isResponse(msg)) {
      const id = msg.id;
      if (typeof id !== 'number') return;
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (msg.error) {
        call.reject(new PetdError('E_UNAVAILABLE', `DSH ${call.method} 返回错误：${msg.error.message ?? '未知错误'}`));
      } else {
        call.resolve(msg.result);
      }
      return;
    }
    if (isRequest(msg)) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === 'session.event') {
        const params = msg.params as { sessionId?: unknown; event?: unknown } | undefined;
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        const event = params?.event;
        if (event !== null && typeof event === 'object') {
          this.opts.handlers?.onEvent?.({ sessionId, event: event as Record<string, unknown> });
        }
      } else if (msg.method === 'session.status') {
        const params = msg.params as { sessionId?: unknown; status?: unknown } | undefined;
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
        const status = params?.status;
        if (status === 'idle' || status === 'running') {
          this.opts.handlers?.onStatus?.({ sessionId, status });
        }
      } else {
        this.opts.handlers?.onNotice?.(msg.method, msg.params);
      }
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const write = (frame: Record<string, unknown>): void => {
      try {
        this.child?.stdin?.write(encodeFrame({ jsonrpc: '2.0', id, ...frame }));
      } catch (error) {
        this.opts.logger?.warn?.('回 DSH 请求失败', { method, error: String(error) });
      }
    };
    const respondResult = (result: Record<string, unknown>): void => {
      write({ result });
    };
    if (method === 'approval/request') {
      const approval = (params ?? {}) as DshApprovalParams;
      let outcome: DshApprovalOutcome = 'rejected';
      try {
        outcome = (await this.opts.handlers?.onApproval?.(approval)) ?? 'rejected';
      } catch (error) {
        this.opts.logger?.warn?.('审批处理失败，按拒绝', { error: String(error) });
        outcome = 'rejected';
      }
      respondResult({ outcome });
      return;
    }
    this.opts.logger?.debug?.('DSH 发来未实现的服务器请求', { method });
    write({ error: { code: -32601, message: `petd 暂不支持 ${method}` } });
  }

  private failAll(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.exiting = true;
    try {
      await this.request('shutdown', {}, 2000);
    } catch {
      // 忽略：可能已经退出
    }
    const exited = await this.waitExit(child, 3000);
    if (!exited) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }
    this.child = null;
    this.decoder = null;
    this.failAll(new PetdError('E_UNAVAILABLE', 'DSH runtime 已关闭'));
    this.opts.logger?.info?.('DSH runtime 已关闭', { exiting: this.exiting });
  }

  private waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }
}

/** 从 DSH 事件里挑少量字段给前端/日志用（原始事件可能很大，不全量外发） */
export function summarizeDshEvent(event: DshSessionEvent): Record<string, unknown> {
  const view = viewDshEvent(event.event);
  const out: Record<string, unknown> = { sessionId: event.sessionId, type: view.type, at: Date.now() };
  if (view.turn !== null) out['turn'] = view.turn;
  if (view.step !== null) out['step'] = view.step;
  if (view.tool !== null) out['tool'] = view.tool;
  if (view.text !== null) out['text'] = view.text.slice(0, 500);
  return out;
}
