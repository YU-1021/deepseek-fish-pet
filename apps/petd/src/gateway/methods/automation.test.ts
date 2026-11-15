/**
 * automation.* 方法测试：注册、开关、创建/修改/暂停/恢复/删除、手动运行与运行记录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { AutomationStore } from '../../automation/store.js';
import { registerAutomationMethods } from './automation.js';

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
  store: AutomationStore;
  enabled: { value: boolean };
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-automation-methods-'));
  const enabled = { value: true };
  const store = new AutomationStore({
    file: path.join(dir, 'automations.json'),
    armTimers: false,
    enabled: () => enabled.value,
    runJob: async () => ({ output: '跑完啦', usage: { promptTokens: 30, completionTokens: 8 } }),
  });
  store.ensure();
  const reg = new MethodRegistry();
  registerAutomationMethods(reg, { store, enabled: () => enabled.value });
  return { reg, store, enabled };
}

async function call(h: Harness, name: string, params: unknown): Promise<unknown> {
  const m = h.reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx());
}

test('注册 10 个 automation.* 方法', () => {
  const h = harness();
  assert.deepEqual(
    h.reg.names().filter((n) => n.startsWith('automation.')),
    [
      'automation.create',
      'automation.delete',
      'automation.get',
      'automation.list',
      'automation.pause',
      'automation.resume',
      'automation.run',
      'automation.runs',
      'automation.status',
      'automation.update',
    ]
  );
  const run = h.reg.get('automation.run');
  assert.ok(run);
  assert.equal(run.descriptor.scope, 'write');
  assert.equal(run.descriptor.idempotent, false);
  assert.equal(run.descriptor.timeoutMs, 240_000);
});

test('status / create / list / get 全流程', async () => {
  const h = harness();
  const s0 = (await call(h, 'automation.status', {})) as { enabled: boolean; jobs: number };
  assert.equal(s0.enabled, true);
  assert.equal(s0.jobs, 0);

  const job = (await call(h, 'automation.create', {
    name: '每日总结',
    prompt: '总结今天的聊天',
    schedule: { kind: 'interval', everyMinutes: 60 },
  })) as { id: string; name: string; scheduleText: string; nextRunAt: number | null };
  assert.equal(job.name, '每日总结');
  assert.equal(job.scheduleText, '每 60 分钟');
  assert.ok(job.nextRunAt);

  const list = (await call(h, 'automation.list', {})) as { jobs: Array<{ id: string }> };
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0]?.id, job.id);

  const got = (await call(h, 'automation.get', { id: job.id })) as { id: string; prompt: string };
  assert.equal(got.prompt, '总结今天的聊天');

  const s1 = (await call(h, 'automation.status', {})) as { jobs: number; enabledJobs: number };
  assert.equal(s1.jobs, 1);
  assert.equal(s1.enabledJobs, 1);
});

test('update / pause / resume / delete 全流程', async () => {
  const h = harness();
  const job = (await call(h, 'automation.create', {
    prompt: '看天气',
    schedule: { kind: 'manual' },
  })) as { id: string };

  const updated = (await call(h, 'automation.update', {
    id: job.id,
    name: '看天气并提醒带伞',
    schedule: { kind: 'interval', everyMinutes: 15 },
  })) as { name: string; scheduleText: string };
  assert.equal(updated.name, '看天气并提醒带伞');
  assert.equal(updated.scheduleText, '每 15 分钟');

  const paused = (await call(h, 'automation.pause', { id: job.id })) as { enabled: boolean; nextRunAt: null };
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);

  const resumed = (await call(h, 'automation.resume', { id: job.id })) as { enabled: boolean };
  assert.equal(resumed.enabled, true);

  const deleted = (await call(h, 'automation.delete', { id: job.id })) as { deleted: boolean };
  assert.equal(deleted.deleted, true);
  const list = (await call(h, 'automation.list', {})) as { jobs: unknown[] };
  assert.equal(list.jobs.length, 0);
});

test('开关关闭时：写方法 E_UNAVAILABLE，读方法仍可用', async () => {
  const h = harness();
  const job = (await call(h, 'automation.create', {
    prompt: '先建一个',
    schedule: { kind: 'manual' },
  })) as { id: string };
  h.enabled.value = false;

  await assert.rejects(
    () => call(h, 'automation.create', { prompt: '关着的时候建', schedule: { kind: 'manual' } }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  await assert.rejects(
    () => call(h, 'automation.run', { id: job.id }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );

  const status = (await call(h, 'automation.status', {})) as { enabled: boolean };
  assert.equal(status.enabled, false);
  const list = (await call(h, 'automation.list', {})) as { jobs: unknown[] };
  assert.equal(list.jobs.length, 1);
});

test('参数校验：缺 schedule、空 prompt、非法时间、未知 id', async () => {
  const h = harness();
  await assert.rejects(
    () => call(h, 'automation.create', { prompt: '没有计划' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'automation.create', { prompt: '   ', schedule: { kind: 'manual' } }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'automation.create', { prompt: '坏时间', schedule: { kind: 'daily', atClock: '25:99' } }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(h, 'automation.get', { id: 'nope' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});

test('手动运行：automation.run 返回成功记录，automation.runs 能查到', async () => {
  const h = harness();
  const job = (await call(h, 'automation.create', {
    prompt: '手动跑的任务',
    schedule: { kind: 'manual' },
  })) as { id: string };

  const run = (await call(h, 'automation.run', { id: job.id })) as {
    status: string;
    startedBy: string;
    output: string | null;
    usage: { promptTokens?: number } | null;
  };
  assert.equal(run.status, 'succeeded');
  assert.equal(run.startedBy, 'manual');
  assert.equal(run.output, '跑完啦');
  assert.equal(run.usage?.promptTokens, 30);

  const runs = (await call(h, 'automation.runs', { id: job.id })) as {
    runs: Array<{ id: string; status: string }>;
  };
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]?.status, 'succeeded');

  const all = (await call(h, 'automation.runs', { limit: 10 })) as { runs: unknown[] };
  assert.equal(all.runs.length, 1);
});
