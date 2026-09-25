async function request(cfg, messages) {
  const base = String(cfg.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址');
  if (!cfg.apiKey) throw new Error('未配置 API Key');

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model || 'deepseek-chat', messages, temperature: 0.4 })
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '';
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
    if (i > 0) action = { tool: actLine.slice(0, i).trim(), arg: actLine.slice(i + 1).trim() };
  }

  return { en: en || raw, zh, words, choices, action };
}

module.exports = { request, parseReply };
