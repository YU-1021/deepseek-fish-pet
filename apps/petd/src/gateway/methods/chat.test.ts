/**
 * chat.* 方法测试：注册、参数校验、chat.send 结果（含 handoff 字段）、chat.handoff 手动交接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { DEFAULT_CONFIG } from '../../kernel/config.js';
import type { CompleteOptions, LlmReply } from '../../llm/client.js';
import { ChatStore } from '../../chat/store.js';
import { ChatService, type HandoffIo } from '../../chat/service.js';
import { registerChatMethods } from './chat.js';

class FakeLlm {
  async complete(_opts: CompleteOptions): Promise<LlmReply> {
    return { text: '收到', model: 'fake', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
  }
}

function fakeIo(): HandoffIo {
  const files = new Map<string, string>();
  return {
    readFile: (relPath) => {
      const text = files.get(relPath);
      if (text === undefined) throw new Error('missing ' + relPath);
      return text;
    },
    writeFile: async (relPath, content) => {
      files.set(relPath, content);
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-chat-methods-'));
  const store = new ChatStore({ dir });
  const service = new ChatService({
    store,
    llm: new FakeLlm(),
    chat: { ...DEFAULT_CONFIG.chat, contextMaxTokens: 200, softRatio: 0.5, keepRatio: 0.15, maxToolRounds: 0 },
    publish: () => {},
    systemPrompt: () => '你是大肥鱼',
    handoffIo: fakeIo(),
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const reg = new MethodRegistry();
  registerChatMethods(reg, { chat: service });
  return { reg, service };
}

const ctx = {
  sessionId: 'test-session',
  client: { name: 'test', version: '0.0.1' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
} as unknown as GatewayContext;

async function call(reg: MethodRegistry, name: string, params: unknown): Promise<unknown> {
  const m = reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx);
}

test('注册 session.* + chat.send + chat.handoff，参数校验生效', () => {
  const { reg } = setup();
  const names = reg.names().filter((n) => n.startsWith('chat.') || n.startsWith('session.'));
  assert.deepEqual(names.sort(), [
    'chat.handoff',
    'chat.send',
    'session.create',
    'session.delete',
    'session.get',
    'session.list',
    'session.rename',
  ]);
  assert.ok(reg.validate('chat.send', { text: '' }), '空文本应校验失败');
  assert.equal(reg.validate('chat.send', { text: '你好' }), null);
  assert.ok(reg.validate('chat.handoff', {}), '缺 sessionId 应校验失败');
  assert.equal(reg.validate('chat.handoff', { sessionId: 's-1' }), null);
});

test('chat.send 结果带 tools 与 handoff 字段；chat.handoff 可手动整理', async () => {
  const { reg } = setup();
  const created = (await call(reg, 'session.create', { title: '交接测试' })) as { id: string };
  let last: any = null;
  for (let i = 0; i < 3; i += 1) {
    last = await call(reg, 'chat.send', { sessionId: created.id, text: '第' + i + '轮：' + 'x'.repeat(150) });
  }
  assert.ok(Array.isArray(last.tools));
  assert.equal(last.handoff, null, '第三轮历史 4 条，还不够触发（至少 6 条）');

  const act = (await call(reg, 'chat.handoff', { sessionId: created.id })) as {
    file: string;
    compressed: number;
    kept: number;
  };
  assert.ok(act.file.startsWith('handoffs/'));
  assert.equal(act.compressed, 4);
  assert.equal(act.kept, 2);

  const got = (await call(reg, 'session.get', { sessionId: created.id })) as {
    session: { contextStart?: number; handoffFiles?: string[] };
  };
  assert.equal(got.session.contextStart, 4);
  assert.deepEqual(got.session.handoffFiles, [act.file]);
});
