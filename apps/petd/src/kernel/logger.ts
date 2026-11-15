/**
 * 日志：JSONL 落盘 + 轮转 + 可选 echo 到 stdout。
 *
 * 不许在业务代码里 console.log —— 统一走 logger（阶段 0 的教训：日志无级别/无轮转）。
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  file: string;
  level: LogLevel;
  maxBytes: number;
  echo?: boolean;
  /** 注入时钟便于测试 */
  now?: () => number;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
  level: LogLevel;
}

export function createLogger(opts: LoggerOptions): Logger {
  const now = opts.now ?? (() => Date.now());
  let level = opts.level;
  let size = 0;
  try {
    size = fs.statSync(opts.file).size;
  } catch {
    size = 0;
  }
  try {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  } catch {}

  function rotateIfNeeded(): void {
    if (size <= opts.maxBytes) return;
    try {
      fs.renameSync(opts.file, opts.file + '.1');
    } catch {}
    size = 0;
  }

  function write(lv: LogLevel, msg: string, ctx?: Record<string, unknown>, bindings?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lv] < LEVEL_ORDER[level]) return;
    const line = JSON.stringify({ ts: now(), level: lv, msg, ...(bindings ?? {}), ...(ctx ?? {}) });
    try {
      fs.appendFileSync(opts.file, line + '\n', 'utf8');
      size += Buffer.byteLength(line, 'utf8') + 1;
      rotateIfNeeded();
    } catch {}
    if (opts.echo) {
      try {
        process.stdout.write(line + '\n');
      } catch {}
    }
  }

  function make(bindings: Record<string, unknown>): Logger {
    return {
      get level() {
        return level;
      },
      set level(v: LogLevel) {
        level = v;
      },
      debug: (m, c) => write('debug', m, c, bindings),
      info: (m, c) => write('info', m, c, bindings),
      warn: (m, c) => write('warn', m, c, bindings),
      error: (m, c) => write('error', m, c, bindings),
      child: (b) => make({ ...bindings, ...b }),
    } as Logger;
  }

  return make({});
}
