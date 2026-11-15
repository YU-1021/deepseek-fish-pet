/**
 * memory.* 方法测试：注册齐全、参数校验、读写删移动、Git 提交、常驻文件守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { WorkspaceMemory } from '../../memory/store.js';
import { WorkspaceGit } from '../../memory/git.js';
import { MemoryService } from '../../memory/service.js';
import { registerMemoryMethods } from './memory.js';

function setup(): { reg: MethodRegistry; service: MemoryService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mem-methods-'));
  const memory = new WorkspaceMemory({ dir });
  const git = new WorkspaceGit(dir);
  const service = new MemoryService({ memory, git, version: '0.0.0-test' });
  service.ensure();
  const reg = new MethodRegistry();
  registerMemoryMethods(reg, { memory: service });
  return { reg, service, dir };
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

test('注册 12 个 memory.* 方法，参数校验生效', async () => {
  const { reg } = setup();
  const names = reg.names().filter((n) => n.startsWith('memory.'));
  assert.deepEqual(names, [
    'memory.append',
    'memory.delete',
    'memory.diff',
    'memory.glob',
    'memory.grep',
    'memory.history',
    'memory.list',
    'memory.move',
    'memory.read',
    'memory.status',
    'memory.tree',
    'memory.write',
  ]);
  assert.ok(reg.validate('memory.write', { path: 'a.md' }), '缺 content 应该校验失败');
  assert.equal(reg.validate('memory.write', { path: 'a.md', content: '内容' }), null);
});

test('status/tree/list：播种后可用', async () => {
  const { reg } = setup();
  const status = (await call(reg, 'memory.status', {})) as { dir: string; fileCount: number; git: { repo: boolean } };
  assert.ok(status.dir.length > 0);
  assert.ok(status.fileCount >= 3);
  assert.equal(status.git.repo, true);

  const tree = (await call(reg, 'memory.tree', {})) as { tree: string };
  assert.match(tree.tree, /PARTNER\.md/);

  const list = (await call(reg, 'memory.list', {})) as { entries: Array<{ path: string }> };
  assert.ok(list.entries.some((e) => e.path === 'PARTNER.md'));
});

test('write/append/read/glob/grep/history 闭环', async () => {
  const { reg } = setup();
  const wrote = (await call(reg, 'memory.write', { path: 'partner/作息.md', content: '凌晨一点睡。' })) as {
    path: string;
    bytes: number;
    commit: string | null;
  };
  assert.equal(wrote.path, 'partner/作息.md');
  assert.ok(wrote.bytes > 0);
  assert.ok(wrote.commit, '写入后应该有 Git 提交');

  await call(reg, 'memory.append', { path: 'partner/作息.md', content: '早上九点起。' });
  const read = (await call(reg, 'memory.read', { path: 'partner/作息.md' })) as { content: string };
  assert.equal(read.content, '凌晨一点睡。\n早上九点起。');

  const glob = (await call(reg, 'memory.glob', { pattern: '*.md' })) as { files: string[] };
  assert.ok(glob.files.includes('partner/作息.md'));

  const grep = (await call(reg, 'memory.grep', { query: '凌晨' })) as { hits: Array<{ path: string; line: number }> };
  assert.equal(grep.hits.length, 1);
  assert.equal(grep.hits[0]?.line, 1);

  const history = (await call(reg, 'memory.history', { limit: 10 })) as { commits: Array<{ message: string }> };
  assert.ok(history.commits.some((c) => c.message.includes('petd wrote partner/作息.md')));
});

test('move/delete 与常驻文件守卫', async () => {
  const { reg } = setup();
  await call(reg, 'memory.write', { path: 'notes/临时.md', content: '稍后归档' });
  const moved = (await call(reg, 'memory.move', { from: 'notes/临时.md', to: 'archive/临时.md' })) as { to: string };
  assert.equal(moved.to, 'archive/临时.md');
  await call(reg, 'memory.delete', { path: 'archive/临时.md' });
  const after = (await call(reg, 'memory.glob', { pattern: 'archive/*' })) as { files: string[] };
  assert.deepEqual(after.files, []);

  await assert.rejects(
    () => call(reg, 'memory.delete', { path: 'PARTNER.md' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_FORBIDDEN'
  );
  await assert.rejects(
    () => call(reg, 'memory.move', { from: 'PARTNER.md', to: 'archive/PARTNER.md' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_FORBIDDEN'
  );
});
