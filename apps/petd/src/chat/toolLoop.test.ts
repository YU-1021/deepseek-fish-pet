/**
 * ChatService 工具循环测试：模型主动调记忆工具 → 结果回灌 → 最终文本落库。
 * LLM 用脚本化假实现，记忆工具跑在临时工作区（真 Git 可选）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../kernel/events.js';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import type { CompleteOptions, LlmReply } from '../llm/client.js';
import { WorkspaceMemory } from '../memory/store.js';
import { WorkspaceGit } from '../memory/git.js';
import { MemoryService } from '../memory/service.js';
import { MemoryToolbox } from './tools.js';
import { ChatStore } from './store.js';
import { ChatService } from './service.js';

class ScriptedLlm {
  readonly calls: CompleteOptions[] = [];
  readonly replies: LlmReply[] = [];

  constructor(replies: LlmReply[]) {
    this.replies = [...replies];
  }

  async complete(opts: CompleteOptions): Promise<LlmReply> {
    this.calls.push(opts);
    const next = this.replies.shift();
    if (!next) throw new Error('脚本里的假回复用完了');
    return next;
  }
}

function reply(text: string, toolCalls?: LlmReply['toolCalls']): LlmReply {
  return {
    text,
    model: 'scripted',
    usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function tmpService(): MemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-loop-'));
  const memory = new WorkspaceMemory({ dir });
  const git = new WorkspaceGit(dir);
  const service = new MemoryService({ memory, git, version: 'test', logger: { info() {}, warn() {} } });
  service.ensure();
  return service;
}

interface Harness {
  bus: EventBus;
  store: ChatStore;
  llm: ScriptedLlm;
  service: ChatService;
  memory: MemoryService;
  toolbox: MemoryToolbox;
}

function makeHarness(llm: ScriptedLlm, chatOverrides: Partial<typeof DEFAULT_CONFIG.chat> = {}, memory: MemoryService = tmpService()): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-loop-chat-'));
  const store = new ChatStore({ dir });
  const bus = new EventBus(() => 123);
  const toolbox = new MemoryToolbox({ service: memory, maxWrites: chatOverrides.maxToolWrites ?? 3, maxResultChars: 4000 });
  const service = new ChatService({
    store,
    llm,
    chat: { ...DEFAULT_CONFIG.chat, maxToolRounds: 4, maxToolWrites: 3, ...chatOverrides },
    publish: (event, data) => bus.emit(event, data),
    systemPrompt: () => '你是大肥鱼',
    toolbox: () => toolbox,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { bus, store, llm, service, memory, toolbox };
}

test('模型先调工具再回复：工具结果回灌、事件广播、只落库最终文本', async () => {
  const memory = tmpService();
  await memory.write('MEMORY.md', '# 记忆\n主人喜欢猫。\n');
  const llm = new ScriptedLlm([
    reply('', [
      { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'MEMORY.md' }) },
    ]),
    reply('主人喜欢猫呀，我记住了。'),
  ]);
  const h = makeHarness(llm, {}, memory);
  const toolEvents: unknown[] = [];
  h.bus.on('chat.tool', (ev) => toolEvents.push(ev.data));

  const res = await h.service.send({ text: '我喜欢什么？' });
  assert.equal(res.reply.text, '主人喜欢猫呀，我记住了。');
  assert.equal(res.tools.length, 1);
  assert.equal(res.tools[0]?.name, 'read_file');
  assert.equal(res.tools[0]?.ok, true);
  assert.match(res.tools[0]?.text ?? '', /主人喜欢猫/);
  assert.equal(toolEvents.length, 1);

  // 第二次调用带了 assistant(toolCalls) + role:tool
  const second = llm.calls[1]?.messages ?? [];
  const roles = second.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);
  assert.equal(second[2]?.toolCalls?.[0]?.id, 'c1');
  assert.equal(second[3]?.toolCallId, 'c1');

  // 会话里只有 user + 最终 assistant，工具过程不落库
  const stored = h.store.get(res.session.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.messages.map((m) => `${m.role}:${m.content}`),
    ['user:我喜欢什么？', 'assistant:主人喜欢猫呀，我记住了。']
  );
  // 跨轮 usage 聚合
  assert.equal(res.reply.usage.totalTokens, 26);
});

test('模型让写记忆：写成功后下一轮回复；工作区里真的有文件', async () => {
  const llm = new ScriptedLlm([
    reply('', [
      { id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'partner/作息.md', content: '主人常熬夜到一点。\n' }) },
    ]),
    reply('好，我记住了你常熬夜。'),
  ]);
  const h = makeHarness(llm);
  const res = await h.service.send({ text: '记一下：我常熬夜到一点' });
  assert.equal(res.tools[0]?.ok, true);
  assert.equal(h.memory.read('partner/作息.md').content, '主人常熬夜到一点。\n');
  assert.equal(res.session.messageCount, 2);
});

test('工具报错也回灌给模型，让模型自己纠正', async () => {
  const llm = new ScriptedLlm([
    reply('', [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: '不存在.md' }) }]),
    reply('那个文件还没建，我写一份吧。'),
  ]);
  const h = makeHarness(llm);
  const res = await h.service.send({ text: '读一下 不存在.md' });
  assert.equal(res.tools[0]?.ok, false);
  const toolMsg = llm.calls[1]?.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg?.content ?? '', /错误（E_NOT_FOUND）/);
});

test('写配额生效：一轮内写超过 maxToolWrites 的后续写被拒绝', async () => {
  const calls = [1, 2, 3, 4].map((i) => ({
    id: `w${i}`,
    name: 'write_file',
    arguments: JSON.stringify({ path: `n${i}.md`, content: String(i) }),
  }));
  const llm = new ScriptedLlm([reply('', calls), reply('写完啦。')]);
  const h = makeHarness(llm, { maxToolWrites: 2 });
  const res = await h.service.send({ text: '写四个文件' });
  assert.equal(res.tools.length, 4);
  assert.deepEqual(res.tools.map((t) => t.ok), [true, true, false, false]);
  assert.equal(h.toolbox.writes, 2);
});

test('轮数用尽仍只有工具调用 → E_LLM_EMPTY，且落库空会话主题仍在', async () => {
  const toolCall = { id: 'c1', name: 'list_files', arguments: '{}' };
  const llm = new ScriptedLlm([reply('', [toolCall]), reply('', [toolCall])]);
  const h = makeHarness(llm, { maxToolRounds: 1 });
  const failed: unknown[] = [];
  h.bus.on('chat.failed', (ev) => failed.push(ev.data));
  await assert.rejects(() => h.service.send({ text: '翻翻记忆' }), { code: 'E_LLM_EMPTY' } as unknown as Error);
  assert.equal(failed.length, 1);
  assert.equal(llm.calls.length, 2);
});

test('maxToolRounds=0 时不声明工具（tools 字段不下发）', async () => {
  const llm = new ScriptedLlm([reply('直接回答。')]);
  const h = makeHarness(llm, { maxToolRounds: 0 });
  const res = await h.service.send({ text: '你好' });
  assert.equal(res.reply.text, '直接回答。');
  assert.equal(llm.calls[0]?.tools, undefined);
});
