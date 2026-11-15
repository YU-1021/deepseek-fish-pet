/**
 * 暂停门接入 ChatService 的测试：暂停后聊天直接拒绝，恢复后继续。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../kernel/events.js';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import { PauseGate } from '../kernel/pause.js';
import type { CompleteOptions, LlmReply } from '../llm/client.js';
import { ChatStore } from './store.js';
import { ChatService } from './service.js';

class FakeLlm {
  calls = 0;
  async complete(_opts: CompleteOptions): Promise<LlmReply> {
    this.calls += 1;
    return { text: '收到啦', model: 'fake-model', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
  }
}

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-pause-'));
  const store = new ChatStore({ dir });
  const llm = new FakeLlm();
  const bus = new EventBus(() => 123);
  const pauseGate = new PauseGate({ now: () => 1 });
  const service = new ChatService({
    store,
    llm,
    chat: DEFAULT_CONFIG.chat,
    publish: (event, data) => {
      bus.emit(event, data);
    },
    systemPrompt: () => '你是大肥鱼',
    pauseGate,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { dir, llm, pauseGate, service };
}

test('暂停时 chat.send 直接拒绝，不调用模型', async () => {
  const h = makeHarness();
  h.pauseGate.pause('用户暂停了运行');
  await assert.rejects(h.service.send({ text: '在吗' }), /运行已暂停/);
  assert.equal(h.llm.calls, 0);
});

test('恢复后正常聊天', async () => {
  const h = makeHarness();
  h.pauseGate.pause('暂停');
  h.pauseGate.resume();
  const res = await h.service.send({ text: '在吗' });
  assert.equal(res.assistantMessage.content, '收到啦');
  assert.equal(h.llm.calls, 1);
});

test('暂停原因写进错误信息', async () => {
  const h = makeHarness();
  h.pauseGate.pause('正在装系统');
  await assert.rejects(h.service.send({ text: '看下屏幕' }), /正在装系统/);
});
