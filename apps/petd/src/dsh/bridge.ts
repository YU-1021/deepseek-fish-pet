/**
 * DSH 桥（双向）：
 *
 *   DSH → 桌宠：观察桌面 GUI 会话（只读尾读 v4 日志，给表情/状态用）；
 *              私有 SDK runtime 的事件（思考/工具/回答）实时广播给前端。
 *   桌宠 → DSH：dsh.prompt（发任务）/ dsh.ask（发任务并等最终回答）；
 *              审批策略可配（默认拒绝，安全）。
 *
 * runtime 是懒启动的：只观察不花钱；第一次 prompt/ask 才 spawn（约 1–2s）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import { DshObserver, type DshObserverStatus } from './observe.js';
import { DshRuntime, summarizeDshEvent, type DshLogger, type DshRuntimeStatus } from './runtime.js';
import {
  viewDshEvent,
  type DshApprovalOutcome,
  type DshApprovalParams,
  type DshSessionEvent,
  type DshSessionPromptResult,
} from './protocol.js';

export type DshConfig = PetdConfig['dsh'];

export interface DshPromptResult {
  sessionId: string;
  messageId: string;
}

export interface DshAskResult {
  text: string;
  sessionId: string;
  turn: number | null;
  durationMs: number;
}

export interface DshBridgeStatus {
  enabled: boolean;
  observe: boolean;
  started: boolean;
  runtime: DshRuntimeStatus | null;
  observer: DshObserverStatus;
  paths: { exePath: string; cliPath: string; cwd: string; sessionsDir: string };
  counters: { prompts: number; asks: number; errors: number };
  lastError: string | null;
  lastPromptAt: number | null;
  pendingApprovals: number;
}

export interface DshBridgeOptions {
  config: () => DshConfig;
  home: string;
  logger: DshLogger;
  publish?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  armTimers?: boolean;
  spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => import('node:child_process').ChildProcess;
  /** 默认 $DSH_HOME 或 ~/.dsh */
  dshHome?: string;
}

interface AskWaiter {
  sessionId: string;
  texts: string[];
  turn: number | null;
  resolve: (result: DshAskResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface PendingApproval {
  id: string;
  params: DshApprovalParams;
  at: number;
  resolve: (outcome: DshApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

const BRIDGE_SESSION_ID = 'petd-bridge';
const APPROVAL_WAIT_MS = 120_000;

export class DshBridge {
  private readonly opts: DshBridgeOptions;
  private readonly now: () => number;
  private readonly observer: DshObserver;
  private runtime: DshRuntime | null = null;
  private waiters = new Set<AskWaiter>();
  private approvals = new Map<string, PendingApproval>();
  private started = false;
  private lastError: string | null = null;
  private lastPromptAt: number | null = null;
  private counters = { prompts: 0, asks: 0, errors: 0 };

  constructor(options: DshBridgeOptions) {
    this.opts = options;
    this.now = options.now ?? (() => Date.now());
    const dshHome = options.dshHome ?? process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh');
    const cfg = options.config();
    this.observer = new DshObserver({
      sessionsDir: path.join(dshHome, 'sessions'),
      activeMs: cfg.activeMs,
      pollMs: cfg.observeIntervalMs,
      logger: options.logger,
      publish: options.publish,
      now: this.now,
      ...(options.armTimers === undefined ? {} : { armTimers: options.armTimers }),
    });
  }

  status(): DshBridgeStatus {
    const cfg = this.opts.config();
    const observer = this.observer.status();
    return {
      enabled: cfg.enabled,
      observe: cfg.observe,
      started: this.started,
      runtime: this.runtime?.status() ?? null,
      observer,
      paths: {
        exePath: this.resolveExePath(cfg),
        cliPath: this.resolveCliPath(cfg),
        cwd: this.resolveCwd(cfg),
        sessionsDir: observer.sessionsDir,
      },
      counters: { ...this.counters },
      lastError: this.lastError,
      lastPromptAt: this.lastPromptAt,
      pendingApprovals: this.approvals.size,
    };
  }

  start(): void {
    const cfg = this.opts.config();
    if (!cfg.enabled) return;
    this.started = true;
    if (cfg.observe) this.observer.start();
  }

  async stop(): Promise<void> {
    this.observer.stop();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new PetdError('E_UNAVAILABLE', 'DSH 桥已关闭'));
    }
    this.waiters.clear();
    for (const [, approval] of this.approvals) {
      clearTimeout(approval.timer);
      approval.resolve('cancelled');
    }
    this.approvals.clear();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime !== null) {
      try {
        await runtime.stop();
      } catch (error) {
        this.opts.logger.warn?.('关闭 DSH runtime 失败', { error: String(error) });
      }
    }
    this.started = false;
  }

  /** 观察一次桌面 GUI 会话（没有定时器时也会扫一次） */
  observe(): DshObserverStatus {
    this.observer.scan();
    return this.observer.status();
  }

  /** 预热：把私有 SDK runtime 拉起来（dsh.start 用；失败抛真实原因） */
  async warmup(): Promise<void> {
    await this.ensureRuntime();
  }

  /** 发一条任务；立刻返回，事件走 dsh.event */
  async prompt(text: string, sessionId?: string): Promise<DshPromptResult> {
    const trimmed = text.trim();
    if (trimmed === '') throw new PetdError('E_BAD_PARAMS', '缺少参数 text（发给 DSH 的内容）');
    const runtime = await this.ensureRuntime();
    const sid = sessionId ?? BRIDGE_SESSION_ID;
    const result = await this.promptSession(runtime, sid, trimmed, this.opts.config().askTimeoutMs);
    this.counters.prompts += 1;
    this.lastPromptAt = this.now();
    return { sessionId: sid, messageId: result.messageId };
  }

  /** 发一条任务并等这一回合结束，拿到最终文字 */
  async ask(text: string, timeoutMs?: number): Promise<DshAskResult> {
    const trimmed = text.trim();
    if (trimmed === '') throw new PetdError('E_BAD_PARAMS', '缺少参数 text（问 DSH 什么）');
    const cfg = this.opts.config();
    const runtime = await this.ensureRuntime();
    const sessionId = BRIDGE_SESSION_ID;
    const startedAt = this.now();
    const limit = timeoutMs ?? cfg.askTimeoutMs;
    const waiting = new Promise<DshAskResult>((resolve, reject) => {
      const waiter: AskWaiter = {
        sessionId,
        texts: [],
        turn: null,
        resolve,
        reject,
        startedAt,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new PetdError('E_UNAVAILABLE', `DSH 回答超时（${limit}ms）`));
        }, limit),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
    try {
      const result = await this.promptSession(runtime, sessionId, trimmed, cfg.askTimeoutMs);
      this.counters.prompts += 1;
      this.lastPromptAt = startedAt;
      this.opts.logger.debug?.('已把消息交给 DSH', { sessionId, messageId: result.messageId });
    } catch (error) {
      this.counters.errors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      for (const waiter of this.waiters) {
        if (waiter.sessionId === sessionId) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      throw error;
    }
    const answered = await waiting;
    this.counters.asks += 1;
    return answered;
  }

  /** 前端回答一个待审批请求 */
  answerApproval(id: string, outcome: DshApprovalOutcome): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    this.approvals.delete(id);
    clearTimeout(approval.timer);
    approval.resolve(outcome);
    this.opts.publish?.('dsh.approval.resolved', { id, outcome });
    return true;
  }

  private async ensureRuntime(): Promise<DshRuntime> {
    if (!this.opts.config().enabled) {
      throw new PetdError('E_UNAVAILABLE', 'DSH 桥已关闭（config.dsh.enabled=false）');
    }
    if (this.runtime !== null) {
      await this.runtime.start();
      return this.runtime;
    }
    const cfg = this.opts.config();
    const runtime = new DshRuntime({
      exePath: this.resolveExePath(cfg),
      cliPath: this.resolveCliPath(cfg),
      cwd: this.resolveCwd(cfg),
      provider: cfg.provider,
      model: cfg.model,
      ...(cfg.reasoningEffort === '' ? {} : { reasoningEffort: cfg.reasoningEffort }),
      maxTokens: cfg.maxTokens,
      approvalRequests: cfg.approvalPolicy === 'ask',
      logger: this.opts.logger,
      handlers: {
        onEvent: (event) => this.handleRuntimeEvent(event),
        onStatus: (status) => {
          this.opts.publish?.('dsh.status', {
            sessionId: status.sessionId,
            status: status.status,
            at: this.now(),
          });
        },
        onApproval: (params) => this.handleApproval(params),
        onExit: () => {
          this.runtime = null;
          this.opts.publish?.('dsh.status', { runtime: 'exited', at: this.now() });
        },
      },
      ...(this.opts.spawnImpl === undefined ? {} : { spawnImpl: this.opts.spawnImpl }),
    });
    this.runtime = runtime;
    try {
      await runtime.start();
    } catch (error) {
      this.runtime = null;
      this.counters.errors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.opts.publish?.('dsh.status', { runtime: 'started', at: this.now() });
    return runtime;
  }

  private handleRuntimeEvent(event: DshSessionEvent): void {
    const view = viewDshEvent(event.event);
    this.opts.publish?.('dsh.event', summarizeDshEvent(event));
    if (view.type === '') return;
    for (const waiter of this.waiters) {
      if (waiter.sessionId !== event.sessionId) continue;
      if (view.type === 'turn/start') {
        if (view.turn !== null) waiter.turn = view.turn;
        waiter.texts = [];
      } else if (view.type === 'assistant/message') {
        if (view.text !== null) waiter.texts.push(view.text);
      } else if (view.type === 'turn/end') {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({
          text: waiter.texts.join('\n').trim(),
          sessionId: event.sessionId,
          turn: waiter.turn,
          durationMs: this.now() - waiter.startedAt,
        });
      }
    }
  }

  /**
   * 发一条消息；如果 sessionId 已在持久化存储里存在（session "x" already exists），
   * 先 session/resume 再重试一次。DSH 的 session/prompt 不会自动恢复已存在的会话。
   */
  private async promptSession(
    runtime: DshRuntime,
    sessionId: string,
    text: string,
    timeoutMs: number
  ): Promise<DshSessionPromptResult> {
    try {
      return await runtime.prompt(sessionId, text, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
      this.opts.logger.info?.('DSH 会话已存在，先恢复再发', { sessionId });
      await runtime.resume(sessionId, timeoutMs);
      return runtime.prompt(sessionId, text, timeoutMs);
    }
  }

  private handleApproval(params: DshApprovalParams): Promise<DshApprovalOutcome> | DshApprovalOutcome {
    const cfg = this.opts.config();
    if (cfg.approvalPolicy !== 'ask') {
      this.opts.logger.info?.('拒绝 DSH 审批请求（默认策略 reject）', {
        tool: params.toolName ?? '',
        reason: params.reason ?? '',
      });
      return 'rejected';
    }
    const id = crypto.randomUUID();
    const at = this.now();
    const promise = new Promise<DshApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve('rejected');
      }, APPROVAL_WAIT_MS);
      timer.unref?.();
      this.approvals.set(id, { id, params, at, resolve, timer });
    });
    this.opts.publish?.('dsh.approval', {
      id,
      sessionId: params.sessionId ?? '',
      toolName: params.toolName ?? '',
      reason: params.reason ?? '',
      at,
    });
    return promise;
  }

  private resolveExePath(cfg: DshConfig): string {
    const candidates: string[] = [];
    if (cfg.exePath) candidates.push(cfg.exePath);
    const envExe = process.env['DSH_EXE'] ?? process.env['DSH_NODE_EXECUTABLE'];
    if (envExe) candidates.push(envExe);
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    candidates.push('F:\\DSH\\DeepSeek Harness\\DeepSeek Harness.exe');
    candidates.push('C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe');
    for (const candidate of candidates) {
      if (candidate && fsExists(candidate)) return candidate;
    }
    return candidates[0] ?? '';
  }

  private resolveCliPath(cfg: DshConfig): string {
    if (cfg.cliPath) return cfg.cliPath;
    const exe = this.resolveExePath(cfg);
    if (!exe) return '';
    return path.join(
      path.dirname(exe),
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js'
    );
  }

  private resolveCwd(cfg: DshConfig): string {
    return cfg.cwd || path.join(this.opts.home, 'dsh-workspace');
  }
}

function fsExists(file: string): boolean {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
