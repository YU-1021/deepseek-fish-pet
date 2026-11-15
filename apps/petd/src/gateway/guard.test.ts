/**
 * 网关审批门测试：guard 在参数校验后、handler 前拦截；拒绝回 E_FORBIDDEN。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Type } from '@sinclair/typebox';
import { EventBus } from '../kernel/events.js';
import { systemClock } from '../kernel/clock.js';
import { createLogger } from '../kernel/logger.js';
import { MethodRegistry } from './registry.js';
import { Gateway } from './server.js';

const TOKEN = 'g'.repeat(40);
const CLIENT = { name: 'guard-test', version: '0.0.0' };

interface GuardCtx {
  kind: string;
  name: string;
  params?: unknown;
  sessionId?: string;
  client?: { name: string };
}

const guardedCalls: GuardCtx[] = [];
let gw: Gateway;
let port = 0;
let home = '';
let handlerRuns = 0;

function makeClient(): { ws: WebSocket; next(pred?: (f: any) => boolean): Promise<any>; send(f: unknown): void } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(frame));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      if (w) w.resolve(frame);
    } else {
      queue.push(frame);
    }
  });
  return {
    ws,
    next(pred = () => true) {
      const found = queue.findIndex(pred);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
  };
}

async function connect(): Promise<{ ws: WebSocket; next: (p?: (f: any) => boolean) => Promise<any>; send: (f: unknown) => void }> {
  const c = makeClient();
  await new Promise<void>((resolve, reject) => {
    c.ws.once('open', () => resolve());
    c.ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 3000).unref?.();
  });
  c.send({ type: 'connect', token: TOKEN, client: CLIENT });
  await c.next((f) => f.type === 'hello');
  return c;
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-guard-'));
  const reg = new MethodRegistry();
  reg.register({ name: 'probe.allowed', scope: 'read', description: '放行的方法', params: Type.Object({ n: Type.Integer() }) }, (params) => ({
    n: (params as { n: number }).n,
    handlerRuns,
  }));
  reg.register(
    { name: 'probe.blocked', scope: 'write', description: '会被审批门拦的方法', idempotent: false },
    () => {
      handlerRuns += 1;
      return { ran: true };
    }
  );
  gw = new Gateway({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    version: '0.0.0-test',
    startedAt: systemClock.now(),
    registry: reg,
    bus: new EventBus(),
    logger: createLogger({ file: path.join(home, 'log.jsonl'), level: 'error', maxBytes: 1024 * 1024 }),
    clock: systemClock,
    guard: async (ctx) => {
      guardedCalls.push({ kind: ctx.kind, name: ctx.name, params: ctx.params, sessionId: ctx.sessionId, client: ctx.client });
      if (ctx.name === 'probe.blocked') return { allowed: false, reason: '测试需要二次确认' };
      return { allowed: true };
    },
  });
  port = await gw.start();
});

after(async () => {
  await gw.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('放行：guard 收到 method/params/sessionId/client，handler 正常执行', async () => {
  const c = await connect();
  c.send({ type: 'req', id: 'r1', method: 'probe.allowed', params: { n: 7 } });
  const res = await c.next((f) => f.type === 'res' && f.id === 'r1');
  assert.equal(res.ok, true);
  assert.equal(res.data.n, 7);
  const call = guardedCalls.find((x) => x.name === 'probe.allowed');
  assert.ok(call);
  assert.equal(call.kind, 'method');
  assert.deepEqual(call.params, { n: 7 });
  assert.equal(call.client?.name, 'guard-test');
  c.ws.close();
});

test('拒绝：返回 E_FORBIDDEN 与原因，handler 不执行', async () => {
  const c = await connect();
  const before = handlerRuns;
  c.send({ type: 'req', id: 'r2', method: 'probe.blocked' });
  const res = await c.next((f) => f.type === 'res' && f.id === 'r2');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_FORBIDDEN');
  assert.match(res.error.message, /测试需要二次确认/);
  assert.equal(handlerRuns, before, '被拦住的方法不应执行 handler');
  c.ws.close();
});

test('参数校验先于 guard：非法参数不触发 guard', async () => {
  const c = await connect();
  const count = guardedCalls.filter((x) => x.name === 'probe.allowed').length;
  c.send({ type: 'req', id: 'r3', method: 'probe.allowed', params: { n: '不是数字' } });
  const res = await c.next((f) => f.type === 'res' && f.id === 'r3');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_BAD_PARAMS');
  assert.equal(guardedCalls.filter((x) => x.name === 'probe.allowed').length, count, '参数非法时不应调用 guard');
  c.ws.close();
});
