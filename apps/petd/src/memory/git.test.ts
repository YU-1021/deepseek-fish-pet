/**
 * WorkspaceGit 测试：建仓、提交、历史、tag、fileAt；本机没有 git 时整体跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTHOR_PETD, gitInstalled, WorkspaceGit } from './git.js';

const skip = gitInstalled() ? false : '本机没有 git';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-git-'));
}

test('建仓、提交、历史、tag、回读旧版本', { timeout: 30_000, skip }, () => {
  const dir = tmpDir();
  const git = new WorkspaceGit(dir);
  git.ensureRepo();
  assert.equal(git.isRepo(), true);

  fs.writeFileSync(path.join(dir, 'PARTNER.md'), '称呼：master\n', 'utf8');
  const first = git.commitAll('petd wrote PARTNER.md', AUTHOR_PETD);
  assert.ok(first);

  fs.writeFileSync(path.join(dir, 'PARTNER.md'), '称呼：master\n作息：凌晨一点睡\n', 'utf8');
  const second = git.commitAll('petd appended to PARTNER.md', AUTHOR_PETD);
  assert.ok(second);

  const log = git.log({ limit: 10 });
  assert.equal(log.length, 3); // checkpoint0 + 两次写入
  assert.equal(log[0]?.message, 'petd appended to PARTNER.md');
  assert.equal(log[1]?.message, 'petd wrote PARTNER.md');
  assert.equal(log[2]?.author, 'operator');

  assert.equal(git.dirty(), false);
  assert.equal(git.fileAt(second, 'PARTNER.md'), '称呼：master\n作息：凌晨一点睡\n');
  assert.equal(git.fileAt(first, 'PARTNER.md'), '称呼：master\n');

  git.tag('start-0.0.0', '测试启动快照');
  const tags = git.listTags().map((t) => t.name);
  assert.ok(tags.includes('checkpoint0'));
  assert.ok(tags.includes('start-0.0.0'));

  const status = git.status();
  assert.equal(status.repo, true);
  assert.equal(status.available, true);
  assert.equal(status.head?.length, 7);
});

test('无改动提交返回 null', { timeout: 30_000, skip }, () => {
  const dir = tmpDir();
  const git = new WorkspaceGit(dir);
  git.ensureRepo();
  assert.equal(git.commitAll('空提交', AUTHOR_PETD), null);
});

test('非法 revision / tag 名被拒绝', { timeout: 30_000, skip }, () => {
  const dir = tmpDir();
  const git = new WorkspaceGit(dir);
  git.ensureRepo();
  fs.writeFileSync(path.join(dir, 'a.md'), 'a', 'utf8');
  const hash = git.commitAll('petd wrote a.md', AUTHOR_PETD);
  assert.ok(hash);
  assert.throws(() => git.diff('-bad'));
  assert.throws(() => git.tag('bad tag', 'x'));
});
