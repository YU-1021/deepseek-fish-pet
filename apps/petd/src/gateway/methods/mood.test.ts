/**
 * mood.* 方法测试：注册、参数校验、status/history/adjust/poke、模型评估与事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError, type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { ChatStore } from '../../chat/store.js';
import type { CompleteOptions, LlmReply } from '../../llm/client.js';
import { messageText } from '../../llm/client.js';
import { MoodStore } from '../../state/mood.js';
import { registerMoodMethods, parseMoodJudge } from './mood.js';

function ctx(): GatewayContext {
  return {
    sessionId: 'test-session',
    client: { name: 'test', version: '0.0.1' },
    signal: new AbortController().signal,
    startedAt: Date.now(),
  } as unknown as GatewayContext;
}

class FakeLlm {
  readonly calls: CompleteOptions[] = [];
  reply = '```json\n{"mood":1,"affection":2,"energy":-1,"reason":"聊得很开心"}\n```';
  fail: Error | null = null;

  async complete(opts: CompleteOptions): Promise<LlmReply> {
    this.calls.push(opts);
    if (this.fail) throw this.fail;
    return { text: this.reply, model: 'fake-model', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
  }
}

interface Harness {
  reg: MethodRegistry;
  store: MoodStore;
  llm: FakeLlm;
  chats: ChatStore;
  events: Array<{ event: string; data: unknown }>;
  enabled: { value: boolean };
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mood-methods-'));
  let now = Date.now();
  const store = new MoodStore({ file: path.join(dir, 'mood.json'), now: () => now });
  store.ensure();
  const chats = new ChatStore({ dir: path.join(dir, 'sessions') });
  const session = chats.create('测试会话');
  chats.append(session.id, [
    { role: 'user', content: '今天好累啊', ts: new Date(now).toISOString() },
    { role: 'assistant', content: '那靠一会儿吧', ts: new Date(now).toISOString() },
  ]);
  const llm = new FakeLlm();
  const events: Array<{ event: string; data: unknown }> = [];
  const enabled = { value: true };
  const reg = new MethodRegistry();
  registerMoodMethods(reg, {
    store,
    llm: llm as never,
    chats,
    publish: (event, data) => events.push({ event, data }),
    enabled: () => enabled.value,
  });
  return { reg, store, llm, chats, events, enabled };
}

async function call(h: Harness, name: string, params: unknown): Promise<unknown> {
  const m = h.reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx());
}

test('注册 5 个 mood.* 方法，参数校验生效', async () => {
  const h = harness();
  assert.deepEqual(h.reg.names().filter((n) => n.startsWith('mood.')), [
    'mood.adjust',
    'mood.evaluate',
    'mood.history',
    'mood.poke',
    'mood.status',
  ]);
  assert.ok(h.reg.validate('mood.adjust', { mood: 200 }), 'mood 超上限应该校验失败');
  assert.equal(h.reg.validate('mood.adjust', { mood: -5, reason: '累了' }), null);
  assert.ok(h.reg.validate('mood.history', { limit: 0 }), 'limit 0 应校验失败');
});

test('status 返回快照与 enabled；disabled 时 enabled=false 但仍可读', async () => {
  const h = harness();
  h.enabled.value = false;
  const res = (await call(h, 'mood.status', {})) as { enabled: boolean; state: { mood: number; tiers: Record<string, string> } };
  assert.equal(res.enabled, false);
  assert.equal(res.state.mood, 70);
  assert.equal(res.state.tiers.mood, '心情不错');
});

test('adjust 修改数值、记历史并发 mood.changed；无变化不发事件', async () => {
  const h = harness();
  const res = (await call(h, 'mood.adjust', { mood: 5, reason: '被夸了' })) as { state: { mood: number }; applied: unknown[] };
  assert.equal(res.state.mood, 75);
  assert.equal(res.applied.length, 1);
  assert.equal(h.events.filter((e) => e.event === 'mood.changed').length, 1);
  const hist = (await call(h, 'mood.history', { limit: 5 })) as { entries: Array<{ key: string; reason: string }> };
  assert.equal(hist.entries[0]?.reason, '被夸了');
  const noop = (await call(h, 'mood.adjust', {})) as { applied: unknown[] };
  assert.equal(noop.applied.length, 0);
  assert.equal(h.events.filter((e) => e.event === 'mood.changed').length, 1);
});

test('poke 增心情/好感并发事件', async () => {
  const h = harness();
  const snap = (await call(h, 'mood.poke', {})) as { pokes: number; mood: number; affection: number };
  assert.equal(snap.pokes, 1);
  assert.equal(snap.mood, 71);
  assert.equal(snap.affection, 30.5);
  assert.equal(h.events.filter((e) => e.event === 'mood.changed').length, 1);
});

test('evaluate 用最近对话让模型给分并应用；事件带 source=llm', async () => {
  const h = harness();
  const res = (await call(h, 'mood.evaluate', {})) as { state: { mood: number; affection: number; energy: number }; applied: Array<{ source: string; key: string }> };
  assert.equal(res.applied.length, 3);
  assert.equal(res.state.mood, 71);
  assert.equal(res.state.affection, 32);
  assert.equal(res.state.energy, 79);
  assert.ok(res.applied.every((e) => e.source === 'llm'));
  const ev = h.events.find((e) => e.event === 'mood.changed');
  assert.ok(ev);
  assert.equal((ev?.data as { source: string }).source, 'llm');
  // 会话内容应被带进提示词
  assert.ok(h.llm.calls[0]?.messages.some((m) => messageText(m.content).includes('今天好累啊')));
});

test('evaluate 模型失败或输出不可解析 → E_INTERNAL；无会话 → E_NOT_FOUND', async () => {
  const h = harness();
  h.llm.fail = new Error('模型超时');
  await assert.rejects(() => call(h, 'mood.evaluate', {}), (e: unknown) => (e as PetdError).code === 'E_INTERNAL');
  h.llm.fail = null;
  h.llm.reply = '我觉得还行';
  await assert.rejects(() => call(h, 'mood.evaluate', {}), (e: unknown) => (e as PetdError).code === 'E_INTERNAL');

  const empty = new ChatStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mood-empty-')) });
  const reg = new MethodRegistry();
  registerMoodMethods(reg, {
    store: h.store,
    llm: h.llm as never,
    chats: empty,
    publish: () => {},
    enabled: () => true,
  });
  const m = reg.get('mood.evaluate');
  assert.ok(m);
  await assert.rejects(async () => { await m.handler({}, ctx()); }, (e: unknown) => (e as PetdError).code === 'E_NOT_FOUND');
});

test('parseMoodJudge：容忍代码围栏、非法 JSON 返回 null、数值钳制到 ±2', () => {
  assert.deepEqual(parseMoodJudge('```json\n{"mood":2,"affection":-1,"energy":0,"reason":"开心"}\n```'), {
    deltas: { mood: 2, affection: -1, energy: 0 },
    reason: '开心',
  });
  assert.equal(parseMoodJudge('抱歉我不会'), null);
  const clamped = parseMoodJudge('{"mood":9,"affection":-9,"energy":1.26}');
  assert.deepEqual(clamped?.deltas, { mood: 2, affection: -2, energy: 1.3 });
});
