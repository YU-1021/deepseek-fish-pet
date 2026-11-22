/**
 * game.* 方法：注册、范围、参数校验、dry-run 透传。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MethodRegistry } from '../registry.js';
import { registerGameMethods } from './game.js';
import type { GameAssistant } from '../../game/assistant.js';
import type { GatewayContext } from '@petd/protocol';

function harness(): { reg: MethodRegistry; calls: string[] } {
  const calls: string[] = [];
  const game = {
    status: () => ({
      enabled: true,
      assistantDir: 'D',
      bridgePath: 'B',
      nodePath: 'N',
      allowClick: false,
      gameHint: '明日方舟',
      counters: { calls: 1, ok: 1, errors: 0 },
      lastError: null,
      lastCallAt: 1,
    }),
    look: async (options: Record<string, unknown>) => {
      calls.push(`look:${JSON.stringify(options)}`);
      return { ok: true, capture: { w: 1280, h: 720 }, ocr: { text: '作战 12/21', lineCount: 1 } };
    },
    find: async (text: string, coverage?: number) => {
      calls.push(`find:${text}:${String(coverage)}`);
      return { ok: true, found: true, text, coverage: coverage ?? 0.9, box: { x: 1, y: 2, w: 3, h: 4 } };
    },
    template: async (names: string[]) => {
      calls.push(`template:${names.join(',')}`);
      return { ok: true, hits: [] };
    },
    click: async (x: number, y: number, options: { real?: boolean }) => {
      calls.push(`click:${x},${y}:${String(options?.real === true)}`);
      return { ok: true, dryRun: options?.real !== true, x, y };
    },
  } as unknown as GameAssistant;
  const reg = new MethodRegistry();
  registerGameMethods(reg, { game });
  return { reg, calls };
}

const ctx: GatewayContext = {
  sessionId: 's-game',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  return reg.requireMethod(name).handler(params, ctx);
}

test('注册 5 个 game.* 方法，click 是写且 dangerous、非幂等', () => {
  const { reg } = harness();
  const names = reg.names().filter((n) => n.startsWith('game.')).sort();
  assert.deepEqual(names, ['game.click', 'game.find', 'game.look', 'game.status', 'game.template']);
  assert.equal(reg.scopeOf('game.status'), 'read');
  assert.equal(reg.scopeOf('game.look'), 'read');
  assert.equal(reg.scopeOf('game.find'), 'read');
  assert.equal(reg.scopeOf('game.template'), 'read');
  assert.equal(reg.scopeOf('game.click'), 'write');
  assert.equal(reg.requireMethod('game.click').descriptor.dangerous, true);
  assert.equal(reg.requireMethod('game.click').descriptor.idempotent, false);
});

test('game.status 透传', async () => {
  const { reg } = harness();
  const res = (await invoke(reg, 'game.status')) as Record<string, unknown>;
  assert.equal(res['enabled'], true);
  assert.equal(res['assistantDir'], 'D');
});

test('game.look 过滤非法 find 项并透传 ocrEngine', async () => {
  const { reg, calls } = harness();
  await invoke(reg, 'game.look', { find: ['开始行动', 3, '代理指挥'], ocrEngine: 'windows', textMax: 500 });
  assert.deepEqual(calls, ['look:{"find":["开始行动","代理指挥"],"ocrEngine":"windows","textMax":500}']);
});

test('game.find 缺 text 报 E_BAD_PARAMS', async () => {
  const { reg } = harness();
  await assert.rejects(() => invoke(reg, 'game.find', {}), /缺少参数 text/);
});

test('game.template 缺 names 报 E_BAD_PARAMS', async () => {
  const { reg } = harness();
  await assert.rejects(() => invoke(reg, 'game.template', { names: [] }), /缺少参数 names/);
});

test('game.click 默认 dry-run，real:true 才真点', async () => {
  const { reg, calls } = harness();
  await invoke(reg, 'game.click', { x: 10, y: 20 });
  await invoke(reg, 'game.click', { x: 10, y: 20, real: true });
  assert.deepEqual(calls, ['click:10,20:false', 'click:10,20:true']);
});

test('game.click 参数类型不对时报 E_BAD_PARAMS', async () => {
  const { reg } = harness();
  await assert.rejects(() => invoke(reg, 'game.click', { x: 'a', y: 20 }), /缺少参数 x\/y/);
});
