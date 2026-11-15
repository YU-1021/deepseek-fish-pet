/**
 * blob.* 方法测试：注册齐全、put/list/info/get/delete 闭环、错误与参数校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { WorkspaceMemory } from '../../memory/store.js';
import { BlobStore } from '../../memory/blob.js';
import { registerBlobMethods } from './blob.js';

function setup(): { reg: MethodRegistry; blobs: BlobStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-blob-methods-'));
  const memory = new WorkspaceMemory({ dir });
  const blobs = new BlobStore(memory);
  blobs.ensure();
  const reg = new MethodRegistry();
  registerBlobMethods(reg, { blobs });
  return { reg, blobs };
}

const ctx = {
  sessionId: 'test-session',
  client: { name: 'test', version: '0.0.1' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
} as unknown as GatewayContext;

async function call(reg: MethodRegistry, name: string, params: unknown): Promise<unknown> {
  const m = reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx);
}

const B64 = Buffer.from('hello blob').toString('base64');

test('注册 5 个 blob.* 方法', () => {
  const { reg } = setup();
  assert.deepEqual(
    reg.names().filter((n) => n.startsWith('blob.')).sort(),
    ['blob.delete', 'blob.get', 'blob.info', 'blob.list', 'blob.put']
  );
  // 参数校验：缺 ref 应报错
  assert.ok(reg.validate('blob.info', {}) !== null);
  assert.equal(reg.validate('blob.info', { ref: 'blob:x.txt' }), null);
});

test('put → list → info → get → delete 闭环', async () => {
  const { reg } = setup();
  const meta = (await call(reg, 'blob.put', { dataBase64: B64, name: '你好.txt' })) as {
    handle: string;
    name: string;
    mime: string;
    size: number;
  };
  assert.match(meta.handle, /^blob:[0-9a-f]{16}-你好\.txt$/);
  assert.equal(meta.mime, 'text/plain');
  assert.equal(meta.size, Buffer.byteLength('hello blob'));

  const listed = (await call(reg, 'blob.list', {})) as { blobs: unknown[] };
  assert.equal(listed.blobs.length, 1);

  const info = (await call(reg, 'blob.info', { ref: meta.handle })) as typeof meta;
  assert.equal(info.handle, meta.handle);

  const got = (await call(reg, 'blob.get', { ref: meta.handle })) as { meta: typeof meta; dataBase64: string };
  assert.equal(Buffer.from(got.dataBase64, 'base64').toString(), 'hello blob');

  const removed = (await call(reg, 'blob.delete', { ref: meta.handle })) as { deleted: boolean };
  assert.equal(removed.deleted, true);
  const again = (await call(reg, 'blob.list', {})) as { blobs: unknown[] };
  assert.equal(again.blobs.length, 0);
});

test('非法 base64 与不存在的句柄报错', async () => {
  const { reg } = setup();
  await assert.rejects(
    () => call(reg, 'blob.put', { dataBase64: '   ' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  await assert.rejects(
    () => call(reg, 'blob.info', { ref: 'blob:nope.txt' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});
