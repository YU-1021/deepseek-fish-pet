/**
 * reminder.* 方法测试：注册、开关、创建/列表/取消/稍后、参数校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { ReminderStore } from '../../reminders/store.js';
import { registerReminderMethods } from './reminder.js';

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
  store: ReminderStore;
  enabled: { value: boolean };
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-reminder-methods-'));
  const store = new ReminderStore({ file: path.join(dir, 'reminders.json'), armTimers: false });
  store.ensure();
  const enabled = { value: true };
  const reg = new MethodRegistry();
  registerReminderMethods(reg, { store, enabled: () => enabled.value });
  return { reg, store, enabled };
}

async function call(h: Harness, name: string, params: unknown): Promise<unknown> {
  const m = h.reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx());
}

test('注册 5 个 reminder.* 方法', () => {
  const h = harness();
  assert.deepEqual(h.reg.names().filter((n) => n.startsWith('reminder.')), [
    'reminder.cancel',
    'reminder.create',
    'reminder.list',
    'reminder.snooze',
    'reminder.status',
  ]);
  const create = h.reg.get('reminder.create');
  assert.ok(create);
  assert.equal(create.descriptor.scope, 'write');
  assert.equal(create.descriptor.idempotent, false);
});

test('status / create / list / snooze / cancel 全流程', async () => {
  const h = harness();
  const status0 = (await call(h, 'reminder.status', {})) as { enabled: boolean; pending: number };
  assert.equal(status0.enabled, true);
  assert.equal(status0.pending, 0);

  const item = (await call(h, 'reminder.create', { text: '喝水', inMinutes: 30 })) as {
    id: string;
    text: string;
    inMinutes: number;
  };
  assert.equal(item.text, '喝水');
  assert.equal(item.inMinutes, 30);

  const list = (await call(h, 'reminder.list', {})) as { items: Array<{ id: string }> };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]?.id, item.id);

  const snoozed = (await call(h, 'reminder.snooze', { id: item.id, minutes: 10 })) as { snoozes: number; at: number };
  assert.equal(snoozed.snoozes, 1);

  const cancelled = (await call(h, 'reminder.cancel', { id: item.id })) as { id: string };
  assert.equal(cancelled.id, item.id);
  const list2 = (await call(h, 'reminder.list', {})) as { items: unknown[] };
  assert.equal(list2.items.length, 0);
});

test('开关关闭时返回 E_UNAVAILABLE', async () => {
  const h = harness();
  h.enabled.value = false;
  await assert.rejects(
    () => call(h, 'reminder.create', { text: '喝水', inMinutes: 5 }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  // status 仍可读，但 enabled=false
  const status = (await call(h, 'reminder.status', {})) as { enabled: boolean };
  assert.equal(status.enabled, false);
});

test('参数校验：缺时间、空文本、非法时刻', async () => {
  const h = harness();
  await assert.rejects(
    () => call(h, 'reminder.create', { text: '喝水' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'reminder.create', { text: '   ', inMinutes: 5 }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'reminder.create', { text: '喝水', atClock: '25:99' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'reminder.cancel', { id: 'nope' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});
