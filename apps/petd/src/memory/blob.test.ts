/**
 * BlobStore 测试：内容寻址存取、句柄解析、去重、删除、大小与路径守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { WorkspaceMemory } from './store.js';
import { BlobStore, MAX_BLOB_BYTES } from './blob.js';

function tmpStore(): { memory: WorkspaceMemory; blobs: BlobStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-blob-'));
  const memory = new WorkspaceMemory({ dir });
  const blobs = new BlobStore(memory);
  blobs.ensure();
  return { memory, blobs };
}

function pngBytes(): Buffer {
  // 最小 PNG 头 + 随便几个字节（不需要是合法图片）
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
}

test('put 返回句柄与元数据，list/resolve/getBytes 读回一致', () => {
  const { memory, blobs } = tmpStore();
  const data = pngBytes();
  const meta = blobs.put({ data, name: '猫咪截图.png' });

  assert.match(meta.handle, /^blob:[0-9a-f]{16}-猫咪截图\.png$/);
  assert.equal(meta.name, mainName(meta.handle));
  assert.equal(meta.mime, 'image/png');
  assert.equal(meta.size, data.length);
  assert.match(meta.sha256, /^[0-9a-f]{16}$/);

  assert.equal(blobs.list().length, 1);
  const byHandle = blobs.resolve(meta.handle);
  assert.equal(byHandle.handle, meta.handle);
  assert.equal(byHandle.sha256, meta.sha256);
  assert.equal(byHandle.path, meta.path);
  const byPath = blobs.resolve('blobs/' + mainName(meta.handle));
  assert.equal(byPath.handle, meta.handle);

  const got = blobs.getBytes(meta.handle);
  assert.equal(got.meta.handle, meta.handle);
  assert.deepEqual(got.data, data);

  // 文件真的在 blobs/ 下，而且是二进制（readFile 解不出文本也不影响）
  assert.ok(memory.exists('blobs/' + mainName(meta.handle)));
  assert.equal(memory.readBytes('blobs/' + mainName(meta.handle)).length, data.length);
});

test('同样内容只存一份（按 sha256 去重）', () => {
  const { blobs } = tmpStore();
  const data = Buffer.from('same content');
  const a = blobs.put({ data, name: '笔记.txt' });
  const b = blobs.put({ data, name: '笔记.txt' });
  assert.equal(a.handle, b.handle);
  assert.equal(blobs.list().length, 1);
});

test('不同内容但同名不覆盖（各自一份）', () => {
  const { blobs } = tmpStore();
  const a = blobs.put({ data: Buffer.from('aaa'), name: 'x.txt' });
  const b = blobs.put({ data: Buffer.from('bbb'), name: 'x.txt' });
  assert.notEqual(a.handle, b.handle);
  assert.equal(blobs.list().length, 2);
});

test('remove 物理删除；删后再读抛 E_NOT_FOUND', () => {
  const { blobs } = tmpStore();
  const meta = blobs.put({ data: Buffer.from('hello'), name: 'a.txt' });
  const removed = blobs.remove(meta.handle);
  assert.equal(removed.deleted, true);
  assert.equal(blobs.list().length, 0);
  assert.throws(() => blobs.resolve(meta.handle), (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
});

test('空内容/超大内容拒绝；非法句柄拒绝', () => {
  const { blobs } = tmpStore();
  assert.throws(() => blobs.put({ data: Buffer.alloc(0), name: 'empty.txt' }), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(
    () => blobs.put({ data: Buffer.alloc(MAX_BLOB_BYTES + 1), name: 'huge.bin' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  assert.throws(() => blobs.resolve('blob:../etc/passwd'), (e: unknown) => e instanceof PetdError);
  assert.throws(() => blobs.resolve('blob:'), (e: unknown) => e instanceof PetdError);
});

function mainName(handle: string): string {
  return handle.replace(/^blob:/, '');
}
