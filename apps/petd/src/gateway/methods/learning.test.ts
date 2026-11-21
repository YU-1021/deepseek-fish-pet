/**
 * learning.* 方法：注册、范围/危险标记、状态/列表/详情、提案参数校验、批准/拒绝/回滚。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MethodRegistry } from '../registry.js';
import { LearningService } from '../../learning/service.js';
import { registerLearningMethods } from './learning.js';
import type { GatewayContext } from '@petd/protocol';
import type { PetdConfig } from '../../kernel/config.js';

const CONFIG: PetdConfig['learning'] = {
  enabled: true,
  requireApproval: true,
  grayPercent: 10,
  grayDays: 3,
  maxPending: 20,
  promptMaxChars: 2000,
};

const ctx: GatewayContext = {
  sessionId: 's-learning',
  client: { name: 'test', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
};

function harness(over: Partial<PetdConfig['learning']> = {}): { reg: MethodRegistry; learning: LearningService; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-learningm-'));
  const learning = new LearningService({ home, config: () => ({ ...CONFIG, ...over }) });
  learning.ensure();
  const reg = new MethodRegistry();
  registerLearningMethods(reg, { learning });
  return { reg, learning, home };
}

async function invoke(reg: MethodRegistry, name: string, params?: unknown): Promise<unknown> {
  return reg.requireMethod(name).handler(params, ctx);
}

test('注册 7 个 learning.* 方法；approve/rollback 标危险、不幂等', () => {
  const { reg } = harness();
  const names = reg.names().filter((n) => n.startsWith('learning.')).sort();
  assert.deepEqual(names, [
    'learning.approve',
    'learning.get',
    'learning.list',
    'learning.propose',
    'learning.reject',
    'learning.rollback',
    'learning.status',
  ]);
  assert.equal(reg.scopeOf('learning.status'), 'read');
  assert.equal(reg.scopeOf('learning.list'), 'read');
  assert.equal(reg.scopeOf('learning.get'), 'read');
  assert.equal(reg.scopeOf('learning.propose'), 'write');
  assert.equal(reg.scopeOf('learning.approve'), 'write');
  assert.equal(reg.scopeOf('learning.reject'), 'write');
  assert.equal(reg.scopeOf('learning.rollback'), 'write');
  assert.equal(reg.requireMethod('learning.approve').descriptor.dangerous, true);
  assert.equal(reg.requireMethod('learning.approve').descriptor.idempotent, false);
  assert.equal(reg.requireMethod('learning.rollback').descriptor.dangerous, true);
});

test('learning.status：开关、计数、待审、目录', async () => {
  const { reg, home } = harness();
  const status = (await invoke(reg, 'learning.status')) as Record<string, unknown>;
  assert.equal(status['enabled'], true);
  assert.equal(status['requireApproval'], true);
  assert.deepEqual((status['counts'] as Record<string, number>)['pending'], 0);
  assert.deepEqual(status['dirs'], {
    proposals: path.join(home, 'proposals'),
    staging: path.join(home, 'skills', 'staging'),
    approved: path.join(home, 'learning'),
  });
});

test('learning.propose → list/get：写入候选并回读正文', async () => {
  const { reg } = harness();
  const proposed = (await invoke(reg, 'learning.propose', {
    kind: 'preference',
    name: 'reply_style',
    content: '回答尽量短一点。',
    reason: '主人喜欢简短',
  })) as { item: Record<string, unknown> };
  const id = String(proposed.item['id']);
  assert.equal(proposed.item['status'], 'pending');

  const list = (await invoke(reg, 'learning.list', { status: 'pending' })) as { items: Array<Record<string, unknown>> };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]?.['id'], id);

  const got = (await invoke(reg, 'learning.get', { id })) as { item: Record<string, unknown> };
  assert.equal(got.item['body'], '回答尽量短一点。');
  assert.equal(got.item['path'], path.posix.join('proposals', `${id}.agent.md`));
});

test('learning.propose 参数校验：缺 kind/name/content/reason 都报错', async () => {
  const { reg } = harness();
  await assert.rejects(invoke(reg, 'learning.propose', { kind: 'nope', name: 'a', content: 'b', reason: 'c' }));
  await assert.rejects(invoke(reg, 'learning.propose', { kind: 'preference', content: 'b', reason: 'c' }));
  await assert.rejects(invoke(reg, 'learning.propose', { kind: 'preference', name: 'a', reason: 'c' }));
  await assert.rejects(invoke(reg, 'learning.propose', { kind: 'preference', name: 'a', content: 'b' }));
  await assert.rejects(invoke(reg, 'learning.propose', { kind: 'preference', name: 'a', content: '', reason: 'c' }));
});

test('learning.approve：批准后状态变化；rollback 后回到 rolledback', async () => {
  const { reg } = harness();
  const proposed = (await invoke(reg, 'learning.propose', {
    kind: 'preference',
    name: 'language',
    content: '用中文回答。',
    reason: '主人用中文',
  })) as { item: Record<string, unknown> };
  const id = String(proposed.item['id']);

  const approved = (await invoke(reg, 'learning.approve', { id })) as { item: Record<string, unknown> };
  assert.equal(approved.item['status'], 'approved');

  const rolled = (await invoke(reg, 'learning.rollback', { id })) as { item: Record<string, unknown> };
  assert.equal(rolled.item['status'], 'rolledback');
});

test('learning.reject：状态改 rejected 且文件保留', async () => {
  const { reg, home } = harness();
  const proposed = (await invoke(reg, 'learning.propose', {
    kind: 'prompt',
    name: 'style',
    content: '多用语气词。',
    reason: 'r',
  })) as { item: Record<string, unknown> };
  const id = String(proposed.item['id']);
  const rejected = (await invoke(reg, 'learning.reject', { id, reason: '不需要' })) as { item: Record<string, unknown> };
  assert.equal(rejected.item['status'], 'rejected');
  assert.equal(fs.existsSync(path.join(home, 'proposals', `${id}.agent.md`)), true);
});
