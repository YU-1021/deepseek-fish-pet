/**
 * agent.* 自我迭代审计方法：注册、范围、列表/详情、回滚与事件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MethodRegistry } from '../registry.js';
import { AgentAuditLog } from '../../kernel/agent-audit.js';
import { registerAgentMethods } from './agent.js';
import type { GatewayContext } from '@petd/protocol';

function harness(): {
  reg: MethodRegistry;
  audit: AgentAuditLog;
  home: string;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-agentm-'));
  const audit = new AgentAuditLog({ home, now: () => '2025-01-01T00:00:00.000Z' });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reg = new MethodRegistry();
  registerAgentMethods(reg, { audit, publish: (event, data) => events.push({ event, data: data as Record<string, unknown> }) });
  return { reg, audit, home, events };
}

const ctx: GatewayContext = {
  sessionId: 's-agent',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  return reg.requireMethod(name).handler(params, ctx);
}

function writeSoul(home: string, content: string): string {
  const abs = path.join(home, 'SOUL.agent.md');
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('注册 4 个 agent.* 方法；rollback 写且标危险', () => {
  const { reg } = harness();
  const names = reg.names().filter((n) => n.startsWith('agent.')).sort();
  assert.deepEqual(names, ['agent.audit.get', 'agent.audit.list', 'agent.rollback', 'agent.scope']);
  assert.equal(reg.scopeOf('agent.scope'), 'read');
  assert.equal(reg.scopeOf('agent.audit.list'), 'read');
  assert.equal(reg.scopeOf('agent.audit.get'), 'read');
  assert.equal(reg.scopeOf('agent.rollback'), 'write');
  assert.equal(reg.requireMethod('agent.rollback').descriptor.dangerous, true);
  assert.equal(reg.requireMethod('agent.rollback').descriptor.idempotent, false);
});

test('agent.scope：返回后缀约定、可写目录与审计文件', async () => {
  const { reg, home } = harness();
  const scope = (await invoke(reg, 'agent.scope')) as Record<string, unknown>;
  assert.match(String(scope['scope']), /\.agent/);
  assert.equal(scope['memoryZone'], 'workspace');
  assert.deepEqual(scope['zones'], ['SOUL.agent.md', 'learning', 'proposals', 'skills/staging']);
  assert.equal(scope['auditFile'], path.join(home, 'state', 'agent-audit.jsonl'));
});

test('audit.list/audit.get：列表不带正文，详情带 diff', async () => {
  const { reg, home, audit } = harness();
  const abs = writeSoul(home, '新');
  const meta = audit.append({ path: abs, actor: 'agent', action: 'write', reason: '演化', beforeText: '旧', afterText: '新' });
  const list = (await invoke(reg, 'agent.audit.list', { limit: 10 })) as { entries: Array<Record<string, unknown>>; total: number };
  assert.equal(list.total, 1);
  assert.equal(list.entries[0]?.['id'], meta.id);
  assert.equal((list.entries[0]?.['before'] as Record<string, unknown>)['text'], undefined);
  const got = (await invoke(reg, 'agent.audit.get', { id: meta.id })) as { entry: Record<string, unknown> };
  assert.match(String(got.entry['diff']), /\+新/);
  await assert.rejects(invoke(reg, 'agent.audit.get', { id: 'missing' }), /没有这条审计记录/);
});

test('agent.rollback：恢复内容并广播 agent.rollback', async () => {
  const { reg, home, audit, events } = harness();
  const abs = writeSoul(home, '旧');
  const meta = audit.append({ path: abs, actor: 'agent', action: 'write', beforeText: '旧', afterText: '新' });
  fs.writeFileSync(abs, '新');
  const r = (await invoke(reg, 'agent.rollback', { id: meta.id })) as Record<string, unknown>;
  assert.equal(r['restored'], 'content');
  assert.equal(r['path'], 'SOUL.agent.md');
  assert.equal(fs.readFileSync(abs, 'utf8'), '旧');
  assert.equal(events.filter((e) => e.event === 'agent.rollback').length, 1);
  assert.equal(events[0]?.data['path'], 'SOUL.agent.md');
  assert.equal(audit.list().total, 2);
});
