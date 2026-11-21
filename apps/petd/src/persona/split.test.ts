/**
 * 人格分层：SOUL.md 内核（人改）+ SOUL.agent.md 外圈（AI 改）+ 合并读取。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PersonaStore, SOUL_AGENT_FILE, type PersonaStoreOptions } from './store.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-persona-split-'));
}

function makeStore(home = tmpHome(), legacy: PersonaStoreOptions['legacy'] = null): PersonaStore {
  const store = new PersonaStore({ home, file: 'SOUL.md', legacy });
  store.ensure();
  return store;
}

const SPEAKING = '## 说话方式\n简短、带一点嘴硬。\n';

test('ensure：内核与外圈都创建；外圈初始为空', () => {
  const home = tmpHome();
  const store = makeStore(home);
  assert.equal(fs.existsSync(store.soulFile), true);
  assert.equal(fs.existsSync(store.agentSoulFile), true);
  assert.equal(path.basename(store.agentSoulFile), SOUL_AGENT_FILE);
  assert.equal(fs.readFileSync(store.agentSoulFile, 'utf8'), '');
  assert.equal(store.read().hasAgentOverrides, false);
});

test('agent patch 只写外圈，内核字节不变，合并读取生效', () => {
  const store = makeStore();
  const coreBefore = fs.readFileSync(store.soulFile, 'utf8');
  const r = store.patch({ actor: 'agent', sections: { speaking: '我现在说话更简短。' }, reason: '相处久了' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.applied, ['speaking']);
  assert.equal(fs.readFileSync(store.soulFile, 'utf8'), coreBefore, '内核不能被 agent 改');
  const agentText = fs.readFileSync(store.agentSoulFile, 'utf8');
  assert.match(agentText, /我现在说话更简短/);
  const snap = store.read();
  assert.match(snap.content, /我现在说话更简短/);
  assert.equal(snap.hasAgentOverrides, true);
  const speaking = snap.sections.find((s) => s.key === 'speaking');
  assert.equal(speaking?.source, 'agent');
});

test('用户改同一小节：清掉外圈覆盖，用户值生效', () => {
  const store = makeStore();
  store.patch({ actor: 'agent', sections: { speaking: 'agent 的版本' } });
  store.patch({ actor: 'user', sections: { speaking: '用户拍板的版本' } });
  const snap = store.read();
  assert.match(snap.content, /用户拍板的版本/);
  assert.doesNotMatch(snap.content, /agent 的版本/);
  assert.equal(snap.hasAgentOverrides, false);
  assert.match(fs.readFileSync(store.soulFile, 'utf8'), /用户拍板的版本/);
  assert.equal(fs.readFileSync(store.agentSoulFile, 'utf8').trim(), '');
});

test('用户改别的小节：外圈覆盖保留', () => {
  const store = makeStore();
  store.patch({ actor: 'agent', sections: { speaking: 'agent 语气' } });
  store.patch({ actor: 'user', sections: { character: '用户改的性格' } });
  const snap = store.read();
  assert.match(snap.content, /agent 语气/);
  assert.match(snap.content, /用户改的性格/);
  assert.equal(snap.hasAgentOverrides, true);
});

test('回滚：快照写回内核并清空外圈，合并结果等于历史版本', () => {
  const store = makeStore();
  const v1 = store.read();
  store.patch({ actor: 'agent', sections: { speaking: '外圈一' } });
  const v2 = store.read();
  store.patch({ actor: 'agent', sections: { speaking: '外圈二' } });
  const r = store.rollback(v1.version + 1);
  assert.equal(r.changed, true);
  const snap = store.read();
  assert.equal(snap.content, v2.content);
  assert.equal(fs.readFileSync(store.agentSoulFile, 'utf8'), '');
});

test('外部手改外圈文件：read 检测到 hash 变化并升版本', () => {
  const store = makeStore();
  const before = store.read().version;
  fs.appendFileSync(store.agentSoulFile, SPEAKING, 'utf8');
  const after = store.read();
  assert.equal(after.hasAgentOverrides, true);
  assert.equal(after.version, before + 1);
  assert.ok(store.history(5).some((h) => h.reason.includes('外部编辑')));
});

test('锁与世界观：锁只约束 AI，世界观仍拒绝 agent', () => {
  const store = makeStore();
  store.setLock('speaking', true);
  const locked = store.patch({ actor: 'agent', sections: { speaking: '被锁住' } });
  assert.deepEqual(locked.skipped, ['speaking']);
  store.setLock('speaking', false);
  const denied = store.patch({ actor: 'agent', sections: { worldview: 'AI 想改世界观' } });
  assert.ok(denied.rejected.some((x) => x.key === 'worldview'));
});
