/**
 * 聊天附件测试：附件句柄只拼进这一轮模型输入，不进会话正文；错误输入提前拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import type { CompleteOptions, LlmMessage, LlmReply } from '../llm/client.js';
import { messageText } from '../llm/client.js';
import { WorkspaceMemory } from '../memory/store.js';
import { BlobStore } from '../memory/blob.js';
import { ChatStore } from './store.js';
import { ChatService } from './service.js';

class FakeLlm {
  readonly calls: LlmMessage[][] = [];
  async complete(opts: CompleteOptions): Promise<LlmReply> {
    this.calls.push(opts.messages.map((m) => ({ ...m })));
    return { text: '看到了', model: 'fake', usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } };
  }
}

function makeHarness(): { service: ChatService; store: ChatStore; llm: FakeLlm; blobs: BlobStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-attach-'));
  const memory = new WorkspaceMemory({ dir: path.join(dir, 'workspace') });
  const blobs = new BlobStore(memory);
  blobs.ensure();
  const store = new ChatStore({ dir: path.join(dir, 'sessions') });
  const llm = new FakeLlm();
  const service = new ChatService({
    store,
    llm,
    chat: DEFAULT_CONFIG.chat,
    publish: () => {},
    systemPrompt: () => '你是大肥鱼',
    blobs,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { service, store, llm, blobs };
}

test('带附件：句柄进模型输入、不进会话正文、结果回附件元数据', async () => {
  const { service, store, llm, blobs } = makeHarness();
  const meta = blobs.put({ data: Buffer.from('截图内容'), name: '桌面截图.png' });

  const result = await service.send({ text: '看看这个', attachments: [meta.handle] });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.handle, meta.handle);

  const lastCall = llm.calls.at(-1) ?? [];
  const userMsg = lastCall.at(-1);
  assert.equal(userMsg?.role, 'user');
  assert.ok(userMsg);
  const userContent = messageText(userMsg.content);
  assert.ok(userContent.includes('看看这个'));
  assert.ok(userContent.includes(meta.handle));
  assert.ok(userContent.includes('[用户发来的附件]'));
  assert.ok(userContent.includes('桌面截图.png'));

  // 会话里只存原始正文，附件提示不进历史
  const session = store.get(result.session.id);
  const storedUser = session?.messages.find((m) => m.role === 'user');
  assert.equal(storedUser?.content, '看看这个');

  // 下一轮历史里也不会重复带附件块
  await service.send({ sessionId: result.session.id, text: '继续' });
  const secondCall = llm.calls.at(-1) ?? [];
  assert.equal(secondCall.at(-1)?.content, '继续');
});

test('附件不存在 / 超过 10 个：提前拒绝且不调模型', async () => {
  const { service, llm } = makeHarness();
  await assert.rejects(
    () => service.send({ text: '看看', attachments: ['blob:does-not-exist.txt'] }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND'
  );
  assert.equal(llm.calls.length, 0);

  const refs = Array.from({ length: 11 }, (_, i) => 'blob:' + i + '.txt');
  await assert.rejects(
    () => service.send({ text: '看看', attachments: refs }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
});
