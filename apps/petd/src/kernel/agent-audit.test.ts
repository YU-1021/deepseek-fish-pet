/**
 * 自我迭代审计：只追加的变更流水 + 按记录回滚动态文件（INV-9）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentAuditLog } from './agent-audit.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-audit-'));
}

function makeLog(home = tmpHome(), opts: { maxBytes?: number } = {}): AgentAuditLog {
  return new AgentAuditLog({ home, now: () => '2025-01-01T00:00:00.000Z', ...opts });
}

function writeFile(home: string, rel: string, content: string): string {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('append：记录路径/角色/区域/前后 hash 与 diff', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', '## 说话方式\n旧语气\n');
  const meta = log.append({
    path: abs,
    actor: 'agent',
    action: 'write',
    reason: '相处久了',
    beforeText: '## 说话方式\n旧语气\n',
    afterText: '## 说话方式\n新语气\n',
  });
  assert.equal(meta.path, 'SOUL.agent.md');
  assert.equal(meta.actor, 'agent');
  assert.equal(meta.action, 'write');
  assert.equal(meta.zone, 'agent-file');
  assert.equal(meta.reason, '相处久了');
  assert.equal(meta.before?.bytes, Buffer.byteLength('## 说话方式\n旧语气\n'));
  assert.notEqual(meta.before?.hash, meta.after?.hash);
  assert.ok(meta.diffChars > 0);
  assert.equal((meta.before as Record<string, unknown> | null)?.['text'], undefined, '列表记录不带正文');
});

test('list：新→旧、可按 path/actor 过滤、total 正确', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const soul = writeFile(home, 'SOUL.agent.md', 'a');
  const skill = writeFile(home, 'skills/staging/x.agent.md', 'b');
  log.append({ path: soul, actor: 'agent', action: 'write', beforeText: null, afterText: 'a' });
  log.append({ path: skill, actor: 'agent', action: 'write', beforeText: null, afterText: 'b' });
  log.append({ path: soul, actor: 'user', action: 'write', beforeText: 'a', afterText: '' });
  const all = log.list();
  assert.equal(all.total, 3);
  assert.equal(all.entries[0]?.actor, 'user', '最新的在最前');
  assert.deepEqual(log.list({ path: 'SOUL.agent.md' }).entries.map((e) => e.actor), ['user', 'agent']);
  assert.deepEqual(log.list({ actor: 'agent' }).entries.map((e) => e.path), ['skills/staging/x.agent.md', 'SOUL.agent.md']);
  assert.equal(log.list({ limit: 2 }).entries.length, 2);
  assert.equal(log.list({ limit: 2 }).total, 3);
});

test('get：返回前后正文与逐行 diff', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', 'x');
  log.append({ path: abs, actor: 'agent', action: 'write', beforeText: '第一行\n旧\n', afterText: '第一行\n新\n' });
  const id = log.list().entries[0]?.id as string;
  const entry = log.get(id);
  assert.equal(entry.before?.text, '第一行\n旧\n');
  assert.equal(entry.after?.text, '第一行\n新\n');
  assert.match(entry.diff, /\+新/);
  assert.match(entry.diff, /-旧/);
  assert.throws(() => log.get('nope'), /没有这条审计记录/);
});

test('append：目标不在写盘白名单时拒绝', () => {
  const home = tmpHome();
  const log = makeLog(home);
  assert.throws(
    () => log.append({ path: path.join(home, 'config.json'), actor: 'agent', action: 'write', beforeText: null, afterText: 'x' }),
    /不在允许范围/
  );
});

test('rollback：恢复旧内容并追加一条回滚记录', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', '旧');
  const first = log.append({ path: abs, actor: 'agent', action: 'write', beforeText: '旧', afterText: '新' });
  writeFile(home, 'SOUL.agent.md', '新');
  const r = log.rollback(first.id);
  assert.equal(r.restored, 'content');
  assert.equal(r.path, 'SOUL.agent.md');
  assert.equal(fs.readFileSync(abs, 'utf8'), '旧');
  const entries = log.list().entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.action, 'write', '回滚本身也是一次写');
  assert.equal(entries[0]?.actor, 'user');
  assert.match(entries[0]?.reason ?? '', /回滚/);
});

test('rollback：记录是新建文件时把文件删掉', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', '新建');
  const created = log.append({ path: abs, actor: 'agent', action: 'write', beforeText: null, afterText: '新建' });
  const r = log.rollback(created.id);
  assert.equal(r.restored, 'deleted');
  assert.equal(fs.existsSync(abs), false);
  assert.equal(log.list().entries[0]?.action, 'write');
});

test('rollback：文件之后又被改过时拒绝，force 才覆盖', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', '旧');
  const first = log.append({ path: abs, actor: 'agent', action: 'write', beforeText: '旧', afterText: '新' });
  writeFile(home, 'SOUL.agent.md', '被人改过');
  assert.throws(() => log.rollback(first.id), /又被改过/);
  assert.equal(fs.readFileSync(abs, 'utf8'), '被人改过');
  log.rollback(first.id, { force: true });
  assert.equal(fs.readFileSync(abs, 'utf8'), '旧');
});

test('rollback：只允许动态文件，记忆区走 Git 回滚', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'workspace/notes.md', '记忆');
  const meta = log.append({ path: abs, actor: 'agent', action: 'write', beforeText: null, afterText: '记忆' });
  assert.equal(meta.zone, 'memory');
  assert.throws(() => log.rollback(meta.id), /只能回滚带 \.agent\. 后缀的动态文件/);
});

test('重建实例仍能读到已有记录（JSONL 只追加）', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const abs = writeFile(home, 'SOUL.agent.md', 'x');
  log.append({ path: abs, actor: 'agent', action: 'write', beforeText: null, afterText: 'x' });
  const again = new AgentAuditLog({ home });
  assert.equal(again.list().total, 1);
});

test('超过 maxBytes 时轮转到 .1，主文件继续写', () => {
  const home = tmpHome();
  const log = makeLog(home, { maxBytes: 400 });
  const abs = writeFile(home, 'SOUL.agent.md', 'x');
  for (let i = 0; i < 4; i += 1) {
    log.append({ path: abs, actor: 'agent', action: 'write', beforeText: null, afterText: 'x'.repeat(120) });
  }
  assert.equal(fs.existsSync(log.auditFile + '.1'), true);
  assert.ok(log.list().total < 4, '旧记录进了 .1，主文件只保留轮转后的记录');
  assert.ok(log.list().total >= 1);
});
