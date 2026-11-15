/**
 * evolvePersona：AI 自演化只「提议」，落盘决策全在 PersonaStore（锁/版本/边界）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PetdError } from '@petd/protocol';
import { PersonaStore } from './store.js';
import { evolvePersona, parseEvolveReply, type EvolveLlm, type EvolveMessage } from './evolve.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-evolve-'));
}

interface LlmCall {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

function fakeLlm(reply: string): { llm: EvolveLlm; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    llm: {
      async complete(opts) {
        calls.push({
          messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
        });
        return { text: reply };
      },
    },
  };
}

const recent = (): EvolveMessage[] => [
  { role: 'user', content: '今天工作好累' },
  { role: 'assistant', content: '哼，那就早点睡，我帮你盯着。' },
];

test('所有可编辑小节上锁 → 不调模型，直接 changed=false', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  store.setLock('character', true);
  store.setLock('speaking', true);
  const { llm, calls } = fakeLlm('{}');
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, false);
  assert.match(r.reason, /上锁|没有可演化/);
  assert.equal(calls.length, 0);
  assert.equal(store.read().version, 1);
});

test('正常演化：JSON 提议 → 经 store.patch(agent) 落盘', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const { llm, calls } = fakeLlm(
    JSON.stringify({
      changed: true,
      reason: '最近主人工作很累，我学会了更直接地关心',
      sections: { speaking: '- 用中文自然聊天，语气亲密但不过分甜腻。\n- 主人累了就直接让他休息，少绕弯子。' },
    })
  );
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, true);
  assert.equal(r.version, 2);
  assert.deepEqual(r.applied, ['speaking']);
  assert.match(r.reason, /更直接地关心/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.temperature, 0.3);
  assert.equal(calls[0]?.maxTokens, 800);
  assert.ok(calls[0]?.messages[0]?.content.includes('人格演化器'));
  assert.ok(calls[0]?.messages[1]?.content.includes('今天工作好累'));
  assert.ok(store.read().content.includes('少绕弯子'));
  const h = store.history(3);
  assert.equal(h[0]?.actor, 'agent');
});

test('模型返回代码围栏 JSON 也能解析', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const { llm } = fakeLlm(
    '```json\n{"changed": true, "reason": "微调", "sections": {"speaking": "- 新的说话方式。"}}\n```'
  );
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, true);
  assert.deepEqual(r.applied, ['speaking']);
});

test('非法 JSON：changed=false，人格不动，不抛错', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const { llm } = fakeLlm('我觉得不用改，主人今天很好！');
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, false);
  assert.equal(r.version, 1);
  assert.match(r.reason, /不是合法 JSON/);
  assert.ok(r.raw);
});

test('模型说 changed=false：不发写操作', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const { llm } = fakeLlm('{"changed": false, "reason": "最近经历太少", "sections": {}}');
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, false);
  assert.equal(r.reason, '最近经历太少');
  assert.equal(store.read().version, 1);
});

test('模型试图改世界观：被 store 拒绝，人格不变', async () => {
  const store = new PersonaStore({
    home: tmpHome(),
    file: 'SOUL.md',
    legacy: { name: '大肥鱼', world_setting: '现代都市', character_setting: '傲娇' },
  });
  store.ensure();
  const { llm } = fakeLlm('{"changed": true, "reason": "想改世界观", "sections": {"worldview": "异世界"}}');
  const r = await evolvePersona({ store, llm, recentMessages: recent });
  assert.equal(r.changed, false);
  assert.ok(r.rejected.some((x) => x.key === 'worldview'));
  assert.ok(!store.read().content.includes('异世界'));
});

test('对话摘录有预算：超长经历被裁剪', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const longHistory: EvolveMessage[] = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i} 条：` + '这是一段很长的经历描述。'.repeat(40),
  }));
  const { llm, calls } = fakeLlm('{"changed": false, "reason": "无需改动", "sections": {}}');
  await evolvePersona({ store, llm, recentMessages: () => longHistory, historyBudgetChars: 3000 });
  const prompt = calls[0]?.messages[1]?.content ?? '';
  assert.ok(prompt.length < 6000 + 3500, `prompt 过长：${prompt.length}`);
  assert.ok(prompt.includes('…'), '应出现裁剪标记');
});

test('模型调用失败 → 抛 PetdError E_INTERNAL', async () => {
  const store = new PersonaStore({ home: tmpHome(), file: 'SOUL.md' });
  store.ensure();
  const llm: EvolveLlm = {
    async complete() {
      throw new Error('boom');
    },
  };
  await assert.rejects(
    () => evolvePersona({ store, llm, recentMessages: recent }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_INTERNAL'
  );
});

test('parseEvolveReply：容忍前后废话、丢弃非法 sections', () => {
  const r = parseEvolveReply('好的，我的提议如下：\n{"changed":true,"reason":"x","sections":{"speaking":"hi","nope":123}}\n请审阅。');
  assert.ok(r);
  assert.equal(r.changed, true);
  assert.deepEqual(r.sections, { speaking: 'hi' });
  assert.equal(parseEvolveReply('not json at all'), null);
  assert.equal(parseEvolveReply(''), null);
});
