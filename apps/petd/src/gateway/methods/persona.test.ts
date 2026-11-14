/**
 * persona.* 网关方法：参数校验、用户/AI 两种 actor、广播 persona.changed。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { PersonaStore } from '../../persona/store.js';
import { registerPersonaMethods, type PersonaMethodDeps } from './persona.js';
import type { EvolveResult } from '../../persona/evolve.js';

const EVOLVED: EvolveResult = {
  changed: true,
  reason: '最近经历让语气更自然',
  version: 2,
  applied: ['speaking'],
  skipped: [],
  rejected: [],
};

interface Setup {
  store: PersonaStore;
  registry: MethodRegistry;
  published: Array<{ event: string; data: unknown }>;
  evolveInputs: Array<{ sessionId?: string; signal?: AbortSignal }>;
  ctx: GatewayContext;
  invoke(name: string, params?: unknown): Promise<unknown>;
}

function setup(opts: { evolveResult?: EvolveResult; legacy?: boolean } = {}): Setup {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-persona-api-'));
  const store = new PersonaStore({
    home,
    file: 'SOUL.md',
    legacy: opts.legacy ? { name: '大肥鱼', world_setting: '现代都市' } : null,
  });
  store.ensure();
  const registry = new MethodRegistry();
  const published: Setup['published'] = [];
  const evolveInputs: Setup['evolveInputs'] = [];
  const deps: PersonaMethodDeps = {
    store,
    evolve: async (input) => {
      evolveInputs.push(input);
      return opts.evolveResult ?? EVOLVED;
    },
    publish: (event, data) => published.push({ event, data }),
  };
  registerPersonaMethods(registry, deps);
  const controller = new AbortController();
  const ctx: GatewayContext = {
    sessionId: 'sess-test',
    client: { name: 'test', version: '0.0.0' },
    signal: controller.signal,
    startedAt: Date.now(),
  };
  return {
    store,
    registry,
    published,
    evolveInputs,
    ctx,
    async invoke(name, params) {
      const m = registry.requireMethod(name);
      const bad = registry.validate(name, params);
      if (bad) throw new PetdError('E_BAD_PARAMS', bad.message);
      return await m.handler(params ?? {}, ctx);
    },
  };
}

test('注册 6 个 persona 方法，命名/scope 正确', () => {
  const s = setup();
  const names = s.registry.names().filter((n) => n.startsWith('persona.'));
  assert.deepEqual(names, [
    'persona.evolve',
    'persona.get',
    'persona.history',
    'persona.lock',
    'persona.patch',
    'persona.rollback',
  ]);
  assert.equal(s.registry.scopeOf('persona.get'), 'read');
  assert.equal(s.registry.scopeOf('persona.patch'), 'write');
  assert.equal(s.registry.get('persona.evolve')?.descriptor.timeoutMs, 120_000);
});

test('persona.get：返回完整快照', async () => {
  const s = setup();
  const snap = (await s.invoke('persona.get')) as { version: number; content: string; sections: unknown[] };
  assert.equal(snap.version, 1);
  assert.ok(snap.content.includes('大肥鱼'));
  assert.ok(Array.isArray(snap.sections));
});

test('persona.patch：用户改小节 → 落盘 + 广播 persona.changed', async () => {
  const s = setup();
  const r = (await s.invoke('persona.patch', { sections: { speaking: '- 新的说话方式。' }, reason: '手动改' })) as {
    changed: boolean;
    version: number;
  };
  assert.equal(r.changed, true);
  assert.equal(r.version, 2);
  assert.equal(s.store.read().version, 2);
  assert.equal(s.published.length, 1);
  assert.equal(s.published[0]?.event, 'persona.changed');
  const data = s.published[0]?.data as { actor: string; version: number; applied: string[] };
  assert.equal(data.actor, 'user');
  assert.deepEqual(data.applied, ['speaking']);
});

test('persona.patch：expectedVersion 冲突 → E_CONFLICT', async () => {
  const s = setup();
  await s.invoke('persona.patch', { sections: { speaking: '- v2' } });
  await assert.rejects(
    () => s.invoke('persona.patch', { sections: { speaking: '- v3?' }, expectedVersion: 1 }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
});

test('persona.lock：上锁/解锁并广播；世界观报 E_BAD_PARAMS', async () => {
  const s = setup();
  const r = (await s.invoke('persona.lock', { key: 'speaking', locked: true })) as {
    locks: Record<string, boolean>;
  };
  assert.equal(r.locks['speaking'], true);
  assert.equal(s.store.read().locks['speaking'], true);
  await assert.rejects(
    () => s.invoke('persona.lock', { key: 'worldview', locked: true }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
});

test('persona.history / persona.rollback', async () => {
  const s = setup();
  const v1 = s.store.read();
  await s.invoke('persona.patch', { sections: { speaking: '- v2 内容' } });
  const h = (await s.invoke('persona.history', { limit: 5 })) as { revisions: Array<{ version: number; actor: string }> };
  assert.equal(h.revisions[0]?.version, 2);
  assert.equal(h.revisions[0]?.actor, 'user');
  const r = (await s.invoke('persona.rollback', { version: 1 })) as { version: number };
  assert.equal(r.version, 3);
  assert.equal(s.store.read().content, v1.content);
});

test('persona.evolve：把 sessionId/signal 传给 evolve 并广播 agent 改动', async () => {
  const s = setup();
  const r = (await s.invoke('persona.evolve', { sessionId: 'sess-1' })) as {
    changed: boolean;
    applied: string[];
  };
  assert.equal(r.changed, true);
  assert.deepEqual(r.applied, ['speaking']);
  assert.equal(s.evolveInputs.length, 1);
  assert.equal(s.evolveInputs[0]?.sessionId, 'sess-1');
  assert.equal(s.evolveInputs[0]?.signal, s.ctx.signal);
  const published = s.published.find((p) => p.event === 'persona.changed');
  assert.ok(published);
  assert.equal((published!.data as { actor: string }).actor, 'agent');
});

test('persona.evolve：没改动就不广播', async () => {
  const s = setup({
    evolveResult: { changed: false, reason: '无需改动', version: 1, applied: [], skipped: [], rejected: [] },
  });
  const r = (await s.invoke('persona.evolve', {})) as { changed: boolean };
  assert.equal(r.changed, false);
  assert.equal(s.published.length, 0);
});
