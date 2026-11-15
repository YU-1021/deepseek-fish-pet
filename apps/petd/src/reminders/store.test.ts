/**
 * 提醒存储测试：时间换算、落盘/重启、到点事件、过期跳过、上限、取消/稍后提醒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { computeReminderAt, ReminderStore } from './store.js';

interface Harness {
  dir: string;
  file: string;
  now: { value: number };
  events: Array<{ event: string; data: unknown }>;
  store: ReminderStore;
}

function harness(opts: { maxPending?: number; catchUpHours?: number; keepFiredDays?: number } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-reminders-'));
  const file = path.join(dir, 'reminders.json');
  const now = { value: Date.parse('2026-11-15T10:00:00+08:00') };
  const events: Array<{ event: string; data: unknown }> = [];
  const store = new ReminderStore({
    file,
    now: () => now.value,
    publish: (event, data) => events.push({ event, data }),
    armTimers: false,
    ...(opts.maxPending === undefined ? {} : { maxPending: opts.maxPending }),
    ...(opts.catchUpHours === undefined ? {} : { catchUpHours: opts.catchUpHours }),
    ...(opts.keepFiredDays === undefined ? {} : { keepFiredDays: opts.keepFiredDays }),
  });
  store.ensure();
  return { dir, file, now, events, store };
}

test('computeReminderAt：N 分钟后 / HH:MM（今天或明天）/ 绝对时间 / 非法输入', () => {
  const now = Date.parse('2026-11-15T10:00:00+08:00');
  assert.equal(computeReminderAt({ inMinutes: 30 }, now), now + 30 * 60_000);
  // 今天 18:00 还在未来
  const at1800 = new Date(now);
  at1800.setHours(18, 0, 0, 0);
  assert.equal(computeReminderAt({ atClock: '18:00' }, now), at1800.getTime());
  // 今天 09:00 已过 → 明天 09:00
  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  assert.equal(computeReminderAt({ atClock: '9:00' }, now), tomorrow9.getTime());
  // 绝对时间戳
  assert.equal(computeReminderAt({ at: now + 5000 }, now), now + 5000);
  // ISO 字符串
  assert.equal(computeReminderAt({ at: new Date(now + 60_000).toISOString() }, now), now + 60_000);
  // 一个都不给 / 给两种
  assert.throws(() => computeReminderAt({}, now), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(
    () => computeReminderAt({ inMinutes: 5, atClock: '18:00' }, now),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  // 非法时刻 / 已过去
  assert.throws(() => computeReminderAt({ atClock: '25:00' }, now), /小时 0-23/);
  assert.throws(() => computeReminderAt({ at: now - 10_000 }, now), /已经过去了/);
  assert.throws(() => computeReminderAt({ inMinutes: -1 }, now), /正数/);
  assert.throws(() => computeReminderAt({ inMinutes: 60 * 24 * 40 }, now), /最多 30 天/);
});

test('create/list/cancel/snooze 与事件', () => {
  const h = harness();
  const created = h.store.create({ text: '喝水', inMinutes: 30 });
  assert.equal(created.id, 'r1');
  assert.equal(created.snoozes, 0);
  assert.equal(created.inMinutes, 30);
  assert.equal(h.events[0]?.event, 'reminder.created');

  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.status().pending, 1);

  const snoozed = h.store.snooze('r1', 5);
  assert.equal(snoozed.snoozes, 1);
  assert.equal(snoozed.at, h.now.value + 5 * 60_000);
  assert.equal(h.events.at(-1)?.event, 'reminder.snoozed');

  const cancelled = h.store.cancel('r1');
  assert.equal(cancelled.id, 'r1');
  assert.equal(h.store.list().length, 0);
  assert.equal(h.events.at(-1)?.event, 'reminder.cancelled');

  // 再取消一次 / 不存在
  assert.throws(() => h.store.cancel('r1'), (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
  assert.throws(() => h.store.cancel('r999'), /没有编号/);
});

test('到点 tick 触发 reminder.due（含补报延迟）', () => {
  const h = harness();
  const created = h.store.create({ text: '开会', inMinutes: 10 });
  h.now.value = created.at + 2000; // 晚了 2 秒
  const fired = h.store.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.id, created.id);
  assert.equal(fired[0]?.status, 'fired');
  assert.equal(fired[0]?.firedLateMs, 2000);
  const due = h.events.find((e) => e.event === 'reminder.due');
  assert.ok(due);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.store.status().pending, 0);
});

test('过期超过 catchUpHours 的提醒标 skipped，不补报', () => {
  const h = harness({ catchUpHours: 1 });
  const created = h.store.create({ text: '旧提醒', inMinutes: 10 });
  h.now.value = created.at + 2 * 3_600_000;
  const fired = h.store.tick();
  assert.equal(fired.length, 0);
  const skipped = h.events.find((e) => e.event === 'reminder.skipped');
  assert.ok(skipped);
  assert.equal(h.store.list().length, 0);
});

test('落盘与重启：新实例能读回待响提醒', () => {
  const h = harness();
  h.store.create({ text: '买牛奶', inMinutes: 60 });
  h.store.create({ text: '交电费', atClock: '20:30' });
  const reopened = new ReminderStore({ file: h.file, now: () => h.now.value, armTimers: false });
  reopened.ensure();
  const list = reopened.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.text, '买牛奶');
  assert.equal(list[1]?.text, '交电费');
  // 取消后重启仍然是取消状态
  reopened.cancel(list[0]!.id);
  const reopened2 = new ReminderStore({ file: h.file, now: () => h.now.value, armTimers: false });
  reopened2.ensure();
  assert.equal(reopened2.list().length, 1);
});

test('待响上限 maxPending 生效', () => {
  const h = harness({ maxPending: 2 });
  h.store.create({ text: 'a', inMinutes: 10 });
  h.store.create({ text: 'b', inMinutes: 20 });
  assert.throws(
    () => h.store.create({ text: 'c', inMinutes: 30 }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE'
  );
});

test('清理：已响记录超过 keepFiredDays 后不再保留', () => {
  const h = harness({ keepFiredDays: 1 });
  const created = h.store.create({ text: '旧事', inMinutes: 1 });
  h.now.value = created.at + 1000;
  h.store.tick();
  h.now.value = created.at + 2 * 86_400_000;
  h.store.ensure(); // ensure 内部 cleanup
  const raw = JSON.parse(fs.readFileSync(h.file, 'utf8')) as { items: unknown[] };
  assert.equal(raw.items.length, 0);
});

test('文本与参数校验', () => {
  const h = harness();
  assert.throws(() => h.store.create({ text: '   ', inMinutes: 5 }), /不能为空/);
  assert.throws(() => h.store.create({ text: 'x'.repeat(301), inMinutes: 5 }), /太长/);
  assert.throws(() => h.store.snooze('r1', 0), /1–1440/);
  assert.throws(() => h.store.snooze('nope', 5), /没有编号/);
});
