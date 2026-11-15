/**
 * HooksService 测试：开关、放行、拒绝、审批（允许/拒绝/记住/超时）、会话隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookStore } from './store.js';
import { ApprovalBroker } from './approval.js';
import { HooksService } from './service.js';

interface Setup {
  store: HookStore;
  broker: ApprovalBroker;
  service: HooksService;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  setEnabled(v: boolean): void;
  setApprovalEnabled(v: boolean): void;
}

function setup(opts: { enabled?: boolean; approvalEnabled?: boolean; timeoutMs?: number } = {}): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-hooksvc-'));
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const publish = (event: string, data?: unknown): void => {
    events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  };
  let enabled = opts.enabled ?? true;
  let approvalEnabled = opts.approvalEnabled ?? true;
  const store = new HookStore({ file: path.join(dir, 'state', 'hooks.json') });
  store.ensure();
  const broker = new ApprovalBroker({ publish, timeoutMs: opts.timeoutMs ?? 500 });
  const service = new HooksService({
    store,
    approval: broker,
    publish,
    enabled: () => enabled,
    approvalEnabled: () => approvalEnabled,
  });
  return {
    store,
    broker,
    service,
    events,
    setEnabled: (v) => {
      enabled = v;
    },
    setApprovalEnabled: (v) => {
      approvalEnabled = v;
    },
  };
}

test('hooks 关闭或没有规则命中：直接放行', async () => {
  const a = setup({ enabled: false });
  const d1 = await a.service.guard({ kind: 'method', name: 'memory.delete' });
  assert.equal(d1.allowed, true);
  assert.equal(a.events.length, 0, '关闭时不广播');
  const b = setup();
  const d2 = await b.service.guard({ kind: 'tool', name: 'read_file' });
  assert.equal(d2.allowed, true);
  assert.equal(b.broker.count(), 0);
});

test('deny 规则：直接拒绝并广播 hooks.blocked', async () => {
  const s = setup();
  s.store.create({ id: 'deny-x', kind: 'method', names: ['test.deny'], action: 'deny', message: '这个操作被禁止了', priority: 1 });
  const d = await s.service.guard({ kind: 'method', name: 'test.deny' });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /这个操作被禁止了/);
  const blocked = s.events.find((e) => e.event === 'hooks.blocked');
  assert.ok(blocked);
  assert.equal(blocked.data['action'], 'deny');
  assert.equal(s.broker.count(), 0);
});

test('内置 ask 规则：问到用户，允许后放行；记住后不再问', async () => {
  const s = setup();
  const pending = s.service.guard({ kind: 'method', name: 'memory.delete', meta: { sessionId: 's1' } });
  const id = s.broker.pendingApprovals()[0]?.id;
  assert.ok(id, '应该生成待答审批');
  assert.equal(s.broker.answer(id!, true, true), true);
  const d = await pending;
  assert.equal(d.allowed, true);
  assert.equal(d.ruleId, 'method-memory-delete');
  assert.equal(d.approved, true);

  const again = await s.service.guard({ kind: 'method', name: 'memory.delete', meta: { sessionId: 's1' } });
  assert.equal(again.allowed, true);
  assert.equal(s.broker.count(), 0, '记住后不应再产生审批');
});

test('拒绝：返回 not allowed，原因说明用户拒绝', async () => {
  const s = setup();
  const pending = s.service.guard({ kind: 'method', name: 'session.delete' });
  const id = s.broker.pendingApprovals()[0]?.id;
  assert.ok(id);
  s.broker.answer(id!, false);
  const d = await pending;
  assert.equal(d.allowed, false);
  assert.match(d.reason, /你拒绝了这次操作/);
});

test('审批门关闭：ask 规则按拒绝处理，且不产生审批', async () => {
  const s = setup({ approvalEnabled: false });
  const d = await s.service.guard({ kind: 'method', name: 'memory.delete' });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /审批门已关闭/);
  assert.equal(s.broker.count(), 0);
});

test('审批超时：按拒绝处理', async () => {
  const s = setup({ timeoutMs: 30 });
  const d = await s.service.guard({ kind: 'tool', name: 'delete_file' });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /等待确认超时/);
});

test('会话隔离 + clearSessionAllows：记住只对本连接生效', async () => {
  const s = setup();
  const first = s.service.guard({ kind: 'method', name: 'memory.delete', meta: { sessionId: 's1' } });
  s.broker.answer(s.broker.pendingApprovals()[0]!.id, true, true);
  await first;

  const other = s.service.guard({ kind: 'method', name: 'memory.delete', meta: { sessionId: 's2' } });
  assert.equal(s.broker.count(), 1, '另一个连接应该重新问');
  s.broker.answer(s.broker.pendingApprovals()[0]!.id, true, true);
  await other;

  assert.equal(s.service.sessionAllowedCount(), 2);
  s.service.clearSessionAllows();
  assert.equal(s.service.sessionAllowedCount(), 0);
});

test('status 汇报开关/规则数/本次允许数/待答数', async () => {
  const s = setup();
  s.store.create({ id: 'x', kind: 'method', names: ['a.b'], action: 'deny' });
  const st = s.service.status();
  assert.equal(st.enabled, true);
  assert.equal(st.approvalEnabled, true);
  assert.ok(st.ruleCount >= 10);
  assert.equal(st.sessionAllowedCount, 0);
  assert.equal(st.pendingCount, 0);
});
