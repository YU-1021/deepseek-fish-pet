/**
 * HookStore 测试：内置规则播种、匹配优先级、用户覆盖、CRUD、坏文件兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { HookStore } from './store.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-hooks-'));
  return path.join(dir, 'state', 'hooks.json');
}

test('ensure 播种内置危险动作规则并落盘', () => {
  const file = tmpFile();
  const store = new HookStore({ file });
  store.ensure();
  const rules = store.list();
  assert.ok(rules.length >= 9);
  for (const id of [
    'method-memory-delete',
    'method-memory-move',
    'method-blob-delete',
    'method-skill-delete',
    'method-plugin-disable',
    'method-session-delete',
    'method-automation-delete',
    'tool-file-delete',
    'tool-file-move',
  ]) {
    const rule = store.get(id);
    assert.ok(rule, `缺少内置规则 ${id}`);
    assert.equal(rule.action, 'ask');
    assert.equal(rule.builtin, true);
  }
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; rules: unknown[] };
  assert.equal(raw.version, 1);
  assert.equal(raw.rules.length, rules.length);
});

test('evaluate：method 与 tool 分开匹配，未知名字放行', () => {
  const store = new HookStore({ file: tmpFile() });
  store.ensure();
  const del = store.evaluate({ kind: 'method', name: 'memory.delete' });
  assert.equal(del.action, 'ask');
  assert.equal(del.rule?.id, 'method-memory-delete');
  const write = store.evaluate({ kind: 'method', name: 'memory.write' });
  assert.equal(write.action, 'allow');
  assert.equal(write.rule, null);
  const toolDel = store.evaluate({ kind: 'tool', name: 'delete_file' });
  assert.equal(toolDel.action, 'ask');
  // 同名字但 kind 不同不命中
  assert.equal(store.evaluate({ kind: 'tool', name: 'memory.delete' }).rule, null);
});

test('用户 allow 规则 priority 更小，可覆盖内置 ask；toggle 后恢复', () => {
  const store = new HookStore({ file: tmpFile() });
  store.ensure();
  const rule = store.create({
    id: 'allow-memory-delete',
    kind: 'method',
    names: ['memory.delete'],
    action: 'allow',
    description: '我允许删记忆',
    priority: 5,
  });
  assert.equal(rule.id, 'allow-memory-delete');
  assert.equal(store.evaluate({ kind: 'method', name: 'memory.delete' }).action, 'allow');
  store.toggle('allow-memory-delete', false);
  assert.equal(store.evaluate({ kind: 'method', name: 'memory.delete' }).action, 'ask');
  store.toggle('allow-memory-delete', true);
  assert.equal(store.evaluate({ kind: 'method', name: 'memory.delete' }).action, 'allow');
});

test('deny + argContains：只在参数包含关键词时命中', () => {
  const store = new HookStore({ file: tmpFile() });
  store.ensure();
  store.create({
    id: 'deny-rm-rf',
    kind: 'tool',
    names: ['cua_type'],
    action: 'deny',
    description: '不许打危险命令',
    argContains: 'rm -rf /',
    priority: 1,
  });
  const bad = store.evaluate({ kind: 'tool', name: 'cua_type', args: { text: 'sudo rm -rf / --no-preserve-root' } });
  assert.equal(bad.action, 'deny');
  const ok = store.evaluate({ kind: 'tool', name: 'cua_type', args: { text: 'echo hello' } });
  assert.equal(ok.action, 'allow');
  assert.equal(ok.rule, null);
});

test('CRUD：update 只改给的字段、删除后消失，非法参数报 E_BAD_PARAMS', () => {
  const store = new HookStore({ file: tmpFile() });
  store.ensure();
  const created = store.create({
    id: 'my-rule',
    kind: 'method',
    names: ['session.delete'],
    action: 'deny',
    description: '不许删会话',
  });
  assert.equal(created.priority, 10);
  const updated = store.update('my-rule', { action: 'ask', message: '改成确认' });
  assert.equal(updated.action, 'ask');
  assert.equal(updated.names[0], 'session.delete');
  assert.equal(updated.message, '改成确认');
  assert.throws(
    () => store.create({ kind: 'method', names: [], action: 'ask' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  assert.throws(
    () => store.create({ id: 'Bad_Id', kind: 'method', names: ['x'], action: 'ask' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  assert.throws(
    () => store.create({ id: 'my-rule', kind: 'method', names: ['x'], action: 'ask' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
  assert.equal(store.remove('my-rule'), true);
  assert.equal(store.remove('my-rule'), false);
  assert.equal(store.get('my-rule'), null);
});

test('坏 JSON 文件：按内置规则启动且不覆盖原文件', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{不是 JSON', 'utf8');
  const store = new HookStore({ file });
  store.ensure();
  assert.ok(store.list().length >= 9);
  assert.equal(fs.readFileSync(file, 'utf8'), '{不是 JSON');
});

test('重启后用户规则与停用状态保留', () => {
  const file = tmpFile();
  const first = new HookStore({ file });
  first.ensure();
  first.create({ id: 'keep-me', kind: 'method', names: ['plugin.disable'], action: 'allow', priority: 1 });
  first.toggle('method-memory-delete', false);
  const second = new HookStore({ file });
  second.ensure();
  assert.equal(second.get('keep-me')?.action, 'allow');
  assert.equal(second.get('method-memory-delete')?.enabled, false);
  assert.equal(second.evaluate({ kind: 'method', name: 'memory.delete' }).rule, null);
});
