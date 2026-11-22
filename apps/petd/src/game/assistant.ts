/**
 * 游戏助手（petd → 预习助手）：
 *
 * 通过子进程运行「预习助手」里的 `tools/petd-bridge.js`，stdio 一行 JSON 往返。
 * 能力：看屏（MAA method 8 抓帧 + PaddleOCR 识别）、找文字/模板、匹配干员、后台点击。
 *
 * 安全默认：
 *   - `config.game.enabled=false` 时不 spawn，聊天里也不出现 game_* 工具；
 *   - 点干员默认只做 dry-run（返回计划坐标），真点必须 `config.game.allowClick=true`
 *     且调用方显式 `real:true`。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';

export type GameConfig = PetdConfig['game'];

export interface GameLogger {
  debug?(message: string, extra?: Record<string, unknown>): void;
  info?(message: string, extra?: Record<string, unknown>): void;
  warn?(message: string, extra?: Record<string, unknown>): void;
  error?(message: string, extra?: Record<string, unknown>): void;
}

export interface GameAssistantOptions {
  config: () => GameConfig;
  home: string;
  logger: GameLogger;
  spawnImpl?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => ChildProcess;
  now?: () => number;
}

export interface GameAssistantStatus {
  enabled: boolean;
  assistantDir: string;
  bridgePath: string;
  nodePath: string;
  allowClick: boolean;
  gameHint: string;
  counters: { calls: number; ok: number; errors: number };
  lastError: string | null;
  lastCallAt: number | null;
}

export type GameOp = 'status' | 'look' | 'find' | 'template' | 'operators' | 'click';

export interface GameCallOptions {
  /** 覆盖配置里的超时（毫秒） */
  timeoutMs?: number;
}

export interface GameLookOptions {
  find?: string[];
  template?: string[];
  ocrEngine?: 'paddle' | 'windows';
  textMax?: number;
}

const ASSISTANT_CANDIDATES = [
  'C:\\deepseek\\预习助手',
  'F:\\DSH\\大肥鱼\\预习助手',
];

const BRIDGE_RELATIVE = path.join('tools', 'petd-bridge.js');

export class GameAssistant {
  private readonly config: () => GameConfig;
  private readonly home: string;
  private readonly logger: GameLogger;
  private readonly spawnImpl: NonNullable<GameAssistantOptions['spawnImpl']>;
  private readonly now: () => number;
  private counters = { calls: 0, ok: 0, errors: 0 };
  private lastError: string | null = null;
  private lastCallAt: number | null = null;

  constructor(options: GameAssistantOptions) {
    this.config = options.config;
    this.home = options.home;
    this.logger = options.logger;
    this.spawnImpl = options.spawnImpl ?? ((command, args, opts) => spawn(command, args, opts as never));
    this.now = options.now ?? (() => Date.now());
  }

  status(): GameAssistantStatus {
    const cfg = this.config();
    const dir = this.resolveAssistantDir();
    return {
      enabled: cfg.enabled,
      assistantDir: dir,
      bridgePath: dir ? path.join(dir, BRIDGE_RELATIVE) : '',
      nodePath: this.resolveNodePath(),
      allowClick: cfg.allowClick,
      gameHint: cfg.gameHint,
      counters: { ...this.counters },
      lastError: this.lastError,
      lastCallAt: this.lastCallAt,
    };
  }

  /** 底层调用：一个 op 往返一次。返回桥的原始 JSON（ok 字段由桥给）。 */
  async call(op: GameOp, params: Record<string, unknown> = {}, options: GameCallOptions = {}): Promise<Record<string, unknown>> {
    if (!this.config().enabled) {
      throw new PetdError('E_UNAVAILABLE', '游戏助手没开启（config.game.enabled=false）');
    }
    const dir = this.resolveAssistantDir();
    if (!dir) {
      throw new PetdError('E_UNAVAILABLE', '找不到预习助手目录（config.game.assistantDir）');
    }
    const bridge = path.join(dir, BRIDGE_RELATIVE);
    if (!fs.existsSync(bridge)) {
      throw new PetdError('E_UNAVAILABLE', `预习助手目录里没有桥：${bridge}`);
    }
    const node = this.resolveNodePath();
    const timeoutMs = options.timeoutMs ?? this.config().timeoutMs;
    const body = JSON.stringify({ op, ...params });
    const startedAt = this.now();
    this.counters.calls += 1;
    this.lastCallAt = startedAt;
    try {
      const raw = await this.runBridge(node, bridge, dir, body, timeoutMs);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.counters.ok += 1;
      return parsed;
    } catch (error) {
      this.counters.errors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** 看当前游戏画面：抓帧 + OCR（+ 可选找字/模板）。游戏必须在前台可见，否则会拍到遮住它的窗口。 */
  async look(options: GameLookOptions = {}): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (options.find && options.find.length) params['find'] = options.find;
    if (options.template && options.template.length) params['template'] = options.template;
    if (options.ocrEngine) params['ocrEngine'] = options.ocrEngine;
    if (options.textMax !== undefined) params['textMax'] = options.textMax;
    return this.call('look', params, { timeoutMs: Math.max(this.config().timeoutMs, 60_000) });
  }

  /** 在画面上找一段文字（模糊匹配），返回覆盖率与坐标。 */
  async find(text: string, minCoverage?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { text };
    if (minCoverage !== undefined) params['minCoverage'] = minCoverage;
    return this.call('find', params, { timeoutMs: Math.max(this.config().timeoutMs, 60_000) });
  }

  /** 模板匹配（MAA 资源里的模板名，如 Return.png / PRTS1.png）。 */
  async template(names: string[]): Promise<Record<string, unknown>> {
    return this.call('template', { names }, { timeoutMs: Math.max(this.config().timeoutMs, 60_000) });
  }

  /** 干员头像匹配（返回每个干员的位置与分数）。 */
  async operators(ids: string[], slots?: Array<{ x: number; y: number; w: number; h: number }>): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { ids };
    if (slots && slots.length) params['slots'] = slots;
    return this.call('operators', params, { timeoutMs: Math.max(this.config().timeoutMs, 60_000) });
  }

  /**
   * 点游戏里的一个坐标。默认只算计划（dry-run）；真点需要：
   *   1) config.game.allowClick=true（主人手动打开）
   *   2) 调用方传 real:true（AI 明确表达要点）
   */
  async click(x: number, y: number, options: { real?: boolean } = {}): Promise<Record<string, unknown>> {
    if (options.real !== true) {
      const plan = await this.call('click', { x, y, allowReal: false });
      return { ...plan, dryRun: true };
    }
    if (!this.config().allowClick) {
      throw new PetdError('E_FORBIDDEN', '主人没打开真点开关（config.game.allowClick=false），这次只做计划、没有点');
    }
    return this.call('click', { x, y, allowReal: true }, { timeoutMs: Math.max(this.config().timeoutMs, 60_000) });
  }

  // ---- 内部 ----

  private resolveAssistantDir(): string {
    const cfg = this.config();
    if (cfg.assistantDir) return path.resolve(cfg.assistantDir);
    const fromEnv = process.env['PA_ASSISTANT_DIR'];
    if (fromEnv) return path.resolve(fromEnv);
    for (const candidate of ASSISTANT_CANDIDATES) {
      if (fs.existsSync(path.join(candidate, BRIDGE_RELATIVE))) return candidate;
    }
    for (const candidate of ASSISTANT_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  private resolveNodePath(): string {
    const cfg = this.config();
    if (cfg.nodePath) return cfg.nodePath;
    return process.execPath;
  }

  private runBridge(
    node: string,
    bridge: string,
    cwd: string,
    body: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(node, [bridge], {
          cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        reject(new PetdError('E_INTERNAL', `游戏助手桥启动失败：${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          try {
            child.kill();
          } catch {
            // 忽略
          }
          reject(new PetdError('E_INTERNAL', `游戏助手调用超时（${timeoutMs}ms）`));
        });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => errChunks.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        finish(() => reject(new PetdError('E_INTERNAL', `游戏助手桥出错：${error.message}`)));
      });
      child.on('close', (code) => {
        finish(() => {
          const stdout = Buffer.concat(chunks).toString('utf8').trim();
          const stderr = Buffer.concat(errChunks).toString('utf8').trim();
          if (!stdout) {
            reject(new PetdError('E_INTERNAL', `游戏助手桥没有输出（exit ${code}）${stderr ? '：' + stderr.slice(-300) : ''}`));
            return;
          }
          const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
          const last = lines.length ? lines[lines.length - 1] : '';
          if (!last) {
            reject(new PetdError('E_INTERNAL', `游戏助手桥输出不是 JSON：${stdout.slice(0, 300)}`));
            return;
          }
          resolve(last);
        });
      });
      child.stdin?.on('error', () => {
        // 子进程提前退出时写 stdin 会报错，交给 close 分支处理
      });
      try {
        child.stdin?.end(body + '\n');
      } catch (error) {
        this.logger.warn?.('游戏助手写 stdin 失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
