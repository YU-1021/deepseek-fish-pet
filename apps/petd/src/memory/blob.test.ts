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

test('kind 分类：图片/文本/音频/二进制', () => {
  const { blobs } = tmpStore();
  assert.equal(blobs.put({ data: pngBytes(), name: 'a.png' }).kind, 'image');
  assert.equal(blobs.put({ data: Buffer.from('你好'), name: 'a.md' }).kind, 'text');
  assert.equal(blobs.put({ data: Buffer.from('ID3'), name: 'a.mp3' }).kind, 'audio');
  assert.equal(blobs.put({ data: Buffer.from([0, 1, 2]), name: 'a.zip' }).kind, 'binary');
});

test('图片尺寸嗅探（PNG 头，不解码整图）', () => {
  const { blobs } = tmpStore();
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8); // IHDR length
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(640, 16);
  header.writeUInt32BE(360, 20);
  const meta = blobs.put({ data: header, name: '截图.png' });
  assert.equal(meta.kind, 'image');
  assert.deepEqual(meta.image, { width: 640, height: 360 });

  const listed = blobs.list()[0];
  assert.equal(listed?.kind, 'image');
  assert.deepEqual(listed?.image, { width: 640, height: 360 });
});

test('preview：文本按字符截断并标记 truncated，非文本只给元数据', () => {
  const { blobs } = tmpStore();
  const long = '第一段。'.repeat(100); // 400 字符
  const text = blobs.put({ data: Buffer.from(long, 'utf8'), name: '长笔记.md' });
  const p = blobs.preview(text.handle, { maxChars: 50 });
  assert.equal(p.meta.kind, 'text');
  assert.equal(p.text?.length, 50);
  assert.equal(p.truncated, true);

  const short = blobs.put({ data: Buffer.from('短短一句', 'utf8'), name: '短.md' });
  const sp = blobs.preview(short.handle);
  assert.equal(sp.text, '短短一句');
  assert.equal(sp.truncated, false);

  const img = blobs.put({ data: pngBytes(), name: '图.png' });
  const ip = blobs.preview(img.handle);
  assert.equal(ip.meta.kind, 'image');
  assert.equal(ip.text, undefined);
});

function mainName(handle: string): string {
  return handle.replace(/^blob:/, '');
}
