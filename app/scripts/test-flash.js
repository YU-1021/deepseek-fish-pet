/* 验证 deepseek-flash 接入：对比「关思考」与「默认（开思考）」的真实 usage。
 * 纯 Node 运行：node app\scripts\test-flash.js
 * 密钥从 %APPDATA%\dayu-pet\config.json 读，不打印。
 */
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(process.env.APPDATA, 'dayu-pet', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));

const SYS = `You are "大肥鱼", a desktop pet.
# Output format — reply with EXACTLY these lines, no markdown, no extra text:
EN: <your English reply, 1-3 short sentences>
ZH: <完整中文翻译>
WORDS: <word1>=<IPA1>=<中文意思1>, <word2>=<IPA2>=<中文意思2>
C1: <a short English reply the user could say next>
C1ZH: <中文翻译 of C1>
C2: <another short English reply the user could say next>
C2ZH: <中文翻译 of C2>
MOOD: <2-6个字，心情>`;

async function call(label, extra) {
  const body = Object.assign({
    model: 'deepseek-flash',
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: '主人说：我回来啦。' }],
    temperature: 0.4,
  }, extra);
  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const j = await res.json();
  const m = j.choices && j.choices[0] && j.choices[0].message;
  const u = j.usage || {};
  console.log(`[${label}] ${ms}ms`);
  console.log('  usage:', JSON.stringify({
    prompt: u.prompt_tokens,
    cache_hit: u.prompt_cache_hit_tokens,
    cache_miss: u.prompt_cache_miss_tokens,
    completion: u.completion_tokens,
    total: u.total_tokens,
  }));
  console.log('  reasoning_content 长度:', m && m.reasoning_content ? m.reasoning_content.length : 0);
  console.log('  content 行数:', m && m.content ? m.content.split('\n').length : 0);
  console.log('  content:\n' + String(m && m.content || '').split('\n').map((l) => '    ' + l).join('\n'));
  console.log('');
}

(async () => {
  console.log('model in body = deepseek-flash；apiBase =', cfg.apiBase);
  console.log('');
  await call('关思考 thinking:disabled', { thinking: { type: 'disabled' } });
  await call('默认（官方说默认开思考 effort=high）', {});
})();
