/**
 * RiskAssessor 测试：解析、缓存、TTL、失败回退、关闭回退。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmClient } from '../llm/client.js';
import { RiskAssessor, parseRiskReply, type RiskConfig } from './risk.js';

const BASE: RiskConfig = {
  enabled: true,
  timeoutMs: 5000,
  cacheTtlSeconds: 600,
  maxCacheEntries: 200,
  maxArgsChars: 1200,
  fallback: 'high',
};

type Complete = Pick<LlmClient, 'complete'>;

function fakeLlm(handler: (opts: { messages: unknown[] }) => { text: string } | Promise<{ text: string }>): {
  llm: Complete;
  calls: Array<{ messages: Array<{ role: string; content: string }> }>;
} {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const complete = (async (opts: unknown) => {
    const o = opts as { messages: Array<{ role: string; content: string }> };
    calls.push(o);
    const reply = await handler({ messages: o.messages });
    return { text: reply.text, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }) as unknown as LlmClient['complete'];
  return { llm: { complete }, calls };
}

function assessor(over: Partial<RiskConfig>, llm: Complete, now?: () => number): RiskAssessor {
  let cfg: RiskConfig = { ...BASE, ...over };
  return new RiskAssessor({ llm, config: () => cfg, ...(now === undefined ? {} : { now }) });
}

test('parseRiskReply：普通/围栏/前后废话都能解析', () => {
  assert.deepEqual(parseRiskReply('{"risk":"low","reason":"只读文件"}'), { level: 'low', reason: '只读文件' });
  assert.deepEqual(parseRiskReply('```json\n{"risk":"high","reason":"删除文件"}\n```'), { level: 'high', reason: '删除文件' });
  assert.deepEqual(parseRiskReply('好的：{"risk":"medium","reason":"写配置"} 完毕'), { level: 'medium', reason: '写配置' });
});

test('parseRiskReply：坏 JSON / 未知等级 / 非字符串都返回 null', () => {
  assert.equal(parseRiskReply('not json'), null);
  assert.equal(parseRiskReply('{"risk":"danger"}'), null);
  assert.equal(parseRiskReply('{"reason":"没有等级"}'), null);
  assert.equal(parseRiskReply(''), null);
});

test('assess：返回模型等级，并把操作信息放进提示词', async () => {
  const { llm, calls } = fakeLlm(() => ({ text: '{"risk":"low","reason":"读文件没有副作用"}' }));
  const a = assessor({}, llm);
  const v = await a.assess({ kind: 'tool', name: 'read_file', args: { path: 'x.md' } });
  assert.equal(v.level, 'low');
  assert.equal(v.fallback, false);
  assert.equal(v.cached, false);
  assert.equal(calls.length, 1);
  const user = calls[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(user, /操作名：read_file/);
  assert.match(user, /x\.md/);
});

test('assess：同一操作命中缓存，不再调模型；参数不同则重新评', async () => {
  const { llm, calls } = fakeLlm(() => ({ text: '{"risk":"medium","reason":"写文件"}' }));
  const a = assessor({}, llm);
  const ctx = { kind: 'tool' as const, name: 'write_file', args: { path: 'a.md', content: 'hi' } };
  const first = await a.assess(ctx);
  const again = await a.assess(ctx);
  assert.equal(first.cached, false);
  assert.equal(again.cached, true);
  assert.equal(again.level, 'medium');
  assert.equal(calls.length, 1);
  await a.assess({ ...ctx, args: { path: 'b.md', content: 'hi' } });
  assert.equal(calls.length, 2);
});

test('assess：TLL 过期后重新评', async () => {
  let nowMs = 1_000_000;
  const { llm, calls } = fakeLlm(() => ({ text: '{"risk":"low","reason":"只读"}' }));
  const a = assessor({ cacheTtlSeconds: 10 }, llm, () => nowMs);
  await a.assess({ kind: 'tool', name: 'read_file' });
  nowMs += 5_000;
  const hit = await a.assess({ kind: 'tool', name: 'read_file' });
  assert.equal(hit.cached, true);
  nowMs += 11_000;
  const miss = await a.assess({ kind: 'tool', name: 'read_file' });
  assert.equal(miss.cached, false);
  assert.equal(calls.length, 2);
});

test('assess：模型失败 → 回退等级 + fallback=true', async () => {
  const llm = {
    complete: (async () => {
      throw new Error('model down');
    }) as unknown as LlmClient['complete'],
  };
  const a = assessor({ fallback: 'high' }, llm);
  const v = await a.assess({ kind: 'method', name: 'memory.delete', scope: 'write' });
  assert.equal(v.level, 'high');
  assert.equal(v.fallback, true);
  assert.match(v.reason, /风险评估失败/);
});

test('assess：输出不合法 → 回退；关闭时也回退', async () => {
  const bad = fakeLlm(() => ({ text: '我觉得还行' }));
  const a = assessor({ fallback: 'medium' }, bad.llm);
  const v = await a.assess({ kind: 'tool', name: 'delete_file' });
  assert.equal(v.level, 'medium');
  assert.equal(v.fallback, true);

  const off = assessor({ enabled: false, fallback: 'high' }, bad.llm);
  const v2 = await off.assess({ kind: 'tool', name: 'delete_file' });
  assert.equal(v2.level, 'high');
  assert.equal(v2.fallback, true);
});

test('缓存上限与 clearCache', async () => {
  const { llm } = fakeLlm(() => ({ text: '{"risk":"low","reason":"ok"}' }));
  const a = assessor({ maxCacheEntries: 2 }, llm);
  await a.assess({ kind: 'tool', name: 'read_file', args: { n: 1 } });
  await a.assess({ kind: 'tool', name: 'read_file', args: { n: 2 } });
  await a.assess({ kind: 'tool', name: 'read_file', args: { n: 3 } });
  assert.equal(a.cacheSize(), 2);
  a.clearCache();
  assert.equal(a.cacheSize(), 0);
});
