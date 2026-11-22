/**
 * memory.* 方法测试：注册齐全、参数校验、读写删移动、Git 提交、常驻文件守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { WorkspaceMemory } from '../../memory/store.js';
import { WorkspaceGit } from '../../memory/git.js';
import { MemoryService } from '../../memory/service.js';
import { registerMemoryMethods } from './memory.js';
import type { DistilledContext } from '../../memory/distill.js';

interface SetupOptions {
  inject?: () => DistilledContext;
}

function setup(opts: SetupOptions = {}): { reg: MethodRegistry; service: MemoryService; dir: string; events: Array<{ event: string; data: Record<string, unknown> }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mem-methods-'));
  const memory = new WorkspaceMemory({ dir });
  const git = new WorkspaceGit(dir);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const service = new MemoryService({
    memory,
    git,
    version: '0.0.0-test',
    publish: (event, data) => events.push({ event, data }),
  });
  service.ensure();
  const reg = new MethodRegistry();
  registerMemoryMethods(reg, { memory: service, ...(opts.inject === undefined ? {} : { inject: opts.inject }) });
  return { reg, service, dir, events };
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

test('注册 14 个 memory.* 方法，参数校验生效', async () => {
  const { reg } = setup();
  const names = reg.names().filter((n) => n.startsWith('memory.'));
  assert.deepEqual(names, [
    'memory.append',
    'memory.delete',
    'memory.diff',
    'memory.glob',
    'memory.grep',
    'memory.history',
    'memory.inject',
    'memory.list',
    'memory.move',
    'memory.read',
    'memory.restore',
    'memory.status',
    'memory.tree',
    'memory.write',
  ]);
  assert.ok(reg.validate('memory.write', { path: 'a.md' }), '缺 content 应该校验失败');
  assert.equal(reg.validate('memory.write', { path: 'a.md', content: '内容' }), null);
  assert.ok(reg.validate('memory.write', { path: 'a.md', content: '内容', expectedContentHash: 'abc' }), 'hash 必须 64 位 hex');
  assert.ok(reg.validate('memory.restore', { path: 'a.md' }), 'restore 缺 hash 应该校验失败');
});

test('memory.inject 透传注入预览；没接注入时返回 E_UNAVAILABLE', async () => {
  const preview: DistilledContext = {
    enabled: true,
    text: '## 记住的事（按重要性）\n\n- 主人喜欢安静',
    used: { facts: 1, diary: 0, medium: 0 },
    dropped: { facts: 0, diary: 0, medium: 0 },
  };
  const wired = setup({ inject: () => preview });
  const result = (await call(wired.reg, 'memory.inject', {})) as DistilledContext;
  assert.equal(result.text, preview.text);
  assert.deepEqual(result.used, preview.used);

  const bare = setup();
  await assert.rejects(
    async () => call(bare.reg, 'memory.inject', {}),
    (err: unknown) => err instanceof PetdError && err.code === 'E_UNAVAILABLE'
  );
});

test('status/tree/list：播种后可用', async () => {
  const { reg, dir } = setup();
  const status = (await call(reg, 'memory.status', {})) as {
    dir: string;
    workspace: string;
    fileCount: number;
    git: { repo: boolean };
  };
  assert.ok(status.dir.length > 0);
  assert.equal(status.workspace, path.resolve(dir));
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

test('乐观并发：read 带 revision，write/append 带 baseRevision 冲突检测', async () => {
  const { reg, events } = setup();
  const wrote = (await call(reg, 'memory.write', { path: 'notes/并发.md', content: '第一版' })) as { revision: string };
  assert.equal(typeof wrote.revision, 'string');
  assert.equal(wrote.revision.length, 32);

  const read = (await call(reg, 'memory.read', { path: 'notes/并发.md' })) as { revision: string; content: string };
  assert.equal(read.content, '第一版');
  assert.equal(read.revision, wrote.revision);

  // 正确的 baseRevision → 允许覆盖
  const updated = (await call(reg, 'memory.write', {
    path: 'notes/并发.md',
    content: '第二版',
    baseRevision: read.revision,
  })) as { revision: string };
  assert.notEqual(updated.revision, read.revision);

  // 过期的 baseRevision → E_CONFLICT，且带上当前 revision 供 UI 提示
  await assert.rejects(
    () =>
      call(reg, 'memory.write', {
        path: 'notes/并发.md',
        content: '第三版',
        baseRevision: read.revision,
      }),
    (e: unknown) => {
      assert.ok(e instanceof PetdError);
      assert.equal(e.code, 'E_CONFLICT');
      assert.equal((e.details as { currentRevision?: string }).currentRevision, updated.revision);
      return true;
    }
  );

  // 追加同样支持 baseRevision
  await assert.rejects(
    () => call(reg, 'memory.append', { path: 'notes/并发.md', content: '追加', baseRevision: read.revision }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
  const appended = (await call(reg, 'memory.append', {
    path: 'notes/并发.md',
    content: '追加',
    baseRevision: updated.revision,
  })) as { revision: string };
  assert.ok(appended.revision);

  // 写/追加/删/移都会广播 memory.changed，UI 可以实时刷新面板
  const changed = events.filter((e) => e.event === 'memory.changed');
  assert.ok(changed.length >= 3);
  assert.ok(changed.some((e) => e.data.operation === 'write' && e.data.path === 'notes/并发.md'));
  assert.ok(changed.some((e) => e.data.operation === 'append' && e.data.path === 'notes/并发.md'));
  assert.ok(changed.every((e) => e.data.operation !== undefined), 'event data 必须带 operation');
});

test('expectedContentHash 并发冲突：不一致且非 force → E_CONFLICT，不写不提交', async () => {
  const { reg, events } = setup();
  const wrote = (await call(reg, 'memory.write', { path: 'notes/hash.md', content: '基线' })) as { revision: string };
  const read = (await call(reg, 'memory.read', { path: 'notes/hash.md' })) as { content: string };
  const baseline = createHash('sha256').update(read.content, 'utf8').digest('hex');
  const before = (await call(reg, 'memory.history', { limit: 10 })) as { commits: Array<{ fullHash: string }> };
  const countBefore = before.commits.length;

  // 正确的 expectedContentHash → 允许覆盖
  const updated = (await call(reg, 'memory.write', {
    path: 'notes/hash.md',
    content: '第二版',
    expectedContentHash: baseline,
  })) as { revision: string };
  assert.notEqual(updated.revision, wrote.revision);

  // 过期的 expectedContentHash → 冲突，文件与提交都不变
  await assert.rejects(
    () => call(reg, 'memory.write', { path: 'notes/hash.md', content: '第三版', expectedContentHash: baseline }),
    (e: unknown) => {
      assert.ok(e instanceof PetdError);
      assert.equal(e.code, 'E_CONFLICT');
      assert.equal((e.details as { expectedContentHash?: string }).expectedContentHash, baseline);
      return true;
    }
  );
  const unchanged = (await call(reg, 'memory.read', { path: 'notes/hash.md' })) as { content: string };
  assert.equal(unchanged.content, '第二版');
  const after = (await call(reg, 'memory.history', { limit: 10 })) as { commits: Array<{ fullHash: string }> };
  assert.equal(after.commits.length, countBefore + 1, '冲突时不应该多出提交');

  // force=true → 强制覆盖
  const forced = (await call(reg, 'memory.write', {
    path: 'notes/hash.md',
    content: '第三版',
    expectedContentHash: baseline,
    force: true,
  })) as { revision: string };
  assert.ok(forced.revision);
  const changed = events.filter((e) => e.event === 'memory.changed' && e.data.operation === 'write');
  assert.ok(changed.every((e) => typeof e.data.commit === 'string' || e.data.commit === null));
});

test('memory.restore：从历史版本恢复正文并生成新提交（不改写历史）', async () => {
  const { reg, events } = setup();
  const v1 = (await call(reg, 'memory.write', { path: 'partner/作息.md', content: '第一版：凌晨一点睡。' })) as {
    commit: string | null;
  };
  assert.ok(v1.commit);
  await call(reg, 'memory.write', { path: 'partner/作息.md', content: '第二版：改成十一点睡。' });

  const read = (await call(reg, 'memory.read', { path: 'partner/作息.md' })) as { content: string };
  const currentHash = createHash('sha256').update(read.content, 'utf8').digest('hex');
  const before = (await call(reg, 'memory.history', { limit: 10 })) as { commits: Array<{ fullHash: string }> };
  const restored = (await call(reg, 'memory.restore', {
    path: 'partner/作息.md',
    hash: v1.commit,
    expectedContentHash: currentHash,
  })) as { bytes: number; commit: string | null; revision: string };
  assert.ok(restored.commit);
  assert.notEqual(restored.commit, v1.commit, '恢复应该产生新提交');
  const back = (await call(reg, 'memory.read', { path: 'partner/作息.md' })) as { content: string };
  assert.equal(back.content, '第一版：凌晨一点睡。');
  const after = (await call(reg, 'memory.history', { limit: 10 })) as { commits: Array<{ fullHash: string }> };
  assert.equal(after.commits.length, before.commits.length + 1, '历史只增不减');
  assert.ok(events.some((e) => e.event === 'memory.changed' && e.data.operation === 'restore'));

  // 恢复常驻文件正文是允许的（只是不允许删除/移动）
  const partnerCommits = (await call(reg, 'memory.history', { path: 'PARTNER.md', limit: 10 })) as { commits: Array<{ fullHash: string }> };
  const firstPartner = partnerCommits.commits[partnerCommits.commits.length - 1]?.fullHash;
  assert.ok(firstPartner);
  await call(reg, 'memory.write', { path: 'PARTNER.md', content: '# 坐在电脑前的人\n\n改过的正文。\n' });
  const partner = (await call(reg, 'memory.read', { path: 'PARTNER.md' })) as { content: string };
  const partnerHash = createHash('sha256').update(partner.content, 'utf8').digest('hex');
  const partnerBack = (await call(reg, 'memory.restore', { path: 'PARTNER.md', hash: firstPartner, expectedContentHash: partnerHash })) as {
    commit: string | null;
  };
  assert.ok(partnerBack.commit);

  // 历史里没有这个文件 → E_NOT_FOUND
  await assert.rejects(
    () => call(reg, 'memory.restore', { path: 'partner/不存在.md', hash: v1.commit }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
});
