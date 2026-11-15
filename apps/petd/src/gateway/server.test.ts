/**
 * 网关集成测试：真 WS 连接、真超时、真幂等。
 *
 * 覆盖：握手成功/失败、首帧顺序、方法分发、参数校验、未知方法、超时、异常映射、
 * 幂等缓存（默认开）/write 方法不缓存、事件广播、优雅停止。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import { EventBus } from '../kernel/events.js';
import { systemClock } from '../kernel/clock.js';
import { createLogger } from '../kernel/logger.js';
import { MethodRegistry } from './registry.js';
import { Gateway } from './server.js';

const TOKEN = 'k'.repeat(40);
const CLIENT = { name: 'pet-ui-test', version: '0.1.0', pid: 1234 };

let gw: Gateway;
let port = 0;
let home = '';
let readCount = 0;
let writeCount = 0;

function registerTestMethods(reg: MethodRegistry): void {
  reg.register(
    { name: 'test.echo', scope: 'read', description: '回显', params: Type.Object({ n: Type.Integer() }) },
    (params) => ({ n: (params as { n: number }).n })
  );
  reg.register({ name: 'test.count', scope: 'read', description: '自增计数（幂等）' }, () => {
    readCount += 1;
    return { count: readCount };
  });
  reg.register({ name: 'test.write', scope: 'write', description: '自增写计数（不幂等）', idempotent: false }, () => {
    writeCount += 1;
    return { count: writeCount };
  });
  reg.register({ name: 'test.slow', scope: 'read', description: '超时', timeoutMs: 60 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { done: true };
  });
  reg.register({ name: 'test.boom', scope: 'read', description: '业务异常' }, () => {
    throw new PetdError('E_FORBIDDEN', '策略拒绝');
  });
  reg.register({ name: 'test.crash', scope: 'read', description: '未知异常' }, () => {
    throw new Error('内部字符串不应外泄');
  });
}

interface Client {
  ws: WebSocket;
  next(pred?: (f: any) => boolean, timeoutMs?: number): Promise<any>;
  send(frame: unknown): void;
  close(): Promise<void>;
}

function makeClient(): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(frame));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      if (!w) return;
      clearTimeout(w.timer);
      w.resolve(frame);
    } else {
      queue.push(frame);
    }
  });
  return {
    ws,
    next(pred = () => true, timeoutMs = 3000) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`等待帧超时；已收到=${JSON.stringify(queue)}`));
        }, timeoutMs);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    close() {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };
}

async function connect(token = TOKEN): Promise<Client> {
  const c = makeClient();
  await new Promise<void>((resolve, reject) => {
    c.ws.once('open', () => resolve());
    c.ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 3000).unref?.();
  });
  c.send({ type: 'connect', token, client: CLIENT });
  return c;
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-gw-'));
  const reg = new MethodRegistry();
  registerTestMethods(reg);
  gw = new Gateway({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    version: '0.1.0-test',
    startedAt: systemClock.now(),
    registry: reg,
    bus: new EventBus(),
    logger: createLogger({ file: path.join(home, 'log.jsonl'), level: 'error', maxBytes: 1024 * 1024 }),
    clock: systemClock,
  });
  port = await gw.start();
});

after(async () => {
  await gw.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('握手成功：收到 hello，server.name=petd', async () => {
  const c = await connect();
  const hello = await c.next((f) => f.type === 'hello');
  assert.equal(hello.server.name, 'petd');
  assert.equal(hello.server.protocol, 1);
  assert.equal(typeof hello.server.pid, 'number');
  assert.ok(hello.sessionId.length > 0);
  await c.close();
});

test('token 错误：E_UNAUTHORIZED 并断开 4003', async () => {
  const c = await connect('bad-token-123');
  const res = await c.next((f) => f.type === 'res');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_UNAUTHORIZED');
  const code = await new Promise<number>((resolve) => c.ws.once('close', resolve));
  assert.equal(code, 4003);
});

test('首帧不是 connect：E_HANDSHAKE 并断开 4001', async () => {
  const c = makeClient();
  await new Promise<void>((resolve, reject) => {
    c.ws.once('open', () => resolve());
    c.ws.once('error', reject);
  });
  c.send({ type: 'req', id: 'x', method: 'health.ping' });
  const res = await c.next((f) => f.type === 'res');
  assert.equal(res.error.code, 'E_HANDSHAKE');
  const code = await new Promise<number>((resolve) => c.ws.once('close', resolve));
  assert.equal(code, 4001);
});

test('未知方法：E_UNKNOWN_METHOD', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'a1', method: 'nope.nothing' });
  const res = await c.next((f) => f.type === 'res' && f.id === 'a1');
  assert.equal(res.error.code, 'E_UNKNOWN_METHOD');
  await c.close();
});

test('参数不合法：E_BAD_PARAMS', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'a2', method: 'test.echo', params: { n: 'not-a-number' } });
  const res = await c.next((f) => f.type === 'res' && f.id === 'a2');
  assert.equal(res.error.code, 'E_BAD_PARAMS');
  await c.close();
});

test('正常请求返回 data', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'a3', method: 'test.echo', params: { n: 42 } });
  const res = await c.next((f) => f.type === 'res' && f.id === 'a3');
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { n: 42 });
  await c.close();
});

test('超时：E_TIMEOUT（约 60ms）', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  const t0 = Date.now();
  c.send({ type: 'req', id: 'a4', method: 'test.slow' });
  const res = await c.next((f) => f.type === 'res' && f.id === 'a4', 2000);
  assert.equal(res.error.code, 'E_TIMEOUT');
  assert.ok(Date.now() - t0 < 1000);
  await c.close();
});

test('业务异常：E_FORBIDDEN；未知异常：E_INTERNAL 且不泄露内部字符串', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'a5', method: 'test.boom' });
  const r1 = await c.next((f) => f.type === 'res' && f.id === 'a5');
  assert.equal(r1.error.code, 'E_FORBIDDEN');
  assert.equal(r1.error.message, '策略拒绝');
  c.send({ type: 'req', id: 'a6', method: 'test.crash' });
  const r2 = await c.next((f) => f.type === 'res' && f.id === 'a6');
  assert.equal(r2.error.code, 'E_INTERNAL');
  assert.equal(r2.error.message, '内部错误');
  await c.close();
});

test('幂等：read 方法同 id 重发返回缓存，不重复执行', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'same-id', method: 'test.count' });
  const r1 = await c.next((f) => f.type === 'res' && f.id === 'same-id');
  c.send({ type: 'req', id: 'same-id', method: 'test.count' });
  const r2 = await c.next((f) => f.type === 'res' && f.id === 'same-id');
  assert.deepEqual(r1.data, r2.data);
  await c.close();
});

test('write 方法不缓存：同 id 重发会再次执行', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  c.send({ type: 'req', id: 'w1', method: 'test.write' });
  const r1 = await c.next((f) => f.type === 'res' && f.id === 'w1');
  c.send({ type: 'req', id: 'w1', method: 'test.write' });
  const r2 = await c.next((f) => f.type === 'res' && f.id === 'w1');
  assert.notDeepEqual(r1.data, r2.data);
  await c.close();
});

test('事件广播：已握手客户端收到 event 且 seq 递增', async () => {
  const c = await connect();
  await c.next((f) => f.type === 'hello');
  gw.publish('test.event', { hello: 1 });
  gw.publish('test.event', { hello: 2 });
  const e1 = await c.next((f) => f.type === 'event' && f.event === 'test.event');
  const e2 = await c.next((f) => f.type === 'event' && f.event === 'test.event');
  assert.equal(e1.data.hello, 1);
  assert.ok(e2.seq > e1.seq);
  await c.close();
});

test('非法 JSON：E_BAD_FRAME 并断开', async () => {
  const c = makeClient();
  await new Promise<void>((resolve, reject) => {
    c.ws.once('open', () => resolve());
    c.ws.once('error', reject);
  });
  c.ws.send('{not json');
  const res = await c.next((f) => f.type === 'res');
  assert.equal(res.error.code, 'E_BAD_FRAME');
  await new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
});
