/**
 * WorkspaceMemory 测试：路径准入、读写、移动删除、清单折叠、glob/grep。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { globToRegExp, LIST_DIR_CAP, normalizeWorkspacePath, WorkspaceMemory, writeBlockReason } from './store.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-memory-'));
}

test('normalizeWorkspacePath 统一斜杠、去冗余段', () => {
  assert.equal(normalizeWorkspacePath('a\\b\\c.md'), 'a/b/c.md');
  assert.equal(normalizeWorkspacePath('//a//b/./c.md'), '/a/b/c.md');
  assert.equal(normalizeWorkspacePath('/abs/x.md'), '/abs/x.md');
});

test('writeBlockReason 拒绝 .. 与点开头，正常相对路径放行', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  assert.match(writeBlockReason(memory.dir, '../escape.md') ?? '', /「\.\.」/);
  assert.match(writeBlockReason(memory.dir, '.git/config') ?? '', /点开头/);
  assert.match(writeBlockReason(memory.dir, 'a/.hidden.md') ?? '', /点开头/);
  assert.equal(writeBlockReason(memory.dir, 'partner/作息.md'), null);
  assert.equal(writeBlockReason(memory.dir, 'notes'), null);
});

test('seed/list/read/write/append 闭环', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  memory.seed([['MEMORY.md', '# 我的记忆\n']]);
  assert.ok(memory.exists('MEMORY.md'));
  assert.equal(memory.readFile('MEMORY.md'), '# 我的记忆\n');

  memory.writeFileAtomic('partner/作息.md', '凌晨一点睡。');
  assert.equal(memory.readFile('partner/作息.md'), '凌晨一点睡。');

  memory.appendFile('partner/作息.md', '早上九点起。');
  assert.equal(memory.readFile('partner/作息.md'), '凌晨一点睡。\n早上九点起。');

  const entries = memory.listDir('partner');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, 'file');
  assert.equal(entries[0]?.path, 'partner/作息.md');
  assert.deepEqual(memory.walkFiles('').sort(), ['MEMORY.md', 'partner/作息.md']);
});

test('移动/删除/清空目录与冲突', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  memory.writeFileAtomic('log/2026-11.md', '一条记录');
  memory.renameFile('log/2026-11.md', 'archive/2026-11.md');
  assert.equal(memory.exists('log/2026-11.md'), false);
  assert.equal(memory.readFile('archive/2026-11.md'), '一条记录');
  memory.pruneEmptyDirs('log/2026-11.md');
  assert.equal(fs.existsSync(path.join(dir, 'log')), false);

  assert.throws(
    () => memory.renameFile('archive/2026-11.md', 'archive/2026-11.md'),
    (e: unknown) => e instanceof PetdError
  );
  memory.writeFileAtomic('archive/2026-11.md', '覆盖写');
  memory.deleteFile('archive/2026-11.md');
  assert.equal(memory.exists('archive/2026-11.md'), false);
});

test('路径逃逸与绝对路径被拒绝', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  assert.throws(() => memory.readFile('../x.md'), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(() => memory.writeFileAtomic('C:/x.md', 'x'), (e: unknown) => e instanceof PetdError);
  assert.throws(() => memory.readFile('/etc/passwd'), (e: unknown) => e instanceof PetdError);
});

test('glob 与 grep', () => {
  assert.equal(globToRegExp('**/*.md').test('a/b.md'), true);
  assert.equal(globToRegExp('*.md').test('a.md'), true);
  assert.equal(globToRegExp('*.md').test('a/b.md'), false);

  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  memory.writeFileAtomic('PARTNER.md', '称呼：master');
  memory.writeFileAtomic('partner/作息.md', '凌晨一点睡\n喜欢安静');
  memory.writeFileAtomic('notes/其他.txt', '无关内容');

  const md = memory.globFiles('*.md');
  assert.deepEqual(md.sort(), ['PARTNER.md', 'partner/作息.md']);

  const hits = memory.grep({ match: '凌晨' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, 'partner/作息.md');
  assert.deepEqual(hits[0]?.hits, [0]);

  const regexHits = memory.grep({ match: /master|安静/ });
  assert.equal(regexHits.length, 2);
});

test('listing 显式列目录时全量列出', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  for (let i = 0; i < LIST_DIR_CAP + 2; i += 1) memory.writeFileAtomic(`log/2026-11-${i}.md`, `第 ${i} 条`);
  const listing = memory.listing('log');
  assert.match(listing, /工作区 log\/ 的文件/);
  assert.match(listing, /2026-11-11\.md/);
  assert.equal(listing.split('\n').filter((l) => l.startsWith('- ')).length, 12);
});

test('treeShallow 只列顶层', () => {
  const dir = tmpDir();
  const memory = new WorkspaceMemory({ dir });
  memory.writeFileAtomic('PARTNER.md', 'x');
  memory.writeFileAtomic('partner/细节.md', 'y');
  const tree = memory.treeShallow();
  assert.match(tree, /PARTNER\.md/);
  assert.match(tree, /partner\//);
  assert.doesNotMatch(tree, /细节\.md/);
});
