/**
 * 交接笔记测试：渲染/预算/路径、ChatService 自动交接、手动交接、store 元数据持久化。
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
import { ChatService, type HandoffIo } from './service.js';
import { estimateTokens, handoffPath, handoffStamp, renderHandoffNote } from './handoff.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-handoff-'));
}

class FakeLlm {
  readonly calls: LlmMessage[][] = [];
  /** 非 null 时「记忆整理员」那次调用返回这段摘要正文 */
  summaryText: string | null = null;
  /** 非 null 时「记忆整理员」那次调用直接抛错 */
  summaryError: Error | null = null;

  async complete(opts: CompleteOptions): Promise<LlmReply> {
    this.calls.push(opts.messages.map((m) => ({ ...m })));
    const system = typeof opts.messages[0]?.content === 'string' ? opts.messages[0].content : '';
    if (system.includes('记忆整理员')) {
      if (this.summaryError) throw this.summaryError;
      return {
        text: this.summaryText ?? '收到',
        model: 'fake',
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      };
    }
    return { text: '收到', model: 'fake', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
  }
}

function fakeIo(): HandoffIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (relPath) => {
      const text = files.get(relPath);
      if (text === undefined) throw new Error('no such file: ' + relPath);
      return text;
    },
    writeFile: async (relPath, content) => {
      files.set(relPath, content);
    },
  };
}

interface Harness {
  store: ChatStore;
  llm: FakeLlm;
  bus: EventBus;
  io: ReturnType<typeof fakeIo>;
  service: ChatService;
}

function makeHarness(chatOverrides: Partial<typeof DEFAULT_CONFIG.chat> = {}): Harness {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  const llm = new FakeLlm();
  const bus = new EventBus(() => 123);
  const io = fakeIo();
  const service = new ChatService({
    store,
    llm,
    chat: { ...DEFAULT_CONFIG.chat, ...chatOverrides },
    publish: (event, data) => {
      bus.emit(event, data);
    },
    systemPrompt: () => '你是大肥鱼',
    handoffIo: io,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { store, llm, bus, io, service };
}

test('estimateTokens / handoffStamp / handoffPath', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('x'.repeat(30)), 10);
  const stamp = handoffStamp(new Date('2026-11-15T08:10:00.000Z'));
  assert.equal(stamp, '2026-11-15T08-10-00Z');
  assert.ok(!/[:.]/.test(stamp));
  assert.equal(handoffPath('handoffs', new Date('2026-11-15T08:10:00.000Z')), 'handoffs/2026-11-15T08-10-00Z.md');
  assert.equal(handoffPath('/handoffs/', new Date('2026-11-15T08:10:00.000Z')), 'handoffs/2026-11-15T08-10-00Z.md');
});

test('renderHandoffNote：抬头/时间/条目，超预算折叠更早的', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: '第' + i + '条：' + '内容'.repeat(40),
    ts: '2026-01-01T00:' + String(i).padStart(2, '0') + ':00.000Z',
  }));
  const rendered = renderHandoffNote({ messages, maxChars: 2000, sessionTitle: '测试会话' });
  assert.ok(rendered.content.startsWith('# 交接笔记 '));
  assert.ok(rendered.content.includes('测试会话'));
  assert.ok(rendered.content.includes('→'));
  assert.equal(rendered.entries + rendered.folded, 20);
  assert.ok(rendered.folded > 0, '预算 2000 字符应折叠掉一部分');
  assert.ok(rendered.content.length <= 2000 + 80);
  assert.ok(rendered.content.includes('条已折叠'));

  const empty = renderHandoffNote({ messages: [], maxChars: 2000 });
  assert.equal(empty.entries, 0);
  assert.equal(empty.folded, 0);
});

test('store.update：contextStart / lastPromptTokens / handoffFiles 落盘', () => {
  const store = new ChatStore({ dir: tmpDir() });
  const meta = store.create('t');
  const updated = store.update(meta.id, {
    contextStart: 3,
    lastPromptTokens: 1234,
    handoffFiles: ['handoffs/a.md', 'handoffs/b.md', 'handoffs/c.md', 'handoffs/d.md'],
  });
  assert.ok(updated);
  assert.equal(updated.contextStart, 3);
  assert.equal(updated.lastPromptTokens, 1234);
  assert.deepEqual(updated.handoffFiles, ['handoffs/a.md', 'handoffs/b.md', 'handoffs/c.md']);
  const reread = store.get(meta.id);
  assert.equal(reread?.contextStart, 3);
  assert.equal(reread?.handoffFiles?.length, 3);
});

test('自动交接：超软阈值写笔记、前移 contextStart、广播 chat.handoff', async () => {
  const h = makeHarness({ contextMaxTokens: 200, softRatio: 0.5, keepRatio: 0.15, handoffNoteMaxChars: 2000, maxToolRounds: 0 });
  const seen: unknown[] = [];
  h.bus.on('chat.handoff', (ev) => seen.push(ev.data));

  const first = await h.service.send({ text: '开始' });
  // 直接补 18 条长历史，模拟「聊了很久」
  h.store.append(
    first.session.id,
    Array.from({ length: 18 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '第' + i + '条：' + 'x'.repeat(400),
      ts: '2026-01-01T00:00:00.000Z',
    }))
  );

  const last = await h.service.send({ sessionId: first.session.id, text: '现在呢' });
  assert.ok(last.handoff, '应触发交接');
  assert.equal(last.handoff.compressed, 18);
  assert.equal(last.handoff.kept, 2);
  assert.ok(last.handoff.file.startsWith('handoffs/'));
  assert.ok(last.handoff.tokensAfter < last.handoff.tokensBefore);
  assert.equal(h.io.files.size, 1);
  assert.ok(h.io.files.get(last.handoff.file)?.startsWith('# 交接笔记'));
  assert.equal(seen.length, 1);

  const meta = h.store.get(first.session.id);
  assert.equal(meta?.contextStart, 18);
  assert.deepEqual(meta?.handoffFiles, [last.handoff.file]);
  assert.equal(typeof meta?.lastPromptTokens, 'number');
});

test('交接后下一轮：system 段带交接笔记，历史从 contextStart 开始', async () => {
  const h = makeHarness({ contextMaxTokens: 200, softRatio: 0.5, keepRatio: 0.15, handoffNoteMaxChars: 2000, maxToolRounds: 0 });
  const first = await h.service.send({ text: '开始' });
  h.store.append(
    first.session.id,
    Array.from({ length: 18 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '第' + i + '条：' + 'x'.repeat(400),
      ts: '2026-01-01T00:00:00.000Z',
    }))
  );
  await h.service.send({ sessionId: first.session.id, text: '现在呢' });
  await h.service.send({ sessionId: first.session.id, text: '交接之后的新问题' });
  const lastCall = h.llm.calls[h.llm.calls.length - 1] ?? [];
  assert.equal(lastCall[0]?.role, 'system');
  assert.ok(messageText(lastCall[0]?.content ?? '').includes('上下文交接笔记'));
  assert.ok(messageText(lastCall[0]?.content ?? '').includes('handoffs/'));
  assert.equal(lastCall[lastCall.length - 1]?.content, '交接之后的新问题');
  // 历史只剩 contextStart 之后的 4 条（交接保留的 2 条 + 上一轮的 2 条） + 新 user
  assert.equal(lastCall.length, 1 + 4 + 1);
  assert.ok(String(lastCall[1]?.content).startsWith('第16条'));
});

test('手动交接：压缩到剩 2 条；消息太少报 E_BAD_PARAMS', async () => {
  const h = makeHarness({ maxToolRounds: 0 });
  const first = await h.service.send({ text: '一' });
  await h.service.send({ sessionId: first.session.id, text: '二' });
  const act = await h.service.handoff(first.session.id);
  assert.equal(act.compressed, 2);
  assert.equal(act.kept, 2);
  assert.ok(act.file.startsWith('handoffs/'));
  assert.equal(h.store.get(first.session.id)?.contextStart, 2);

  const fresh = await h.service.send({ text: '只有一个来回' });
  await assert.rejects(() => h.service.handoff(fresh.session.id), { code: 'E_BAD_PARAMS' } as unknown as Error);
});

const GOOD_SUMMARY = [
  '## 关于主人',
  '- 主人下周三去医院复查眼睛，记得提前提醒。',
  '- 主人喜欢安静地陪着，不喜欢被追问太多。',
  '## 待办与承诺',
  '- 帮主人盯着复查这件事。',
].join('\n');

test('LLM 摘要版：清理成功时 mode=llm，笔记里有「## 摘要」与摘要正文', async () => {
  const h = makeHarness({ maxToolRounds: 0 });
  h.llm.summaryText = GOOD_SUMMARY;
  const first = await h.service.send({ text: '一' });
  await h.service.send({ sessionId: first.session.id, text: '二' });
  const act = await h.service.handoff(first.session.id);
  assert.equal(act.mode, 'llm');
  const saved = h.io.files.get(act.file) ?? '';
  assert.ok(saved.startsWith('# 交接笔记 '), '抬头与机械版一致');
  assert.ok(saved.includes('## 摘要'));
  assert.ok(saved.includes('复查眼睛'));
  assert.ok(saved.includes('由我自己整理的摘要'));
  // 摘要那次调用确实带上了「记忆整理员」提示词
  const summaryCall = h.llm.calls.find((msgs) => String(msgs[0]?.content).includes('记忆整理员'));
  assert.ok(summaryCall, '应调用摘要模型');
  assert.equal(h.store.get(first.session.id)?.contextStart, 2);
});

test('LLM 摘要失败或太短：回退机械摘录 mode=mechanical', async () => {
  const broken = makeHarness({ maxToolRounds: 0 });
  broken.llm.summaryError = new Error('boom');
  const s1 = await broken.service.send({ text: '一' });
  await broken.service.send({ sessionId: s1.session.id, text: '二' });
  const failAct = await broken.service.handoff(s1.session.id);
  assert.equal(failAct.mode, 'mechanical');
  const failSaved = broken.io.files.get(failAct.file) ?? '';
  assert.ok(failSaved.startsWith('# 交接笔记 '));
  assert.ok(!failSaved.includes('## 摘要'));

  const short = makeHarness({ maxToolRounds: 0 });
  short.llm.summaryText = '太短';
  const s2 = await short.service.send({ text: '一' });
  await short.service.send({ sessionId: s2.session.id, text: '二' });
  const shortAct = await short.service.handoff(s2.session.id);
  assert.equal(shortAct.mode, 'mechanical');
});

test('handoffUseLlm=false：手动交接不调用摘要模型', async () => {
  const h = makeHarness({ maxToolRounds: 0, handoffUseLlm: false });
  h.llm.summaryText = GOOD_SUMMARY;
  const first = await h.service.send({ text: '一' });
  await h.service.send({ sessionId: first.session.id, text: '二' });
  const callsBefore = h.llm.calls.length;
  const act = await h.service.handoff(first.session.id);
  assert.equal(h.llm.calls.length, callsBefore, '关闭后不应有任何额外模型调用');
  assert.equal(act.mode, 'mechanical');
});
