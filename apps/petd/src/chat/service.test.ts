/**
 * ChatService 测试：建会话、历史裁剪、事件、失败路径。LLM 用假实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../kernel/events.js';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import type { CompleteOptions, LlmMessage, LlmReply } from '../llm/client.js';
import { messageText } from '../llm/client.js';
import { ChatStore } from './store.js';
import { ChatService, type ChatServiceOptions } from './service.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-chat-'));
}

class FakeLlm {
  readonly calls: LlmMessage[][] = [];
  fail: Error | null = null;

  async complete(opts: CompleteOptions): Promise<LlmReply> {
    this.calls.push(opts.messages.map((m) => ({ ...m })));
    if (this.fail) throw this.fail;
    return { text: '收到啦', model: 'fake-model', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
  }
}

interface Harness {
  dir: string;
  store: ChatStore;
  llm: FakeLlm;
  bus: EventBus;
  service: ChatService;
}

function makeHarness(chatOverrides: Partial<typeof DEFAULT_CONFIG.chat> = {}, extra: Partial<ChatServiceOptions> = {}): Harness {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  const llm = new FakeLlm();
  const bus = new EventBus(() => 123);
  const service = new ChatService({
    store,
    llm,
    chat: { ...DEFAULT_CONFIG.chat, ...chatOverrides },
    publish: (event, data) => {
      bus.emit(event, data);
    },
    systemPrompt: () => '你是大肥鱼',
    now: () => '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  return { dir, store, llm, bus, service };
}

test('新会话：自动建会话、首条消息做标题、持久化两条、发事件', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  h.bus.on('chat.user_message', () => seen.push('user'));
  h.bus.on('chat.assistant_message', () => seen.push('assistant'));
  h.bus.on('session.updated', () => seen.push('updated'));

  const res = await h.service.send({ text: '  主人今天也要加油  ' });
  assert.equal(res.session.title, '主人今天也要加油');
  assert.equal(res.session.messageCount, 2);
  assert.equal(res.userMessage.role, 'user');
  assert.equal(res.assistantMessage.content, '收到啦');
  assert.deepEqual(seen, ['updated', 'user', 'assistant', 'updated']);

  const session = h.store.get(res.session.id);
  assert.ok(session);
  assert.deepEqual(
    session.messages.map((m) => `${m.role}:${m.content}`),
    ['user:主人今天也要加油', 'assistant:收到啦']
  );
  assert.equal(h.llm.calls[0]?.[0]?.role, 'system');
  assert.equal(h.llm.calls[0]?.[0]?.content, '你是大肥鱼');
});

test('第二轮带历史，标题不变', async () => {
  const h = makeHarness();
  const first = await h.service.send({ text: '第一句' });
  const second = await h.service.send({ sessionId: first.session.id, text: '第二句' });

  assert.equal(second.session.title, '第一句');
  assert.equal(second.session.messageCount, 4);
  const lastCall = h.llm.calls[1] ?? [];
  assert.equal(lastCall.length, 4); // system + user + assistant + user
  assert.deepEqual(
    lastCall.map((m) => m.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.equal(lastCall[3]?.content, '第二句');
});

test('历史裁剪：maxHistoryMessages=2 时只带最后两条，且以 user 开头', async () => {
  const h = makeHarness({ maxHistoryMessages: 2 });
  const first = await h.service.send({ text: '一' });
  await h.service.send({ sessionId: first.session.id, text: '二' });
  await h.service.send({ sessionId: first.session.id, text: '三' });
  const lastCall = h.llm.calls[2] ?? [];
  assert.equal(lastCall.length, 4); // system + 2 条历史(user/assistant) + 新 user
  assert.deepEqual(
    lastCall.map((m) => m.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.equal(lastCall[1]?.content, '二');
  assert.equal(lastCall[2]?.content, '收到啦');
});

test('空消息与超长消息 → E_BAD_PARAMS', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.service.send({ text: '   ' }), { code: 'E_BAD_PARAMS' } as unknown as Error);
  await assert.rejects(() => h.service.send({ text: 'x'.repeat(8001) }), { code: 'E_BAD_PARAMS' } as unknown as Error);
});

test('LLM 失败：抛错、发 chat.failed、不落库', async () => {
  const h = makeHarness();
  const failed: unknown[] = [];
  h.bus.on('chat.failed', (ev) => failed.push(ev.data));
  h.llm.fail = Object.assign(new Error('模型超时'), { code: 'E_LLM_TIMEOUT' });

  await assert.rejects(() => h.service.send({ text: '你好' }), { code: 'E_LLM_TIMEOUT' } as unknown as Error);
  assert.equal(failed.length, 1);
  assert.equal(h.service.listSessions()[0]?.messageCount, 0);
});

test('会话不存在时 get/rename/delete 都报 E_NOT_FOUND', () => {
  const h = makeHarness();
  assert.throws(() => h.service.getSession('s-nope-000000'), { code: 'E_NOT_FOUND' } as unknown as Error);
  assert.throws(() => h.service.renameSession('s-nope-000000', 'x'), { code: 'E_NOT_FOUND' } as unknown as Error);
  assert.throws(() => h.service.deleteSession('s-nope-000000'), { code: 'E_NOT_FOUND' } as unknown as Error);
});

test('系统提示词拼接情绪段，一轮成功后触发 onTurnComplete', async () => {
  const turns: Array<{ sessionId: string; userText: string; assistantText: string }> = [];
  const h = makeHarness({}, {
    moodPrompt: () => '## 你现在的状态（心情不错）',
    onTurnComplete: (info) => {
      turns.push(info);
    },
  });
  const res = await h.service.send({ text: '今天好累' });
  const system = messageText(h.llm.calls[0]?.[0]?.content ?? '');
  assert.ok(system.includes('你是大肥鱼'));
  assert.ok(system.includes('## 你现在的状态'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.assistantText, res.assistantMessage.content);
});

test('onTurnComplete 抛错不影响回复，照常落库', async () => {
  const h = makeHarness({}, {
    onTurnComplete: () => {
      throw new Error('钩子坏了');
    },
  });
  const res = await h.service.send({ text: '你好呀' });
  assert.equal(res.assistantMessage.content, '收到啦');
  assert.equal(res.session.messageCount, 2);
});
