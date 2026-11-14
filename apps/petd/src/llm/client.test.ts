/**
 * LlmClient 测试：成功路径 + 各类错误映射，全部用注入的 fetch，不碰网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import { createLlmClient, type LlmClient } from './client.js';

type FetchLike = typeof fetch;

function makeClient(fetchImpl: FetchLike, overrides: Partial<typeof DEFAULT_CONFIG.llm> = {}, apiKey = 'test-key'): LlmClient {
  return createLlmClient({
    config: { ...DEFAULT_CONFIG.llm, ...overrides },
    apiKey,
    fetchImpl,
  });
}

function okResponse(content: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('成功：URL/鉴权/thinking disabled/解析文本与 usage', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return okResponse('  你好呀  ');
  };
  const client = makeClient(fetchImpl);
  const reply = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });

  assert.ok(seenUrl.endsWith('/chat/completions'));
  assert.equal(seenUrl, 'https://api.deepseek.com/v1/chat/completions');
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer test-key');
  const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
  assert.equal(body['model'], 'deepseek-flash');
  assert.deepEqual(body['thinking'], { type: 'disabled' });
  assert.equal(body['stream'], false);
  assert.equal(reply.text, '你好呀');
  assert.equal(reply.usage.totalTokens, 16);
  assert.equal(reply.finishReason, 'stop');
});

test('HTTP 错误码映射：401/402/429/500', async () => {
  const cases: Array<[number, string, string]> = [
    [401, 'E_LLM_AUTH', 'API Key'],
    [402, 'E_LLM_QUOTA', '余额'],
    [429, 'E_LLM_RATE', '限流'],
    [500, 'E_LLM_HTTP', '暂时不可用'],
  ];
  for (const [status, code, hint] of cases) {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status });
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (e: unknown) => {
        const err = e as { code?: string; message: string };
        assert.equal(err.code, code, `status ${status} 应映射 ${code}`);
        assert.ok(err.message.includes(hint), `错误文案应含 ${hint}：${err.message}`);
        if (status === 500) assert.ok(err.message.includes('boom'));
        return true;
      }
    );
  }
});

test('空内容 / 非 JSON 响应', async () => {
  const emptyFetch: FetchLike = async () => okResponse('   ');
  await assert.rejects(
    () => makeClient(emptyFetch).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    { code: 'E_LLM_EMPTY' } as unknown as Error
  );

  const badJson: FetchLike = async () => new Response('not json', { status: 200 });
  await assert.rejects(
    () => makeClient(badJson).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    { code: 'E_LLM_BAD_RESPONSE' } as unknown as Error
  );
});

test('网络错误顺着 cause 找 code', async () => {
  const fetchImpl: FetchLike = async () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), { code: 'ENOTFOUND' });
    throw Object.assign(new Error('fetch failed'), { cause: inner });
  };
  await assert.rejects(
    () => makeClient(fetchImpl).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (e: unknown) => {
      const err = e as { code?: string; message: string };
      assert.equal(err.code, 'E_LLM_NETWORK');
      assert.ok(err.message.includes('域名解析失败'));
      return true;
    }
  );
});

test('超时映射 E_LLM_TIMEOUT', async () => {
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const client = makeClient(fetchImpl, { timeoutMs: 30 });
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (e: unknown) => {
      const err = e as { code?: string; message: string };
      assert.equal(err.code, 'E_LLM_TIMEOUT');
      assert.ok(err.message.includes('超时'));
      return true;
    }
  );
});

test('没有 apiKey 时不发请求直接报 E_LLM_AUTH', async () => {
  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    return okResponse('x');
  };
  await assert.rejects(() => makeClient(fetchImpl, {}, '').complete({ messages: [{ role: 'user', content: 'hi' }] }), { code: 'E_LLM_AUTH' } as unknown as Error);
  assert.equal(called, 0);
});

test('空消息列表直接报 E_LLM_BAD_RESPONSE', async () => {
  const fetchImpl: FetchLike = async () => okResponse('x');
  await assert.rejects(() => makeClient(fetchImpl).complete({ messages: [] }), { code: 'E_LLM_BAD_RESPONSE' } as unknown as Error);
});
