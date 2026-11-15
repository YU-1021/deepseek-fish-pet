/**
 * skill.* 方法测试：注册、开关、增删改查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { SkillStore } from '../../skills/store.js';
import { registerSkillMethods } from './skill.js';

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
  store: SkillStore;
  enabled: { value: boolean };
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-skill-methods-'));
  const store = new SkillStore({ dir, promptMaxChars: 2000, logger: { info() {}, warn() {} } });
  store.ensure();
  const enabled = { value: true };
  const reg = new MethodRegistry();
  registerSkillMethods(reg, { store, enabled: () => enabled.value });
  return { reg, store, enabled };
}

async function call(h: Harness, name: string, params: unknown): Promise<unknown> {
  const m = h.reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx());
}

test('注册 5 个 skill.* 方法', () => {
  const h = harness();
  assert.deepEqual(h.reg.names().filter((n) => n.startsWith('skill.')), [
    'skill.create',
    'skill.delete',
    'skill.get',
    'skill.list',
    'skill.update',
  ]);
  for (const name of ['skill.list', 'skill.get']) {
    const m = h.reg.get(name);
    assert.ok(m);
    assert.equal(m.descriptor.scope, 'read');
  }
  for (const name of ['skill.create', 'skill.update', 'skill.delete']) {
    const m = h.reg.get(name);
    assert.ok(m);
    assert.equal(m.descriptor.scope, 'write');
    assert.equal(m.descriptor.idempotent, false);
  }
});

test('create / list / get / update / delete 全流程', async () => {
  const h = harness();
  const created = (await call(h, 'skill.create', {
    name: 'focus',
    description: '专注工作',
    body: '每 25 分钟提醒休息。',
    keywords: ['专注'],
    always: false,
  })) as { key: string; bodyChars: number };
  assert.equal(created.key, 'focus');
  assert.equal(created.bodyChars, '每 25 分钟提醒休息。'.length);

  const listed = (await call(h, 'skill.list', {})) as { skills: Array<{ key: string }> };
  assert.deepEqual(listed.skills.map((s) => s.key), ['focus']);

  const got = (await call(h, 'skill.get', { key: 'focus' })) as { body: string; source: string };
  assert.match(got.body, /提醒休息/);
  assert.equal(got.source, 'workspace');

  const updated = (await call(h, 'skill.update', { name: 'focus', always: true, body: '每 30 分钟提醒。' })) as {
    always: boolean;
  };
  assert.equal(updated.always, true);

  const deleted = (await call(h, 'skill.delete', { name: 'focus' })) as { deleted: boolean };
  assert.equal(deleted.deleted, true);
  assert.equal(h.store.list().length, 0);
});

test('关闭时：写方法 E_UNAVAILABLE，读方法仍可用', async () => {
  const h = harness();
  await call(h, 'skill.create', { name: 'keep', body: '正文' });
  h.enabled.value = false;

  await assert.rejects(
    () => call(h, 'skill.create', { name: 'blocked', body: '正文' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  await assert.rejects(
    () => call(h, 'skill.update', { name: 'keep', body: '改' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  await assert.rejects(
    () => call(h, 'skill.delete', { name: 'keep' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );

  const listed = (await call(h, 'skill.list', {})) as { skills: unknown[] };
  assert.equal(listed.skills.length, 1);
  const got = (await call(h, 'skill.get', { key: 'keep' })) as { body: string };
  assert.match(got.body, /正文/);
});

test('重名创建与不存在读取返回明确错误', async () => {
  const h = harness();
  await call(h, 'skill.create', { name: 'dup', body: '正文' });
  await assert.rejects(
    () => call(h, 'skill.create', { name: 'dup', body: '再来' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
  await assert.rejects(
    () => call(h, 'skill.get', { key: 'missing' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});
