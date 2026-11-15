/**
 * hooks.* / approval.* 方法测试：注册、规则 CRUD、审批列表与回答。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MethodRegistry } from '../registry.js';
import { HookStore } from '../../hooks/store.js';
import { ApprovalBroker } from '../../hooks/approval.js';
import { HooksService } from '../../hooks/service.js';
import { registerHooksMethods } from './hooks.js';
import type { GatewayContext } from '@petd/protocol';

function harness(): {
  reg: MethodRegistry;
  store: HookStore;
  broker: ApprovalBroker;
  service: HooksService;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-hooksm-'));
  const store = new HookStore({ file: path.join(dir, 'state', 'hooks.json') });
  store.ensure();
  const broker = new ApprovalBroker({ publish: () => {}, timeoutMs: 500 });
  const service = new HooksService({
    store,
    approval: broker,
    publish: () => {},
    enabled: () => true,
    approvalEnabled: () => true,
  });
  const reg = new MethodRegistry();
  registerHooksMethods(reg, {
    store,
    approval: broker,
    service,
    config: () => ({ enabled: true, approvalEnabled: true, approvalTimeoutMs: 60_000 }),
  });
  return { reg, store, broker, service };
}

const ctx: GatewayContext = {
  sessionId: 's-test',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  const m = reg.requireMethod(name);
  return m.handler(params, ctx);
}

test('注册 9 个方法：hooks.* 7 + approval.* 2', () => {
  const { reg } = harness();
  const names = reg
    .names()
    .filter((n) => n.startsWith('hooks.') || n.startsWith('approval.'))
    .sort();
  assert.deepEqual(names, [
    'approval.answer',
    'approval.list',
    'hooks.create',
    'hooks.delete',
    'hooks.get',
    'hooks.list',
    'hooks.status',
    'hooks.toggle',
    'hooks.update',
  ]);
});

test('hooks.status / list / get 返回内置规则', async () => {
  const { reg } = harness();
  const status = (await invoke(reg, 'hooks.status')) as Record<string, unknown>;
  assert.equal(status['enabled'], true);
  assert.equal(status['approvalEnabled'], true);
  assert.ok((status['ruleCount'] as number) >= 9);
  assert.equal(status['pendingCount'], 0);

  const list = (await invoke(reg, 'hooks.list')) as { rules: Array<{ id: string }> };
  assert.ok(list.rules.some((r) => r.id === 'method-memory-delete'));

  const got = (await invoke(reg, 'hooks.get', { id: 'tool-file-delete' })) as { action: string };
  assert.equal(got.action, 'ask');
});

test('create / update / toggle / delete 全流程', async () => {
  const { reg } = harness();
  const created = (await invoke(reg, 'hooks.create', {
    id: 'deny-session-write',
    kind: 'method',
    names: ['memory.write'],
    action: 'deny',
    description: '禁止写记忆',
    priority: 1,
  })) as { id: string; action: string; priority: number };
  assert.equal(created.id, 'deny-session-write');
  assert.equal(created.action, 'deny');
  assert.equal(created.priority, 1);

  const updated = (await invoke(reg, 'hooks.update', {
    id: 'deny-session-write',
    action: 'ask',
    message: '现在需要确认',
  })) as { action: string; message: string; names: string[] };
  assert.equal(updated.action, 'ask');
  assert.equal(updated.message, '现在需要确认');
  assert.deepEqual(updated.names, ['memory.write']);

  const toggled = (await invoke(reg, 'hooks.toggle', { id: 'deny-session-write', enabled: false })) as { enabled: boolean };
  assert.equal(toggled.enabled, false);

  const del = (await invoke(reg, 'hooks.delete', { id: 'deny-session-write' })) as { deleted: boolean };
  assert.equal(del.deleted, true);
  const missing = (await invoke(reg, 'hooks.delete', { id: 'deny-session-write' })) as { deleted: boolean };
  assert.equal(missing.deleted, false);
});

test('approval.list / approval.answer：guard 发起审批后能列出来并回答', async () => {
  const { reg, store, broker, service } = harness();
  store.create({ id: 'ask-probe', kind: 'method', names: ['probe.x'], action: 'ask', priority: 1 });
  const guard = service.guard({ kind: 'method', name: 'probe.x', meta: { sessionId: 's-test' } });
  const pending = (await invoke(reg, 'approval.list')) as { pending: Array<{ id: string; ruleId: string; title: string }> };
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0]!.ruleId, 'ask-probe');
  const answered = (await invoke(reg, 'approval.answer', { id: pending.pending[0]!.id, accepted: true, remember: true })) as {
    found: boolean;
  };
  assert.equal(answered.found, true);
  const decision = await guard;
  assert.equal(decision.allowed, true);

  const again = (await invoke(reg, 'approval.answer', { id: pending.pending[0]!.id, accepted: true })) as { found: boolean };
  assert.equal(again.found, false);
  assert.equal(broker.count(), 0);
});
