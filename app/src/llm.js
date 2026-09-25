/* 大模型接入：非流式 + 流式 SSE + 回复解析。
 *
 * 超时是这里最关键的一条：以前 fetch 没有 signal，连上之后服务端不吐数据就会一直挂着
 * （实测黑洞连接 20 秒毫无反应）。而 main.js 的 before-quit 要 await 会话收尾，
 * 挂住就等于"窗口关不掉"。所以每条请求都带 AbortSignal 超时。
 */
const DEFAULT_TIMEOUT_MS = 90000;

function timeoutSignal(cfg, fallbackMs) {
  const raw = Number((cfg && cfg.llmTimeoutMs) || fallbackMs || DEFAULT_TIMEOUT_MS);
  const ms = Math.max(5000, Math.min(600000, isFinite(raw) ? raw : DEFAULT_TIMEOUT_MS));
  try { return { signal: AbortSignal.timeout(ms), ms }; } catch { return { signal: undefined, ms }; }
}

function isTimeout(e) {
  const n = e && e.name;
  return n === 'TimeoutError' || n === 'AbortError';
}
function wrapNetErr(e, ms) {
  if (isTimeout(e)) return new Error('模型请求超时（' + Math.round(ms / 1000) + ' 秒内没有响应）');
  return e;
}

async function request(cfg, messages) {
  const base = String(cfg.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址');
  if (!cfg.apiKey) throw new Error('未配置 API Key');

  const { signal, ms } = timeoutSignal(cfg);
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model || 'deepseek-chat', messages, temperature: 0.4 }),
      signal,
    });
  } catch (e) { throw wrapNetErr(e, ms); }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const json = await res.json().catch((e) => { throw wrapNetErr(e, ms); });
  return json?.choices?.[0]?.message?.content || '';
}

/* 流式：边生成边回调 onDelta(累计全文)。返回最终全文。 */
async function stream(cfg, messages, onDelta) {
  const base = String(cfg.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址');
  if (!cfg.apiKey) throw new Error('未配置 API Key');

  const { signal, ms } = timeoutSignal(cfg);
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model || 'deepseek-chat', messages, temperature: 0.4, stream: true }),
      signal,
    });
  } catch (e) { throw wrapNetErr(e, ms); }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') throw new Error('当前环境不支持流式读取');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', apiErr = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          // 限流/上下文超限常常发生在首个 token **之后**：以前这里被 try/catch 吞掉，
          // 于是 stream() 正常返回半截文本，调用方当成"模型没说话"，真实错误全丢了。
          if (j && j.error) { apiErr = String((j.error && j.error.message) || j.error); continue; }
          const d = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) { full += d; if (onDelta) onDelta(full); }
        } catch {}
      }
    }
  } catch (e) {
    // onDelta 抛错（例如窗口销毁后 webContents.send 会抛）时也要把连接放掉，
    // 否则服务端会继续生成到 max_tokens 为止。
    throw wrapNetErr(e, ms);
  } finally {
    try { reader.cancel(); } catch {}
  }
  if (!full && apiErr) throw new Error('模型返回错误：' + apiErr);
  return full;
}

function parseReply(text) {
  const raw = String(text || '').trim();

  // 1) 先尝试 JSON（兼容老输出）
  let t = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (t.startsWith('{')) {
    const e = t.lastIndexOf('}');
    if (e > 0) {
      try {
        const o = JSON.parse(t.slice(0, e + 1).replace(/,\s*([}\]])/g, '$1'));
        if (o && (o.en || o.zh || o.choices)) {
          const pick = (c) => ({ en: String(c?.en || '').trim(), zh: String(c?.zh || '').trim(), ipa: String(c?.ipa || '').trim() });
          const words = Array.isArray(o.words)
            ? o.words.map((w) => ({ w: String(w?.w || '').trim(), ipa: String(w?.ipa || '').trim(), zh: String(w?.zh || '').trim() })).filter((w) => w.w)
            : [];
          return { en: String(o.en || '').trim(), zh: String(o.zh || '').trim(), words, choices: Array.isArray(o.choices) ? o.choices.slice(0, 2).map(pick) : [], action: o.action || null };
        }
      } catch {}
    }
  }

  // 2) 逐行标签格式解析
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const find = (labels) => {
    for (const l of lines) {
      const low = l.toLowerCase();
      for (const label of labels) if (low.startsWith(label.toLowerCase())) return l.slice(label.length).trim();
    }
    return '';
  };
  const en = find(['en:', 'en：']);
  const zh = find(['zh:', 'zh：']);
  const wstr = find(['words:', 'words：']);
  const words = wstr.split(/[,，;；]/).map((seg) => {
    const m = seg.trim().match(/^([^=＝]+?)\s*[=＝]\s*(\/?[^=＝]+?)\s*[=＝]\s*(.+)$/);
    return m ? { w: m[1].trim(), ipa: m[2].trim(), zh: m[3].trim() } : null;
  }).filter(Boolean);

  const choices = [];
  const c1 = find(['c1:', 'c1：']), c1zh = find(['c1zh:', 'c1zh：']);
  const c2 = find(['c2:', 'c2：']), c2zh = find(['c2zh:', 'c2zh：']);
  if (c1) choices.push({ en: c1, zh: c1zh, ipa: '' });
  if (c2) choices.push({ en: c2, zh: c2zh, ipa: '' });

  // 可选：电脑操作请求 ACTION: tool|arg
  const actLine = find(['action:', 'action：']);
  let action = null;
  if (actLine) {
    const i = actLine.indexOf('|');
    if (i > 0) {
      const tool = actLine.slice(0, i).trim().toLowerCase();
      if (tool) action = { tool, arg: actLine.slice(i + 1).trim() };
    } else {
      /* 提示词里 screen_shot / web_read / game_stop / game_status 是**不带 | ** 写的：
         "- screen_shot  (capture the user's screen…)"。
         模型照着写就是这一支，以前直接丢掉 → 她说"让我看看你的屏幕"然后什么都没发生。
         这里只要是个像样的工具名就收下（真正的合法性由 assistant.run 判断）。 */
      const tool = actLine.trim().toLowerCase();
      if (/^[a-z][a-z0-9_]*$/.test(tool)) action = { tool, arg: '' };
    }
  }

  // 可选：隐藏心情行（不显示给用户，只留在历史里给下一轮的自己看）
  const mood = find(['mood:', 'mood：']);

  return { en: en || raw, zh, words, choices, action, mood: mood || '' };
}

module.exports = { request, stream, parseReply, DEFAULT_TIMEOUT_MS };
