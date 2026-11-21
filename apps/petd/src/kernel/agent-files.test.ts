/**
 * AI 可写文件白名单（自我迭代安全边界 INV-1/2/7）：
 * 带 .agent.* 后缀 + 指定目录才允许 AI 写；记忆区 workspace/** 是数据区。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PetdError } from '@petd/protocol';
import {
  AGENT_FILE_MARK,
  assertAgentWritable,
  agentWritePolicy,
  describeAgentWriteScope,
  isAgentFileName,
} from './agent-files.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-agentfiles-'));
}

test('文件名判定：只有 `.agent.<ext>` 才算动态文件', () => {
  assert.equal(AGENT_FILE_MARK, '.agent.');
  assert.equal(isAgentFileName('SOUL.agent.md'), true);
  assert.equal(isAgentFileName('preferences.agent.json'), true);
  assert.equal(isAgentFileName('SOUL.md'), false);
  assert.equal(isAgentFileName('agent.md'), false);
  assert.equal(isAgentFileName('skills.agent.md.bak'), false);
});

test('允许：记忆区任意文件名', () => {
  const home = tmpHome();
  for (const rel of ['workspace/partner/notes.md', 'workspace/log/2026-11.md', 'workspace/随便 名字.txt']) {
    const p = agentWritePolicy(home, rel);
    assert.equal(p.ok, true, rel);
    assert.equal(p.zone, 'memory');
  }
});

test('允许：白名单目录里的 .agent.* 文件', () => {
  const home = tmpHome();
  const allowed = ['SOUL.agent.md', 'learning/preferences.agent.json', 'proposals/faster-reply.agent.md', 'skills/staging/poem.agent.md'];
  for (const rel of allowed) {
    const p = agentWritePolicy(home, rel);
    assert.equal(p.ok, true, rel);
    assert.equal(p.zone, 'agent-file');
    assert.equal(path.isAbsolute(p.abs), true);
  }
});

test('拒绝：没后缀、错误目录、代码/配置/状态/正式技能', () => {
  const home = tmpHome();
  const denied = [
    'SOUL.md',
    'persona-state.json',
    'config.json',
    'secrets.json',
    'token.json',
    'state/mood.json',
    'skills/morning/SKILL.md',
    'plugins/demo/plugin.json',
    'notes.agent.md',
    'skills/formal.agent.md',
    'apps/petd/src/index.ts',
  ];
  for (const rel of denied) {
    const p = agentWritePolicy(home, rel);
    assert.equal(p.ok, false, rel);
    assert.equal(p.zone, null);
    assert.ok(p.reason && p.reason.length > 0, rel);
  }
});

test('拒绝：路径逃逸 home 与非法片段', () => {
  const home = tmpHome();
  const outside = agentWritePolicy(home, path.join(home, '..', 'escape.md'));
  assert.equal(outside.ok, false);
  assert.match(outside.reason ?? '', /home/);
  const dotdot = agentWritePolicy(home, 'workspace/../config.json');
  assert.equal(dotdot.ok, false);
});

test('assertAgentWritable：拒绝时抛 E_FORBIDDEN，允许时返回绝对路径', () => {
  const home = tmpHome();
  assert.throws(
    () => assertAgentWritable(home, 'config.json'),
    (err: unknown) => err instanceof PetdError && err.code === 'E_FORBIDDEN',
  );
  const abs = assertAgentWritable(home, 'learning/x.agent.json');
  assert.equal(abs, path.join(home, 'learning', 'x.agent.json'));
  assert.throws(() => assertAgentWritable(home, path.join(home, '..', 'x.md')), PetdError);
});

test('describeAgentWriteScope：能说清「能改的加后缀」', () => {
  const text = describeAgentWriteScope();
  assert.match(text, /\.agent/);
  assert.match(text, /workspace/);
  assert.match(text, /只读/);
});
