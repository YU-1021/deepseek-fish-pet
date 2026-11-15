/**
 * 自动化存储测试：时间排期、增删改查、手动/定时运行、补跑跳过、一次性结束、持久化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { AutomationStore, computeNextRun, validateScheduleInput } from './store.js';
import type { AutomationRunOutput, AutomationSchedule } from './store.js';

const BASE_NOW = Date.parse('2026-11-15T10:00:00+08:00');

interface Harness {
  dir: string;
  file: string;
  now: { value: number };
  events: Array<{ event: string; data: unknown }>;
  store: AutomationStore;
  open: (overrides?: Record<string, unknown>) => AutomationStore;
}

interface HarnessOptions {
  enabled?: () => boolean;
  maxJobs?: number;
  maxRunsKept?: number;
  catchUpMinutes?: number;
  runJob?: (job: { id: string; prompt: string }, signal: AbortSignal) => Promise<AutomationRunOutput>;
}

function harness(opts: HarnessOptions = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-automation-'));
  const file = path.join(dir, 'automations.json');
  const now = { value: BASE_NOW };
  const events: Array<{ event: string; data: unknown }> = [];
  const make = (): AutomationStore =>
    new AutomationStore({
      file,
      now: () => now.value,
      publish: (event, data) => events.push({ event, data }),
      armTimers: false,
      enabled: opts.enabled ?? (() => true),
      runTimeoutMs: 60_000,
      ...(opts.maxJobs === undefined ? {} : { maxJobs: opts.maxJobs }),
      ...(opts.maxRunsKept === undefined ? {} : { maxRunsKept: opts.maxRunsKept }),
      ...(opts.catchUpMinutes === undefined ? {} : { catchUpMinutes: opts.catchUpMinutes }),
      runJob: opts.runJob ?? (async () => ({ output: '好的，我办完了。' })),
    });
  const store = make();
  store.ensure();
  return { dir, file, now, events, store, open: () => make() };
}

function scheduleOf(s: AutomationSchedule): AutomationSchedule {
  return s;
}

test('computeNextRun：interval / daily（今天或明天）/ once / manual', () => {
  const now = BASE_NOW;
  assert.equal(computeNextRun({ kind: 'interval', everyMinutes: 30 }, now, now), now + 30 * 60_000);

  const at1830 = new Date(now);
  at1830.setHours(18, 30, 0, 0);
  assert.equal(computeNextRun({ kind: 'daily', atClock: '18:30' }, now, now), at1830.getTime());

  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  assert.equal(computeNextRun({ kind: 'daily', atClock: '9:00' }, now, now), tomorrow9.getTime());

  assert.equal(computeNextRun({ kind: 'once', at: now + 60_000 }, now, now), now + 60_000);
  assert.equal(computeNextRun({ kind: 'once', at: now - 1 }, now, now), null);
  assert.equal(computeNextRun({ kind: 'manual' }, now, now), null);
});

test('validateScheduleInput：合法四种 + 非法输入', () => {
  const now = BASE_NOW;
  assert.deepEqual(validateScheduleInput({ kind: 'manual' }, now), { kind: 'manual' });
  assert.deepEqual(validateScheduleInput({ kind: 'interval', everyMinutes: 15 }, now), {
    kind: 'interval',
    everyMinutes: 15,
  });
  assert.deepEqual(validateScheduleInput({ kind: 'daily', atClock: '08:05' }, now), {
    kind: 'daily',
    atClock: '08:05',
  });
  const onceAt = now + 90_000;
  assert.deepEqual(validateScheduleInput({ kind: 'once', at: onceAt }, now), { kind: 'once', at: onceAt });

  assert.throws(() => validateScheduleInput({ kind: 'interval', everyMinutes: 0 }, now), /1–/);
  assert.throws(() => validateScheduleInput({ kind: 'daily', atClock: '25:00' }, now), /时间不合法/);
  assert.throws(() => validateScheduleInput({ kind: 'daily', atClock: 'nope' }, now), /atClock/);
  assert.throws(() => validateScheduleInput({ kind: 'once', at: now - 10_000 }, now), /已经过去/);
  assert.throws(() => validateScheduleInput({ kind: 'weekly' }, now), /schedule.kind/);
  assert.throws(() => validateScheduleInput('x', now), /必须是对象/);
});

test('create / list / update / pause / resume / delete 与事件', () => {
  const h = harness();
  const created = h.store.create({
    name: '每日总结',
    prompt: '总结一下今天的聊天',
    schedule: scheduleOf({ kind: 'interval', everyMinutes: 60 }),
  });
  assert.equal(created.id, 'a1');
  assert.equal(created.name, '每日总结');
  assert.equal(created.scheduleText, '每 60 分钟');
  assert.equal(created.enabled, true);
  assert.equal(created.nextRunAt, BASE_NOW + 3_600_000);
  assert.equal(created.nextInMinutes, 60);

  const manualJob = h.store.create({ prompt: '手动任务', schedule: { kind: 'manual' } });
  assert.equal(manualJob.nextRunAt, null);
  assert.equal(h.store.listJobs().length, 2);
  assert.equal(h.store.listJobs()[0]?.id, 'a1', '按 nextRunAt 排序，manual 排最后');

  const updated = h.store.update('a1', { name: '早间总结', prompt: '总结早上的聊天', enabled: false });
  assert.equal(updated.name, '早间总结');
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, null);

  const resumed = h.store.resume('a1');
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.nextRunAt, BASE_NOW + 3_600_000);

  const paused = h.store.pause('a1');
  assert.equal(paused.enabled, false);

  h.store.delete('a1');
  assert.equal(h.store.getJob('a1'), null);
  assert.equal(h.store.listJobs().length, 1);

  const names = h.events.map((e) => e.event);
  assert.ok(names.includes('automation.job.created'));
  assert.ok(names.includes('automation.job.updated'));
  assert.ok(names.includes('automation.job.deleted'));

  assert.throws(() => h.store.getJob('nope') === null ? h.store.delete('nope') : undefined, (e) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
});

test('maxJobs：超过上限拒绝新建', () => {
  const h = harness({ maxJobs: 2 });
  h.store.create({ prompt: '一', schedule: { kind: 'manual' } });
  h.store.create({ prompt: '二', schedule: { kind: 'manual' } });
  assert.throws(
    () => h.store.create({ prompt: '三', schedule: { kind: 'manual' } }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  assert.throws(() => h.store.create({ prompt: '   ', schedule: { kind: 'manual' } }), /不能为空/);
});

test('runNow 成功：运行记录、事件、回写 sessionId，且不改变下次定时', () => {
  const h = harness({
    runJob: async () => ({ output: '今天有三件事要办。', sessionId: 's-abc', usage: { promptTokens: 100, completionTokens: 20 } }),
  });
  const job = h.store.create({ prompt: '看看今天要做什么', schedule: { kind: 'interval', everyMinutes: 60 } });
  const before = job.nextRunAt;
  return h.store.runNow('a1').then((run) => {
    assert.equal(run.status, 'succeeded');
    assert.equal(run.startedBy, 'manual');
    assert.equal(run.output, '今天有三件事要办。');
    assert.equal(run.usage?.promptTokens, 100);
    const after = h.store.getJob('a1');
    assert.equal(after?.runCount, 1);
    assert.equal(after?.lastStatus, 'succeeded');
    assert.equal(after?.sessionId, 's-abc');
    assert.equal(after?.nextRunAt, before, '手动运行不动定时');
    const names = h.events.map((e) => e.event);
    assert.ok(names.includes('automation.run.started'));
    assert.ok(names.includes('automation.run.succeeded'));
  });
});

test('runNow 失败：记 failed + 错误信息，不崩', async () => {
  const h = harness({
    runJob: async () => {
      throw new Error('模型超时了');
    },
  });
  h.store.create({ prompt: '会失败的任务', schedule: { kind: 'manual' } });
  const run = await h.store.runNow('a1');
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /模型超时了/);
  assert.equal(h.store.getJob('a1')?.lastStatus, 'failed');
  assert.equal(h.store.status().jobs, 1);
});

test('tick：到点执行并排下一次（schedule 来源）', async () => {
  const h = harness();
  h.store.create({ prompt: '每小时看看', schedule: { kind: 'interval', everyMinutes: 1 } });
  h.now.value += 61_000;
  const started = await h.store.tick();
  assert.equal(started.length, 1);
  assert.equal(started[0]?.startedBy, 'schedule');
  assert.equal(started[0]?.status, 'succeeded');
  assert.equal(h.store.getJob('a1')?.runCount, 1);
  const next = h.store.getJob('a1')?.nextRunAt ?? 0;
  assert.ok(next > h.now.value, '下一次在未来');
});

test('tick：错过太久只记 skipped、不补跑', async () => {
  const h = harness({ catchUpMinutes: 15 });
  h.store.create({ prompt: '补跑测试', schedule: { kind: 'interval', everyMinutes: 1 } });
  h.now.value += 60 * 60_000; // 晚了一小时，远超 15 分钟补跑窗口
  const started = await h.store.tick();
  assert.equal(started.length, 0);
  const skipped = h.events.filter((e) => e.event === 'automation.skipped');
  assert.equal(skipped.length, 1);
  assert.equal(h.store.listRuns().length, 0);
  assert.ok((h.store.getJob('a1')?.nextRunAt ?? 0) > h.now.value);
});

test('once：跑完自动结束（enabled=false / nextRunAt=null）', async () => {
  const h = harness();
  const created = h.store.create({ prompt: '一次性提醒任务', schedule: { kind: 'once', at: BASE_NOW + 60_000 } });
  assert.equal(created.nextRunAt, BASE_NOW + 60_000);
  h.now.value += 60_000;
  const started = await h.store.tick();
  assert.equal(started.length, 1);
  const job = h.store.getJob('a1');
  assert.equal(job?.enabled, false);
  assert.equal(job?.nextRunAt, null);
  assert.equal(job?.lastStatus, 'succeeded');
});

test('持久化：同一文件重新打开保留任务、运行记录与 id 序号', async () => {
  const h = harness();
  h.store.create({ prompt: '第一条', schedule: { kind: 'manual' } });
  await h.store.runNow('a1');
  const reopened = h.open();
  const summary = reopened.ensure();
  assert.equal(summary.jobs, 1);
  const runs = reopened.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'succeeded');
  const second = reopened.create({ prompt: '第二条', schedule: { kind: 'manual' } });
  assert.equal(second.id, 'a2', 'id 序号接着涨');
});

test('关闭时：tick 不跑、runNow 直接拒绝；坏档不崩', async () => {
  const h = harness({ enabled: () => false });
  h.store.create({ prompt: '关着的时候', schedule: { kind: 'interval', everyMinutes: 1 } });
  h.now.value += 120_000;
  assert.deepEqual(await h.store.tick(), []);
  await assert.rejects(
    () => h.store.runNow('a1'),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
  assert.equal(h.store.status().enabled, false);
});

test('坏档：JSON 坏了也不崩，按空档启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-automation-bad-'));
  const file = path.join(dir, 'automations.json');
  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  const store = new AutomationStore({
    file,
    now: () => BASE_NOW,
    armTimers: false,
    runJob: async () => ({ output: 'ok' }),
  });
  const summary = store.ensure();
  assert.equal(summary.jobs, 0);
  assert.equal(store.listJobs().length, 0);
});
