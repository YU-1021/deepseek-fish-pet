/**
 * plugin.* 方法测试：注册、列出/查看、启用/停用、开关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { PluginStore } from '../../plugins/store.js';
import { registerPluginMethods } from './plugin.js';

function ctx(): GatewayContext {
  return {
    sessionId: 'test-session',
    client: { name: 'test', version: '0.0.1' },
    signal: new AbortController().signal,
    startedAt: Date.now(),
  } as unknown as GatewayContext;
}

interface Harness {
  reg: MethodRegistry;
  store: PluginStore;
  enabled: { value: boolean };
  events: Array<{ event: string; data?: unknown }>;
}

function harness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-plugin-methods-'));
  const dir = path.join(root, 'plugins');
  const stateFile = path.join(root, 'state', 'plugins.json');
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'Demo', version: '1.0.0', description: '演示插件' }),
    'utf8'
  );
  const events: Array<{ event: string; data?: unknown }> = [];
  const store = new PluginStore({
    dir,
    stateFile,
    logger: { info() {}, warn() {} },
    publish: (event, data) => events.push({ event, data }),
  });
  store.ensure();
  const enabled = { value: true };
  const reg = new MethodRegistry();
  registerPluginMethods(reg, { store, enabled: () => enabled.value });
  return { reg, store, enabled, events };
}

async function call(h: Harness, name: string, params: unknown): Promise<unknown> {
  const m = h.reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx());
}

test('注册 4 个 plugin.* 方法', () => {
  const h = harness();
  assert.deepEqual(h.reg.names().filter((n) => n.startsWith('plugin.')), [
    'plugin.disable',
    'plugin.enable',
    'plugin.get',
    'plugin.list',
  ]);
  for (const name of ['plugin.list', 'plugin.get']) {
    assert.equal(h.reg.get(name)?.descriptor.scope, 'read');
  }
  for (const name of ['plugin.enable', 'plugin.disable']) {
    assert.equal(h.reg.get(name)?.descriptor.scope, 'write');
  }
});

test('list / get / enable / disable 全流程（含事件）', async () => {
  const h = harness();
  const listed = (await call(h, 'plugin.list', {})) as { plugins: Array<{ id: string; enabled: boolean }> };
  assert.deepEqual(listed.plugins.map((p) => p.id), ['demo']);
  assert.equal(listed.plugins[0]?.enabled, true);

  const got = (await call(h, 'plugin.get', { id: 'demo' })) as { id: string; name: string };
  assert.equal(got.name, 'Demo');

  const disabled = (await call(h, 'plugin.disable', { id: 'demo' })) as { enabled: boolean };
  assert.equal(disabled.enabled, false);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0]?.data, { id: 'demo', enabled: false });

  const enabledAgain = (await call(h, 'plugin.enable', { id: 'demo' })) as { enabled: boolean };
  assert.equal(enabledAgain.enabled, true);
  assert.equal(h.events.length, 2);
});

test('关闭时：写方法 E_UNAVAILABLE，读方法仍可用', async () => {
  const h = harness();
  h.enabled.value = false;

  await assert.rejects(
    () => call(h, 'plugin.disable', { id: 'demo' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  await assert.rejects(
    () => call(h, 'plugin.enable', { id: 'demo' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );

  const listed = (await call(h, 'plugin.list', {})) as { plugins: unknown[] };
  assert.equal(listed.plugins.length, 1);
});

test('未知插件返回 E_NOT_FOUND', async () => {
  const h = harness();
  await assert.rejects(
    () => call(h, 'plugin.get', { id: 'missing' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
  await assert.rejects(
    () => call(h, 'plugin.enable', { id: 'missing' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});
