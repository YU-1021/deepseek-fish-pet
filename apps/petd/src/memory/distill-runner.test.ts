/**
 * 自动蒸馏测试：会话 → 摘要/日记/事实/经验 的写盘、合并、跳过与失败路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { WorkspaceMemory } from './store.js';
import { WorkspaceGit } from './git.js';
import { MemoryService } from './service.js';
import { SEED_DIRS } from './prefix.js';
import { DIARY_DIR, EXPERIENCES_FILE, FACTS_FILE, MEDIUM_DIR, parseFacts } from './distill.js';
import { buildTranscript, dateKey, MemoryDistiller, similarity } from './distill-runner.js';
import type { LlmClient } from '../llm/client.js';
import type { PetdConfig } from '../kernel/config.js';
import type { ChatStore, Session } from '../chat/store.js';

const NOW = new Date('2026-11-22T10:30:00+08:00');

function setup(opts: { messages?: Session['messages']; llm?: LlmClient | null; over?: Partial<PetdConfig['memory']['distill']> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-distill-run-'));
  const dir = path.join(home, 'workspace');
  const memory = new WorkspaceMemory({ dir });
  memory.ensureDirs(SEED_DIRS);
  const git = new WorkspaceGit(dir);
  const events: Array<{ event: string; data: unknown }> = [];
  const service = new MemoryService({
    memory,
    git,
    version: '9.9.9',
    publish: (event, data) => events.push({ event, data }),
  });
  service.ensure();
  const messages = opts.messages ?? [
    { role: 'user' as const, content: '今天把记忆注入接好了，晚上想吃面条', ts: '2026-11-22T10:00:00+08:00' },
    { role: 'assistant' as const, content: '好呀，面条记下了～', ts: '2026-11-22T10:01:00+08:00' },
    { role: 'user' as const, content: '以后晚上十点以后别主动说话', ts: '2026-11-22T10:02:00+08:00' },
    { role: 'assistant' as const, content: '明白，晚上十点后我安静待着。', ts: '2026-11-22T10:03:00+08:00' },
  ];
  const session: Session = {
    id: 's-test',
    title: '测试会话',
    createdAt: '2026-11-22T10:00:00+08:00',
    updatedAt: '2026-11-22T10:03:00+08:00',
    messageCount: messages.length,
    messages,
  };
  const chatStore = {
    get: (id: string) => (id === session.id ? session : null),
    list: () => [
      {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
      },
    ],
  } as unknown as Pick<ChatStore, 'get' | 'list'>;
  const distiller = new MemoryDistiller({
    memory,
    memoryService: service,
    llm: opts.llm === undefined ? fakeLlm(DEFAULT_PAYLOAD) : opts.llm,
    chatStore,
    config: () => ({ enabled: true, minMessages: 2, maxInputChars: 12_000, similarity: 0.72, maxTokens: 1200, temperature: 0.3, autoOnHandoff: true, ...(opts.over ?? {}) }),
    now: () => NOW,
    publish: (event, data) => events.push({ event, data }),
  });
  return { home, dir, memory, events, distiller, service };
}

const DEFAULT_PAYLOAD = {
  summary: '今天把记忆注入接上了，主人晚上想吃面条，并要求十点以后安静。',
  diary: '今天把记忆注入接上了，主人心情不错，晚上想吃面条。',
  facts: [
    { text: '主人晚上想吃面条', weight: 4, tags: ['饮食'] },
    { text: '主人要求晚上十点以后不要主动说话', weight: 9, tags: ['偏好', '禁忌'] },
  ],
  experiences: [{ text: '主人说想吃什么时，先记下来再回应', weight: 5, tags: ['吃饭'] }],
};

function fakeLlm(payload: unknown, text?: string): LlmClient {
  return {
    config: {} as LlmClient['config'],
    async complete() {
      return {
        text: text ?? JSON.stringify(payload),
        model: 'fake',
        usage: { promptTokens: 11, completionTokens: 22 },
      };
    },
  };
}

test('会话太短时跳过，不写文件也不花 token', async () => {
  const ctx = setup({ messages: [{ role: 'user', content: '在吗', ts: '2026-11-22T10:00:00+08:00' }] });
  const result = await ctx.distiller.run({ sessionId: 's-test' });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'too-short');
  assert.equal(parseFacts(ctx.memory.readFile(FACTS_FILE)).length, 0);
});

test('蒸馏写 medium/diary/facts/experiences 并广播 memory.distilled', async () => {
  const ctx = setup();
  const result = await ctx.distiller.run({ sessionId: 's-test', reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.turns, 4);
  assert.equal(result.files.facts?.added, 2);
  assert.equal(result.files.experiences?.added, 1);
  assert.ok(result.files.medium?.path.startsWith(`${MEDIUM_DIR}/${dateKey(NOW)}-`));
  assert.ok(fs.existsSync(path.join(ctx.dir, result.files.medium!.path)));
  assert.ok(fs.existsSync(path.join(ctx.dir, result.files.diary!.path)));
  const facts = parseFacts(fs.readFileSync(path.join(ctx.dir, FACTS_FILE), 'utf8'));
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.text, '主人要求晚上十点以后不要主动说话');
  const diary = fs.readFileSync(path.join(ctx.dir, DIARY_DIR, `${dateKey(NOW)}.md`), 'utf8');
  assert.ok(diary.includes('面条'));
  const medium = fs.readFileSync(path.join(ctx.dir, result.files.medium!.path), 'utf8');
  assert.ok(medium.includes('session: s-test'));
  assert.ok(medium.includes('turns: 4'));
  assert.ok(ctx.events.some((e) => e.event === 'memory.distilled'));
  assert.equal(ctx.distiller.status().counters.runs, 1);
});

test('已有事实按相同/相似合并：权重累加、出现次数+1、不新增重复行', async () => {
  const ctx = setup();
  ctx.memory.writeFileAtomic(
    FACTS_FILE,
    ['# 记住的事', '', '| 事实 | 权重 | 标签 | 出现 | 最近 |', '| --- | --- | --- | --- | --- |', '| 主人要求晚上十点以后不要主动说话 | 8 | 偏好 | 3 | 2026-11-20 |'].join('\n') + '\n'
  );
  const result = await ctx.distiller.run({ sessionId: 's-test' });
  assert.equal(result.files.facts?.added, 1);
  assert.equal(result.files.facts?.merged, 1);
  const facts = parseFacts(fs.readFileSync(path.join(ctx.dir, FACTS_FILE), 'utf8'));
  assert.equal(facts.filter((f) => f.text.includes('十点')).length, 1);
  const ten = facts.find((f) => f.text.includes('十点'))!;
  assert.equal(ten.weight, 10);
  assert.equal(ten.hits, 4);
  assert.equal(ten.lastSeen, dateKey(NOW));
});

test('同一天再蒸馏日记是追加，不覆盖已有内容', async () => {
  const ctx = setup();
  const diaryPath = path.join(ctx.dir, DIARY_DIR, `${dateKey(NOW)}.md`);
  fs.mkdirSync(path.dirname(diaryPath), { recursive: true });
  fs.writeFileSync(diaryPath, '# 2026-11-22\n\n## 08:00\n\n早起写代码。\n', 'utf8');
  await ctx.distiller.run({ sessionId: 's-test' });
  const content = fs.readFileSync(diaryPath, 'utf8');
  assert.ok(content.includes('早起写代码'));
  assert.ok(content.includes('10:30'));
  assert.ok(content.includes('面条'));
});

test('模型输出带 ```json 围栏和前后废话也能解析', async () => {
  const ctx = setup({
    llm: fakeLlm(null, `好的，整理如下：\n\`\`\`json\n${JSON.stringify(DEFAULT_PAYLOAD)}\n\`\`\`\n希望有用。`),
  });
  const result = await ctx.distiller.run({ sessionId: 's-test' });
  assert.equal(result.ok, true);
  assert.equal(result.files.facts?.added, 2);
});

test('模型输出不是 JSON 时抛错并记录 lastError，不写文件', async () => {
  const ctx = setup({ llm: fakeLlm(null, '抱歉，我不太确定。') });
  await assert.rejects(() => ctx.distiller.run({ sessionId: 's-test' }), /找不到 JSON 对象/);
  assert.match(ctx.distiller.status().lastError ?? '', /JSON/);
  assert.equal(ctx.distiller.status().counters.runs, 0);
  assert.equal(parseFacts(ctx.memory.readFile(FACTS_FILE)).length, 0);
});

test('关闭时抛 E_UNAVAILABLE；没有 llm 也抛 E_UNAVAILABLE', async () => {
  const disabled = setup({ over: { enabled: false } });
  await assert.rejects(
    () => disabled.distiller.run({ sessionId: 's-test' }),
    (err: unknown) => err instanceof PetdError && err.code === 'E_UNAVAILABLE'
  );
  const noLlm = setup({ llm: null });
  await assert.rejects(
    () => noLlm.distiller.run({ sessionId: 's-test' }),
    (err: unknown) => err instanceof PetdError && err.code === 'E_UNAVAILABLE'
  );
});

test('相似度与 transcript 构造：长会话保留开头+结尾', () => {
  assert.ok(similarity('主人喜欢安静', '主人很喜欢安静') > 0.72);
  assert.ok(similarity('主人喜欢安静', '今天天气不错') < 0.5);
  const long = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `第${i}条消息` }));
  const transcript = buildTranscript(long, 200);
  assert.ok(transcript.includes('第0条消息'));
  assert.ok(transcript.includes('第39条消息'));
  assert.ok(transcript.includes('中间省略'));
});
