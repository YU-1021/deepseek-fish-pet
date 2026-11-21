/**
 * 智能审批门（smart 模式）测试：
 * 只评敏感操作、低/中风险自动放行、高风险弹审批、规则优先、记住本次。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookStore } from './store.js';
import { ApprovalBroker } from './approval.js';
import { HooksService } from './service.js';
import type { HookContext } from './types.js';
import type { RiskLevel, RiskVerdict } from './risk.js';

interface Harness {
  service: HooksService;
  broker: ApprovalBroker;
  store: HookStore;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  riskCalls: HookContext[];
  setLevel(v: RiskLevel): void;
  setMode(v: 'rules' | 'smart'): void;
  setApprovalEnabled(v: boolean): void;
}

function harness(level: RiskLevel = 'low'): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-smart-'));
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const riskCalls: HookContext[] = [];
  const publish = (event: string, data?: unknown): void => {
    events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  };
  let current: RiskLevel = level;
  let mode: 'rules' | 'smart' = 'smart';
  let approvalEnabled = true;
  const store = new HookStore({ file: path.join(dir, 'state', 'hooks.json') });
  store.ensure();
  const broker = new ApprovalBroker({ publish, timeoutMs: 500 });
  const risk = {
    async assess(ctx: HookContext): Promise<RiskVerdict> {
      riskCalls.push(ctx);
      return { level: current, reason: `测试给出的${current}风险`, cached: false, fallback: false };
    },
  };
  const service = new HooksService({
    store,
    approval: broker,
    publish,
    enabled: () => true,
    mode: () => mode,
    approvalEnabled: () => approvalEnabled,
    risk,
  });
  return {
    service,
    broker,
    store,
    events,
    riskCalls,
    setLevel: (v) => {
      current = v;
    },
    setMode: (v) => {
      mode = v;
    },
    setApprovalEnabled: (v) => {
      approvalEnabled = v;
    },
  };
}

const meta = { sessionId: 's-smart' };

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('smart：只读方法与非敏感工具直接放行，不调模型', async () => {
  const h = harness();
  const d1 = await h.service.guard({ kind: 'method', name: 'memory.read', scope: 'read', meta });
  assert.equal(d1.allowed, true);
  const d2 = await h.service.guard({ kind: 'tool', name: 'read_file', meta });
  assert.equal(d2.allowed, true);
  assert.equal(h.riskCalls.length, 0);
  assert.equal(h.events.filter((e) => e.event === 'hooks.assessed').length, 0);
});

test('smart：敏感工具低/中风险自动放行并广播 hooks.assessed', async () => {
  for (const level of ['low', 'medium'] as const) {
    const h = harness(level);
    const d = await h.service.guard({ kind: 'tool', name: 'write_file', args: { path: 'a.md' }, meta });
    assert.equal(d.allowed, true, level);
    assert.equal(h.riskCalls.length, 1);
    const assessed = h.events.find((e) => e.event === 'hooks.assessed');
    assert.ok(assessed);
    assert.equal(assessed.data['risk'], level);
    assert.equal(assessed.data['name'], 'write_file');
    assert.equal(h.broker.count(), 0);
  }
});

test('smart：高风险弹审批，允许后放行且事件带风险信息', async () => {
  const h = harness('high');
  // 用一个没有内置规则的写方法，才会走智能风险评审（内置 ask 规则优先）
  const pending = h.service.guard({ kind: 'method', name: 'config.save', scope: 'write', meta });
  await waitFor(() => h.broker.count() > 0);
  const req = h.events.find((e) => e.event === 'approval.requested');
  assert.ok(req);
  assert.equal(req.data['risk'], 'high');
  assert.match(String(req.data['riskReason']), /high/);
  const id = h.broker.pendingApprovals()[0]?.id;
  assert.ok(id);
  h.broker.answer(id, true);
  const d = await pending;
  assert.equal(d.allowed, true);
  assert.equal(d.approved, true);
  assert.equal(d.risk, 'high');
});

test('smart：高风险拒绝 → 不执行并给出拒绝文案', async () => {
  const h = harness('high');
  const pending = h.service.guard({ kind: 'tool', name: 'delete_file', args: { path: 'x' }, meta });
  const id = h.broker.pendingApprovals()[0]?.id;
  assert.ok(id);
  h.broker.answer(id, false);
  const d = await pending;
  assert.equal(d.allowed, false);
  assert.match(d.reason, /你拒绝了这次操作/);
  const blocked = h.events.find((e) => e.event === 'hooks.blocked');
  assert.ok(blocked);
});

test('smart：规则 deny/allow 优先，不再调模型', async () => {
  const h = harness('high');
  h.store.create({ id: 'deny-writes', kind: 'tool', names: ['write_file'], action: 'deny', message: '禁止写文件', priority: 1 });
  const d = await h.service.guard({ kind: 'tool', name: 'write_file', meta });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /禁止写文件/);
  assert.equal(h.riskCalls.length, 0);

  h.store.create({ id: 'allow-del', kind: 'method', names: ['memory.delete'], action: 'allow', priority: 1 });
  const d2 = await h.service.guard({ kind: 'method', name: 'memory.delete', scope: 'write', meta });
  assert.equal(d2.allowed, true);
  assert.equal(h.riskCalls.length, 0);
});

test('smart：审批门关闭时高风险直接拒绝（不挂起）', async () => {
  const h = harness('high');
  h.setApprovalEnabled(false);
  const d = await h.service.guard({ kind: 'tool', name: 'move_file', meta });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /审批门已关闭/);
});

test('smart：记住本次后同一连接不再问', async () => {
  const h = harness('high');
  const first = h.service.guard({ kind: 'tool', name: 'delete_file', args: { path: 'a' }, meta });
  const id = h.broker.pendingApprovals()[0]?.id;
  assert.ok(id);
  h.broker.answer(id, true, true);
  assert.equal((await first).allowed, true);
  const second = await h.service.guard({ kind: 'tool', name: 'delete_file', args: { path: 'a' }, meta });
  assert.equal(second.allowed, true);
  assert.equal(h.broker.count(), 0);
});

test('status 带 mode 与风险评审状态', () => {
  const h = harness();
  const st = h.service.status();
  assert.equal(st.mode, 'smart');
  assert.equal(st.riskEnabled, true);
  h.setMode('rules');
  assert.equal(h.service.status().mode, 'rules');
});
