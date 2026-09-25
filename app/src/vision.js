// 视觉模型调用：把截图 + 问题发给一个 OpenAI 兼容的多模态模型，让它"看懂"画面。
// 默认用 DeepSeek 自己的 deepseek-flash（视觉），复用主模型的 apiBase/apiKey。
// 也可以单独配 visionBase / visionKey / visionModel 换别的多模态模型。
//
// 注意：必须带超时。游戏助手主循环是 await 这个调用的，没有超时的话
// 一次黑洞连接就会让循环既不前进也不响应"停"（stopFlag 只在间隔等待里检查）。
async function describe(cfg, imageDataUrl, question, detail) {
  const base = String(cfg.visionBase || cfg.apiBase || '').replace(/\/+$/, '');
  const key = String(cfg.visionKey || cfg.apiKey || '');
  const model = cfg.visionModel || 'deepseek-flash';
  if (!base || !key) throw new Error('未配置视觉模型');

  const ms = Math.max(5000, Math.min(300000, Number(cfg.visionTimeoutMs) || 60000));
  let signal;
  try { signal = AbortSignal.timeout(ms); } catch {}
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: detail || 'low' } },
          ],
        }],
      }),
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('视觉模型超时（' + Math.round(ms / 1000) + ' 秒内没有响应）');
    }
    throw e;
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '';
}

module.exports = { describe };
