/**
 * PersonaStore：SOUL.md 唯一事实源 + 版本/锁/历史/回滚 + 外部手改检测。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PetdError } from '@petd/protocol';
import { PersonaStore, MAX_SECTION_CHARS, type PersonaStoreOptions } from './store.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-persona-'));
}

function makeStore(home = tmpHome(), legacy: PersonaStoreOptions['legacy'] = null): PersonaStore {
  let tick = 0;
  return new PersonaStore({
    home,
    file: 'SOUL.md',
    legacy,
    now: () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString(),
  });
}

const LEGACY = {
  name: '大肥鱼',
  identity: '蓝发鲸鱼女仆',
  world_setting: '现代都市，陪主人工作',
  character_setting: '傲娇、温柔、嘴硬',
  personality: ['傲娇', '温柔'],
  catchphrase: 'I am NOT a freeloader fat fish!',
  hidden_setting: '偷偷玩明日方舟',
};

test('ensure：无旧人格时播种内置 SOUL.md 与 state', () => {
  const store = makeStore();
  const r = store.ensure();
  assert.equal(r.createdSoul, true);
  assert.equal(r.createdState, true);
  assert.equal(fs.existsSync(store.soulFile), true);
  assert.equal(fs.existsSync(store.stateFile), true);
  const snap = store.read();
  assert.equal(snap.version, 1);
  assert.equal(snap.title, '大肥鱼');
  assert.ok(snap.sections.some((s) => s.key === 'character'));
  assert.ok(snap.sections.some((s) => s.key === 'speaking'));
  // 再 ensure 不覆盖
  const again = store.ensure();
  assert.equal(again.createdSoul, false);
  assert.equal(again.createdState, false);
});

test('ensure：旧 persona.json 播种出世界观/口头禅/隐藏设定', () => {
  const store = makeStore(tmpHome(), LEGACY);
  store.ensure();
  const snap = store.read();
  const keys = snap.sections.map((s) => s.key);
  for (const k of ['identity', 'worldview', 'character', 'catchphrase', 'hidden', 'speaking']) {
    assert.ok(keys.includes(k), `缺少小节 ${k}`);
  }
  assert.equal(snap.sections.find((s) => s.key === 'worldview')?.userOnly, true);
  assert.equal(snap.sections.find((s) => s.key === 'character')?.aiEditable, true);
  assert.ok(snap.content.includes('大肥鱼'));
});

test('patch：用户改小节 → 版本+1、落盘、历史记录', () => {
  const store = makeStore();
  store.ensure();
  const r = store.patch({ sections: { speaking: '- 现在说话更简短。' }, reason: '用户改说话方式' });
  assert.equal(r.changed, true);
  assert.equal(r.version, 2);
  assert.deepEqual(r.applied, ['speaking']);
  const snap = store.read();
  assert.equal(snap.version, 2);
  assert.ok(snap.content.includes('- 现在说话更简短。'));
  const history = store.history(5);
  assert.equal(history[0]?.version, 2);
  assert.equal(history[0]?.actor, 'user');
  assert.equal(history[0]?.reason, '用户改说话方式');
  assert.deepEqual(history[0]?.changedKeys, ['speaking']);
});

test('patch：内容未变 → skipped；未知小节 → rejected；空内容 → rejected', () => {
  const store = makeStore();
  store.ensure();
  const snap = store.read();
  const speaking = snap.sections.find((s) => s.key === 'speaking')!.content;
  const r = store.patch({ sections: { speaking, nope: 'x', character: '   ' } });
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped, ['speaking']);
  assert.ok(r.rejected.some((x) => x.key === 'nope'));
  assert.ok(r.rejected.some((x) => x.key === 'character'));
});

test('patch：agent 不能改世界观、只能改未上锁的 AI 小节', () => {
  const store = makeStore(tmpHome(), LEGACY);
  store.ensure();
  store.setLock('character', true);
  const r = store.patch({
    actor: 'agent',
    sections: { worldview: '新世界观', character: '改性格', speaking: '- 我学会新的说话方式。' },
  });
  assert.deepEqual(r.applied, ['speaking']);
  assert.deepEqual(r.skipped, ['character']);
  assert.ok(r.rejected.some((x) => x.key === 'worldview'));
  // 锁只约束 agent：用户仍可改
  const u = store.patch({ actor: 'user', sections: { character: '用户改的性格' } });
  assert.deepEqual(u.applied, ['character']);
});

test('setLock：世界观/未知 key 拒绝；解锁后 AI 可改', () => {
  const store = makeStore();
  store.ensure();
  assert.throws(() => store.setLock('worldview', true), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(() => store.setLock('nope', true), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  store.setLock('speaking', true);
  assert.equal(store.read().locks['speaking'], true);
  const a1 = store.patch({ actor: 'agent', sections: { speaking: '被锁住' } });
  assert.equal(a1.changed, false);
  store.setLock('speaking', false);
  const a2 = store.patch({ actor: 'agent', sections: { speaking: '- 解锁后的新语气。' } });
  assert.deepEqual(a2.applied, ['speaking']);
});

test('外部手改 SOUL.md：read 检测到 hash 不一致 → 升版本并记 user 历史', () => {
  const store = makeStore();
  store.ensure();
  fs.appendFileSync(store.soulFile, '\n## 备注\n主人手写的一行。\n', 'utf8');
  const snap = store.read();
  assert.equal(snap.version, 2);
  assert.ok(snap.sections.some((s) => s.key === 'custom:备注'));
  const h = store.history(3);
  assert.equal(h[0]?.version, 2);
  assert.equal(h[0]?.actor, 'user');
  assert.match(h[0]?.reason ?? '', /外部编辑/);
});

test('expectedVersion 不匹配 → E_CONFLICT', () => {
  const store = makeStore();
  store.ensure();
  store.patch({ sections: { speaking: '- v2' } });
  assert.throws(
    () => store.patch({ sections: { speaking: '- v3?' }, expectedVersion: 1 }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
  const ok = store.patch({ sections: { speaking: '- v3' }, expectedVersion: 2 });
  assert.equal(ok.version, 3);
});

test('rollback：回到历史版本内容，并把版本继续往上加', () => {
  const store = makeStore();
  store.ensure();
  store.patch({ sections: { speaking: '- v2 内容' } });
  const v2Content = store.read().content;
  store.patch({ sections: { speaking: '- v3 内容' } });
  const r = store.rollback(2);
  assert.equal(r.changed, true);
  assert.equal(r.version, 4);
  assert.equal(store.read().content, v2Content);
  assert.equal(store.read().version, 4);
});

test('超长小节被拒绝；超长总人格抛 E_BAD_PARAMS', () => {
  const store = makeStore(tmpHome(), LEGACY);
  store.ensure();
  const r = store.patch({ sections: { speaking: 'x'.repeat(MAX_SECTION_CHARS + 1) } });
  assert.equal(r.changed, false);
  assert.ok(r.rejected.some((x) => x.key === 'speaking' && /过长/.test(x.reason)));
  // 多小节叠加超过人格总长度上限（旧人格有 6 个小节，6×3990≈23940 > 20000）
  const big = 'y'.repeat(3990);
  assert.throws(
    () =>
      store.patch({
        actor: 'user',
        sections: {
          identity: big,
          worldview: big,
          character: big,
          catchphrase: big,
          hidden: big,
          speaking: big,
        },
      }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
});

test('parseSoul/renderSoul 往返：未知标题不丢', () => {
  const store = makeStore();
  store.ensure();
  fs.writeFileSync(store.soulFile, '# 标题\n\n前言一段。\n\n## 性格\nA\n\n## 自定义小节\nB\n', 'utf8');
  const snap = store.read();
  assert.equal(snap.title, '标题');
  assert.equal(snap.preamble, '前言一段。');
  const keys = snap.sections.map((s) => s.key);
  assert.ok(keys.includes('character'));
  assert.ok(keys.includes('custom:自定义小节'));
  const r = store.patch({ sections: { 'custom:自定义小节': 'B2' } });
  assert.deepEqual(r.applied, ['custom:自定义小节']);
  assert.ok(store.read().content.includes('B2'));
});
