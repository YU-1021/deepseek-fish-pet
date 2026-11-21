/**
 * dsh.* 方法：注册、范围、状态/观察透传、prompt/ask 参数校验、审批回答。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MethodRegistry } from '../registry.js';
import { registerDshMethods } from './dsh.js';
import type { DshBridge } from '../../dsh/bridge.js';
import type { GatewayContext } from '@petd/protocol';

function harness(): {
  reg: MethodRegistry;
  calls: string[];
} {
  const calls: string[] = [];
  const bridge = {
    status: () => ({
      enabled: true,
      observe: true,
      started: true,
      runtime: null,
      observer: { enabled: true, sessionsDir: 'S', scanning: false, scannedAt: 1, session: null, error: null },
      paths: { exePath: 'E', cliPath: 'C', cwd: 'W', sessionsDir: 'S' },
      counters: { prompts: 0, asks: 0, errors: 0 },
      lastError: null,
      lastPromptAt: null,
      pendingApprovals: 0,
    }),
    observe: () => ({ enabled: true, sessionsDir: 'S', scanning: false, scannedAt: 2, session: null, error: null }),
    start: () => {
      calls.push('start');
    },
    stop: async () => {
      calls.push('stop');
    },
    warmup: async () => {
      calls.push('warmup');
    },
    prompt: async (text: string, sessionId?: string) => {
      calls.push(`prompt:${text}:${sessionId ?? ''}`);
      return { sessionId: sessionId ?? 'petd-bridge', messageId: 'm-1' };
    },
    ask: async (text: string, timeoutMs?: number) => {
      calls.push(`ask:${text}:${timeoutMs ?? ''}`);
      return { text: '好了', sessionId: 'petd-bridge', turn: 7, durationMs: 12 };
    },
    answerApproval: (id: string, outcome: string) => {
      calls.push(`approval:${id}:${outcome}`);
      return true;
    },
  } as unknown as DshBridge;
  const reg = new MethodRegistry();
  registerDshMethods(reg, { bridge });
  return { reg, calls };
}

const ctx: GatewayContext = {
  sessionId: 's-dsh',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  return reg.requireMethod(name).handler(params, ctx);
}

test('注册 7 个 dsh.* 方法，写方法标非幂等', () => {
  const { reg } = harness();
  const names = reg.names().filter((n) => n.startsWith('dsh.')).sort();
  assert.deepEqual(names, [
    'dsh.approval.answer',
    'dsh.ask',
    'dsh.observe',
    'dsh.prompt',
    'dsh.start',
    'dsh.status',
    'dsh.stop',
  ]);
  assert.equal(reg.scopeOf('dsh.status'), 'read');
  assert.equal(reg.scopeOf('dsh.observe'), 'read');
  for (const write of ['dsh.start', 'dsh.stop', 'dsh.prompt', 'dsh.ask', 'dsh.approval.answer']) {
    assert.equal(reg.scopeOf(write), 'write');
    assert.equal(reg.requireMethod(write).descriptor.idempotent, false);
  }
});

test('dsh.status/dsh.observe 直接透传桥状态', async () => {
  const { reg } = harness();
  const status = (await invoke(reg, 'dsh.status')) as Record<string, unknown>;
  assert.equal(status['enabled'], true);
  assert.equal(status['paths'] !== undefined, true);
  const observed = (await invoke(reg, 'dsh.observe')) as Record<string, unknown>;
  assert.equal(observed['scannedAt'], 2);
});

test('dsh.prompt：带 text/sessionId 调桥；缺 text 报 E_BAD_PARAMS', async () => {
  const { reg, calls } = harness();
  const result = (await invoke(reg, 'dsh.prompt', { text: '你好' })) as Record<string, unknown>;
  assert.equal(result['messageId'], 'm-1');
  assert.equal(result['sessionId'], 'petd-bridge');
  assert.deepEqual(calls, ['prompt:你好:']);
  await assert.rejects(invoke(reg, 'dsh.prompt', {}), /缺少参数 text/);
});

test('dsh.ask：透传 timeoutMs 并返回文字/turn', async () => {
  const { reg, calls } = harness();
  const result = (await invoke(reg, 'dsh.ask', { text: '查一下天气', timeoutMs: 10_000 })) as Record<string, unknown>;
  assert.equal(result['text'], '好了');
  assert.equal(result['turn'], 7);
  assert.equal(result['durationMs'], 12);
  assert.deepEqual(calls, ['ask:查一下天气:10000']);
});

test('dsh.approval.answer：校验 outcome 并转交', async () => {
  const { reg, calls } = harness();
  const result = (await invoke(reg, 'dsh.approval.answer', { id: 'a1', outcome: 'allowed-once' })) as Record<string, unknown>;
  assert.equal(result['resolved'], true);
  assert.deepEqual(calls, ['approval:a1:allowed-once']);
  await assert.rejects(invoke(reg, 'dsh.approval.answer', { id: 'a1', outcome: 'nope' }), /outcome 必须是/);
});

test('dsh.start 先开观察再预热；dsh.stop 调桥 stop', async () => {
  const { reg, calls } = harness();
  await invoke(reg, 'dsh.start');
  await invoke(reg, 'dsh.stop');
  assert.deepEqual(calls, ['start', 'warmup', 'stop']);
});
