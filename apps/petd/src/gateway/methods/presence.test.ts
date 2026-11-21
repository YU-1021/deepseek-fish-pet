/**
 * presence.* 方法：注册、状态/列表、手动触发与事件、关闭时的错误。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MethodRegistry } from '../registry.js';
import { PresenceService } from '../../presence/service.js';
import { registerPresenceMethods } from './presence.js';
import type { PetdConfig } from '../../kernel/config.js';
import type { GatewayContext } from '@petd/protocol';

type PresenceConfig = PetdConfig['presence'];

const NOON = new Date(2026, 10, 21, 12, 0, 0).getTime();

function harness(overrides: Partial<PresenceConfig> = {}): {
  reg: MethodRegistry;
  presence: PresenceService;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-presencem-'));
  const config: PresenceConfig = {
    enabled: true,
    quiet: true,
    intervalMinutes: 45,
    idleMinutes: 0,
    maxPerDay: 12,
    nightQuiet: { enabled: true, start: '23:00', end: '07:00' },
    ...overrides,
  };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const presence = new PresenceService({
    file: path.join(dir, 'state', 'presence.json'),
    config: () => config,
    publish: (event, data) => events.push({ event, data }),
    now: () => NOON,
    armTimers: false,
  });
  presence.ensure();
  const reg = new MethodRegistry();
  registerPresenceMethods(reg, { presence });
  return { reg, presence, events };
}

const ctx: GatewayContext = {
  sessionId: 's-presence',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  const m = reg.requireMethod(name);
  return m.handler(params, ctx);
}

test('注册 3 个 presence.* 方法：status/list 只读、runOnce 写且不幂等', () => {
  const { reg } = harness();
  const names = reg.names().filter((n) => n.startsWith('presence.')).sort();
  assert.deepEqual(names, ['presence.list', 'presence.run_once', 'presence.status']);
  assert.equal(reg.scopeOf('presence.status'), 'read');
  assert.equal(reg.scopeOf('presence.list'), 'read');
  assert.equal(reg.scopeOf('presence.run_once'), 'write');
  const m = reg.requireMethod('presence.run_once');
  assert.equal(m.descriptor.idempotent, false);
});

test('status：返回开关/间隔/夜间段/今日次数', async () => {
  const { reg } = harness();
  const status = (await invoke(reg, 'presence.status')) as Record<string, unknown>;
  assert.equal(status['enabled'], true);
  assert.equal(status['quiet'], true);
  assert.equal(status['intervalMinutes'], 45);
  assert.deepEqual(status['nightQuiet'], { enabled: true, start: '23:00', end: '07:00' });
  assert.equal(status['countToday'], 0);
  assert.equal(status['last'], null);
});

test('runOnce：返回活动、写入列表、广播 presence.activity', async () => {
  const { reg, events } = harness();
  const activity = (await invoke(reg, 'presence.run_once')) as Record<string, unknown>;
  assert.equal(typeof activity['id'], 'string');
  assert.equal(typeof activity['label'], 'string');
  assert.equal(events.filter((e) => e.event === 'presence.activity').length, 1);
  const list = (await invoke(reg, 'presence.list', { limit: 10 })) as { activities: Array<Record<string, unknown>> };
  assert.equal(list.activities.length, 1);
  assert.equal(list.activities[0]?.['id'], activity['id']);
});

test('关闭时 runOnce 抛 E_UNAVAILABLE，status 仍可读', async () => {
  const { reg } = harness({ enabled: false });
  const status = (await invoke(reg, 'presence.status')) as Record<string, unknown>;
  assert.equal(status['enabled'], false);
  await assert.rejects(invoke(reg, 'presence.run_once'), /静默活动已关闭/);
});
