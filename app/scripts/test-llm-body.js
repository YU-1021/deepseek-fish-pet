/* 拦截 fetch，打印应用 src/llm.js 真实发出的请求体（不联网、不花 token）。
 * node app\scripts\test-llm-body.js
 */
const path = require('path');
const llm = require(path.join(__dirname, '..', 'src', 'llm.js'));

const bodies = [];
global.fetch = async (url, opts) => {
  bodies.push({ url, body: JSON.parse(opts.body) });
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'EN: hi\nZH: 嗨' } }] }),
    body: null,
    text: async () => '',
  };
};

(async () => {
  const cfg = { apiBase: 'https://api.deepseek.com/v1', apiKey: 'dummy', model: 'deepseek-flash' };
  await llm.request(cfg, [{ role: 'user', content: 'hi' }]);
  // 流式那条路径也验一下（给它一个假 body，只需看有没有抛在请求体之前）
  try { await llm.stream(cfg, [{ role: 'user', content: 'hi' }], () => {}); } catch (e) { /* 假响应没有 body，预期报错 */ }

  console.log('捕获到请求数:', bodies.length);
  bodies.forEach((b, i) => {
    console.log(`\n--- 请求 ${i + 1} ---`);
    console.log('url :', b.url);
    console.log('body:', JSON.stringify(b.body, null, 2));
  });
  const ok = bodies.every((b) => b.body.model === 'deepseek-flash'
    && b.body.thinking && b.body.thinking.type === 'disabled'
    && b.body.temperature === 0.4);
  console.log('\n结论: model=deepseek-flash 且 thinking=disabled 且 temperature=0.4 ->', ok ? '✅ 全部正确' : '❌ 有问题');
})();
