/**
 * ApprovalBroker 测试：提问/回答/超时/取消与事件载荷。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from './approval.js';

interface Ev {
  event: string;
  data: Record<string, unknown>;
}

function makeBroker(timeoutMs = 1000): { broker: ApprovalBroker; events: Ev[] } {
  const events: Ev[] = [];
  const broker = new ApprovalBroker({
    publish: (event, data) => events.push({ event, data: (data ?? {}) as Record<string, unknown> }),
    timeoutMs,
  });
  return { broker, events };
}

test('ask 广播 approval.requested；answer 接受后 resolve 并广播 resolved', async () => {
  const { broker, events } = makeBroker();
  const promise = broker.ask({ kind: 'method', name: 'memory.delete', ruleId: 'r1', title: '删记忆？', detail: '会丢' });
  const requested = events.find((e) => e.event === 'approval.requested');
  assert.ok(requested);
  const id = requested.data['id'] as string;
  assert.match(id, /^ap-/);
  assert.equal(requested.data['ruleId'], 'r1');
  assert.ok(typeof requested.data['deadlineAt'] === 'number');

  assert.equal(broker.pendingApprovals().length, 1);
  assert.equal(broker.answer(id, true, true), true);
  const outcome = await promise;
  assert.deepEqual(outcome, { accepted: true, reason: 'answered', remembered: true });
  const resolved = events.find((e) => e.event === 'approval.resolved');
  assert.ok(resolved);
  assert.equal(resolved.data['accepted'], true);
  assert.equal(resolved.data['remember'], true);
  assert.equal(broker.answer(id, true), false, '同一个审批不能回答两次');
});

test('拒绝：answer(false)', async () => {
  const { broker } = makeBroker();
  const promise = broker.ask({ kind: 'tool', name: 'delete_file', ruleId: 'r2', title: '删文件？' });
  const pending = broker.pendingApprovals();
  assert.equal(pending.length, 1);
  broker.answer(pending[0]!.id, false);
  assert.deepEqual(await promise, { accepted: false, reason: 'answered', remembered: false });
});

test('超时无人回答：按拒绝 resolve，pending 清空', async () => {
  const { broker, events } = makeBroker(40);
  const outcome = await broker.ask({ kind: 'method', name: 'session.delete', ruleId: 'r3', title: '删会话？' });
  assert.deepEqual(outcome, { accepted: false, reason: 'timeout', remembered: false });
  assert.equal(broker.count(), 0);
  const resolved = events.filter((e) => e.event === 'approval.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.data['reason'], 'timeout');
});

test('cancelAll：退出时全部按 cancelled 拒绝', async () => {
  const { broker } = makeBroker(5000);
  const a = broker.ask({ kind: 'method', name: 'memory.delete', ruleId: 'r1', title: 'A' });
  const b = broker.ask({ kind: 'method', name: 'memory.delete', ruleId: 'r1', title: 'B' });
  assert.equal(broker.count(), 2);
  broker.cancelAll();
  assert.deepEqual(await a, { accepted: false, reason: 'cancelled', remembered: false });
  assert.deepEqual(await b, { accepted: false, reason: 'cancelled', remembered: false });
  assert.equal(broker.count(), 0);
});
