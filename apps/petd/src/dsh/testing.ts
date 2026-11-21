/**
 * 测试辅助：模拟 DSH SDK runtime 的 stdin/stdout（不真起 Electron）。
 * 只被 *.test.ts 使用。
 */
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

export interface FakeFrame {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 记录 petd 写进来的帧，并按脚本回写 stdout */
export class FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: FakeFrame[] = [];
  private exitListeners: Array<(code: number | null) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private readonly handler: (frame: FakeFrame, child: FakeChild) => void;

  constructor(handler: (frame: FakeFrame, child: FakeChild) => void = () => {}) {
    this.handler = handler;
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        const frame = JSON.parse(line) as FakeFrame;
        this.written.push(frame);
        this.handler(frame, this);
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id: number, message: string): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
  }

  notify(method: string, params?: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(id: number, method: string, params?: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }

  once(event: string, listener: (...args: never[]) => void): this {
    if (event === 'exit') this.exitListeners.push(listener as unknown as (code: number | null) => void);
    return this;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'exit') this.exitListeners.push(listener as unknown as (code: number | null) => void);
    if (event === 'error') this.errorListeners.push(listener as unknown as (error: Error) => void);
    return this;
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    if (event === 'exit') {
      const idx = this.exitListeners.indexOf(listener as unknown as (code: number | null) => void);
      if (idx >= 0) this.exitListeners.splice(idx, 1);
    }
    return this;
  }

  kill(): boolean {
    this.finish(0);
    return true;
  }

  finish(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const listener of [...this.exitListeners]) listener(code);
  }
}

export function asChildProcess(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

/** 造一套「存在但假」的 exe/cli/cwd，满足 runtime 的存在性检查 */
export function makeRuntimeFiles(): { dir: string; exePath: string; cliPath: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-dsh-'));
  const exePath = path.join(dir, 'DeepSeek Harness.exe');
  const cliPath = path.join(dir, 'cli.js');
  const cwd = path.join(dir, 'cwd');
  fs.writeFileSync(exePath, '');
  fs.writeFileSync(cliPath, '');
  fs.mkdirSync(cwd, { recursive: true });
  return { dir, exePath, cliPath, cwd };
}

/** 标准 initialize/prompt/shutdown 应答脚本 */
export function standardHandler(options: { pollText?: string; tools?: boolean } = {}) {
  return (frame: FakeFrame, child: FakeChild): void => {
    if (frame.method === 'initialize') {
      child.respond(frame.id ?? 0, { serverInfo: { name: 'fake-sdk', version: '0.0.0' } });
      return;
    }
    if (frame.method === 'shutdown') {
      child.respond(frame.id ?? 0, {});
      setTimeout(() => child.finish(0), 0);
      return;
    }
    if (frame.method === 'session/prompt' && typeof frame.id === 'number') {
      child.respond(frame.id, { messageId: 'm-1' });
      setImmediate(() => {
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/start', turn: 1 } });
        if (options.tools) {
          child.notify('session.event', {
            sessionId: 'petd-bridge',
            event: { type: 'tool/call', turn: 1, step: 1, name: 'bash' },
          });
        }
        child.notify('session.event', {
          sessionId: 'petd-bridge',
          event: {
            type: 'assistant/message',
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: options.pollText ?? '收到' }] },
          },
        });
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/end', turn: 1, reason: { kind: 'completed' } } });
      });
      return;
    }
  };
}
