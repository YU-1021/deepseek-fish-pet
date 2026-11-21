/**
 * 静默活动：状态、间隔、夜间安静、用户闲置、每日上限、持久化与事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PresenceService } from './service.js';
import type { PetdConfig } from '../kernel/config.js';

type PresenceConfig = PetdConfig['presence'];

function makeConfig(overrides: Partial<PresenceConfig> = {}): PresenceConfig {
  return {
    enabled: true,
    quiet: true,
    intervalMinutes: 45,
    idleMinutes: 10,
    maxPerDay: 12,
    nightQuiet: { enabled: true, start: '23:00', end: '07:00' },
    ...overrides,
  };
}

/** 2026-11-21 12:00 本地时间（不落在夜间安静段里） */
const NOON = new Date(2026, 10, 21, 12, 0, 0).getTime();

function harness(overrides: Partial<PresenceConfig> = {}): {
  dir: string;
  svc: PresenceService;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  config: PresenceConfig;
  setNow: (ts: number) => void;
  setIdle: (ms: number) => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-presence-'));
  const config = makeConfig(overrides);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let now = NOON;
  let idle = 0;
  const svc = new PresenceService({
    file: path.join(dir, 'state', 'presence.json'),
    config: () => config,
    publish: (event, data) => events.push({ event, data }),
    now: () => now,
    idleProvider: () => idle,
    armTimers: false,
  });
  return {
    dir,
    svc,
    events,
    config,
    setNow: (ts) => {
      now = ts;
    },
    setIdle: (ms) => {
      idle = ms;
    },
  };
}

test('初始状态：没有活动、nextAt 为空、持久化文件还没写', () => {
  const h = harness();
  h.svc.ensure();
  const status = h.svc.status();
  assert.equal(status.enabled, true);
  assert.equal(status.quiet, true);
  assert.equal(status.countToday, 0);
  assert.equal(status.total, 0);
  assert.equal(status.last, null);
  assert.equal(status.nextAt, null);
  assert.deepEqual(h.svc.list(), []);
});

test('tick：满足间隔才活动，间隔内重复 tick 不再活动', () => {
  const h = harness();
  h.svc.ensure();
  h.setIdle(20 * 60_000);
  const a1 = h.svc.tick();
  assert.ok(a1);
  assert.equal(a1?.kind, 'groom');
  assert.equal(h.events.filter((e) => e.event === 'presence.activity').length, 1);
  h.setNow(NOON + 60_000);
  assert.equal(h.svc.tick(), null, '间隔未到');
  h.setNow(NOON + 45 * 60_000);
  const a2 = h.svc.tick();
  assert.ok(a2);
  assert.notEqual(a2?.id, a1?.id);
  assert.equal(h.svc.status().countToday, 2);
});

test('关闭时 tick 不动，runOnce 抛 E_UNAVAILABLE', () => {
  const h = harness({ enabled: false });
  h.svc.ensure();
  h.setIdle(60 * 60_000);
  assert.equal(h.svc.tick(), null);
  assert.throws(() => h.svc.runOnce(), /静默活动已关闭/);
});

test('夜间安静段内不活动，白天正常', () => {
  const h = harness({ idleMinutes: 0 });
  h.svc.ensure();
  h.setNow(new Date(2026, 10, 21, 23, 30, 0).getTime());
  assert.equal(h.svc.tick(), null, '夜间应安静');
  h.setNow(new Date(2026, 10, 21, 12, 0, 0).getTime());
  assert.ok(h.svc.tick(), '白天应活动');
});

test('用户没闲置够时让位，闲置够才活动', () => {
  const h = harness({ intervalMinutes: 5 });
  h.svc.ensure();
  h.setIdle(3 * 60_000);
  assert.equal(h.svc.tick(), null, '用户刚动过');
  h.setIdle(11 * 60_000);
  assert.ok(h.svc.tick(), '用户闲置够久');
});

test('每日上限：到上限后 tick 不再活动，runOnce 抛错', () => {
  const h = harness({ maxPerDay: 2, intervalMinutes: 5, idleMinutes: 0 });
  h.svc.ensure();
  assert.ok(h.svc.tick());
  h.setNow(NOON + 5 * 60_000);
  assert.ok(h.svc.tick());
  h.setNow(NOON + 10 * 60_000);
  assert.equal(h.svc.tick(), null, '到每日上限');
  assert.throws(() => h.svc.runOnce(), /次数已到上限/);
});

test('持久化：重开后记录还在、编号接着涨、今日计数保留', () => {
  const h = harness({ intervalMinutes: 5, idleMinutes: 0 });
  h.svc.ensure();
  const first = h.svc.runOnce();
  assert.ok(first);
  const dir = h.dir;
  const svc2 = new PresenceService({
    file: path.join(dir, 'state', 'presence.json'),
    config: () => h.config,
    now: () => NOON + 60_000,
    armTimers: false,
  });
  svc2.ensure();
  const status = svc2.status();
  assert.equal(status.total, 1);
  assert.equal(status.countToday, 1);
  const second = svc2.runOnce();
  assert.equal(second.id, 'p-0002');
});

test('事件带 kind/label/quiet，list 新到旧', () => {
  const h = harness({ intervalMinutes: 5, idleMinutes: 0 });
  h.svc.ensure();
  h.svc.runOnce();
  h.setNow(NOON + 5 * 60_000);
  h.svc.runOnce();
  const ev = h.events.find((e) => e.event === 'presence.activity');
  assert.ok(ev);
  assert.equal(ev?.data['quiet'], true);
  assert.equal(typeof ev?.data['label'], 'string');
  const list = h.svc.list(10);
  assert.equal(list.length, 2);
  assert.ok((list[0]?.at ?? 0) >= (list[1]?.at ?? 0));
});
