/**
 * ChatStore 测试：JSONL 追加、索引、容错、重开读回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore, DEFAULT_TITLE } from './store.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-store-'));
}

test('create/list/get/append 基本闭环', () => {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  assert.deepEqual(store.list(), []);

  const meta = store.create('第一段对话');
  assert.equal(meta.title, '第一段对话');
  assert.equal(meta.messageCount, 0);
  assert.match(meta.id, /^s-[a-z0-9]+-[0-9a-f]{6}$/);

  const updated = store.append(meta.id, [
    { role: 'user', content: '你好', ts: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: '主人好', ts: '2026-01-01T00:00:01.000Z' },
  ]);
  assert.equal(updated?.messageCount, 2);

  const session = store.get(meta.id);
  assert.ok(session);
  assert.equal(session.title, '第一段对话');
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0]?.role, 'user');
  assert.equal(session.messages[1]?.content, '主人好');

  assert.equal(store.list().length, 1);
});

test('默认标题 + clamp + rename/remove', () => {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  const meta = store.create();
  assert.equal(meta.title, DEFAULT_TITLE);

  const long = 'x'.repeat(80);
  const renamed = store.rename(meta.id, long);
  assert.ok(renamed);
  assert.equal(renamed.title.length, 41);
  assert.ok(renamed.title.endsWith('…'));

  assert.equal(store.rename('s-nope-000000', 'x'), null);
  assert.equal(store.remove(meta.id), true);
  assert.equal(store.remove(meta.id), false);
  assert.equal(store.list().length, 0);
  assert.equal(fs.existsSync(path.join(dir, meta.id + '.jsonl')), false);
});

test('重开实例从 index.json 读回', () => {
  const dir = tmpDir();
  const a = new ChatStore({ dir });
  const meta = a.create('持久化');
  a.append(meta.id, [{ role: 'user', content: '在吗', ts: '2026-01-01T00:00:00.000Z' }]);

  const b = new ChatStore({ dir });
  const list = b.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, meta.id);
  assert.equal(list[0]?.messageCount, 1);
  assert.equal(b.get(meta.id)?.messages[0]?.content, '在吗');
});

test('半行损坏被跳过，合法行保留', () => {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  const meta = store.create('损坏测试');
  store.append(meta.id, [{ role: 'user', content: '一', ts: 't1' }]);
  fs.appendFileSync(path.join(dir, meta.id + '.jsonl'), '{"role":"user","content":\n', 'utf8');
  store.append(meta.id, [{ role: 'assistant', content: '二', ts: 't2' }]);

  const session = store.get(meta.id);
  assert.ok(session);
  assert.deepEqual(
    session.messages.map((m) => m.content),
    ['一', '二']
  );
});

test('index.json 不存在时从空开始（不炸）', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const store = new ChatStore({ dir });
  assert.equal(store.list().length, 0);
  assert.equal(store.get('s-missing-000000'), null);
});
