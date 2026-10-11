/* 大模型接入：非流式 + 流式 SSE + 回复解析。
 *
 * 超时是这里最关键的一条：以前 fetch 没有 signal，连上之后服务端不吐数据就会一直挂着
 * （实测黑洞连接 20 秒毫无反应）。而 main.js 的 before-quit 要 await 会话收尾，
 * 挂住就等于"窗口关不掉"。所以每条请求都带 AbortSignal 超时。
 *
 * 模型与思考模式（DeepSeek-V4.1-Flash）：
 *   模型名用 deepseek-flash（旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 已下线，
 *   仍可调用但由 V4.1-Flash 提供服务，按 Flash 价计费）。
 *   V4.1-Flash 的**思考模式默认打开、effort=high**，对桌宠是三重伤害：
 *     ① reasoning_content 按**输出**价计费（¥4/M），一句"嗯"可能先烧几百 token 的思维链；
 *     ② 思考模式下 temperature 不生效（官方明确：设置不报错但会被忽略），回复的随机性没了；
 *     ③ 首字要等思维链写完，流式朗读和 TTS 的即时感全丢。
 *   所以这里**显式关掉**：thinking: { type: 'disabled' }。
 *   想改成思考模式就把这一项换成 { type: 'enabled' } 并配合 reasoning_effort。
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

/* 把网络层原始错误翻成**用户能照着做**的话。
 * 起因：故障注入测试里把 API 地址指到打不通的端口，调用方收到的只有一句
 *   `fetch failed` —— 渲染层会把它原样显示成错误气泡（chat.js 的 addErr），
 *   用户看到这四个字完全不知道是网断了、地址配错了、还是 key 过期了
 *   （这台机器上网络时好时坏，这个提示尤其重要）。
 * 原始错误码塞进括号里保留，方便排查，但主句要先说人话。 */
/* 把错误里所有可能藏原因的地方串起来。
 * 为什么要这么啰嗦：Node/Electron 的 fetch 失败时**不是**简单的 `e.cause.code`。
 * 实测连不上时拿到的是 `TypeError: fetch failed`，真正的原因埋在
 *   cause = AggregateError（Happy Eyeballs 同时试 IPv4/IPv6）
 *     └ errors[] = [Error: connect ECONNREFUSED …]   ← code 在这一层
 * 只读 e.cause.code 会得到 undefined，于是分类全部落空、用户还是看到 "fetch failed"。 */
function errCodes(e) {
  const out = [];
  const seen = new Set();
  const push = (x, d) => {
    if (!x || typeof x !== 'object' || d > 3 || seen.has(x)) return;
    seen.add(x);
    if (x.code) out.push(String(x.code));
    if (x.errno) out.push(String(x.errno));
    if (x.message) out.push(String(x.message));
    if (Array.isArray(x.errors)) for (const y of x.errors) push(y, d + 1);
    if (x.cause) push(x.cause, d + 1);
  };
  push(e, 0);
  return out.join(' | ');
}

function wrapNetErr(e, ms, base) {
  if (isTimeout(e)) return new Error('模型请求超时（' + Math.round(ms / 1000) + ' 秒内没有响应）—— 网络慢或被墙了，可以稍后重试。');
  const blob = errCodes(e);
  const where = base ? '（地址：' + base + '）' : '';
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(blob)) {
    return new Error('连不上模型服务器：域名解析失败' + where + '，检查网络或配置里的 apiBase。');
  }
  if (/ECONNREFUSED/i.test(blob)) {
    return new Error('连不上模型服务器：连接被拒绝' + where + '，地址或端口不对（服务没在跑？）。');
  }
  if (/ECONNRESET|EPIPE|ERR_SSL|CERT|socket hang up|other side closed/i.test(blob)) {
    return new Error('和模型服务器的连接被中断' + where + '（网络不稳、代理掉线或证书问题），稍后重试即可。');
  }
  if (/ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(blob)) {
    return new Error('网络不可达' + where + ' —— 检查是否开了代理/梯子。');
  }
  /* fetch 规范有一份"被禁端口"黑名单（9/25/587/6667 等），命中时 undici 直接拒绝、
   * 连都不连，报的是 cause="bad port"。实测把 apiBase 指到 :9 就是这个 —— 光看
   * "fetch failed" 完全猜不到是端口被禁，所以单独说清楚。 */
  if (/bad port/i.test(blob)) {
    return new Error('配置里的端口被浏览器安全策略禁止' + where + ' —— 换成 80/443/8080/3000 这类普通端口。');
  }
  return new Error('模型请求失败：' + ((e && e.message) || e) + where);
}

/* 导出给别的"也直接 fetch 模型接口"的模块复用（目前是 vision.js）。
 * 那边原本自己抛 `HTTP ${status} ${body}` 和裸网络错误 —— 和 llm.js 修之前一模一样，
 * 用户同样只会看到 "fetch failed"。翻译逻辑放一处，别再复制一份走样。 */
const net = { wrapNetErr, wrapHttpErr, errCodes, isTimeout };

/* HTTP 状态码 → 人话。原来的实现直接把服务端 JSON 甩给用户（"HTTP 401 {…}"），
 * 401/402/429 这三种恰好是最需要说清楚的（key 错、没钱了、太频繁）。 */
function wrapHttpErr(status, body) {
  const raw = String(body || '').replace(/\s+/g, ' ').slice(0, 200);
  const map = {
    400: '请求被拒绝（参数或模型名不对）',
    401: 'API Key 无效或已过期 —— 去设置里重新填一次',
    402: '账户余额不足 —— 需要充值才能继续',
    403: '这个 Key 没有访问该模型的权限',
    404: '接口地址不存在 —— 检查配置里的 apiBase 是不是少了/多了路径',
    422: '请求内容不合法（格式或长度超限）',
    429: '请求太频繁或已达限额 —— 等一会儿再试',
    500: '模型服务端内部错误 —— 这不是你的问题，稍后重试',
    502: '网关错误（服务端或代理不稳定）',
    503: '服务暂时不可用（可能在维护）',
    504: '网关超时（服务端响应太慢）',
  };
  const head = map[status] || ('模型服务返回 HTTP ' + status);
  const detail = /Authentication Fails|invalid/i.test(raw) && status === 401 ? '' : '　服务端说明：' + raw;
  return new Error(head + '（HTTP ' + status + '）' + detail);
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
      body: JSON.stringify({ model: cfg.model || 'deepseek-flash', messages, temperature: 0.4, thinking: { type: 'disabled' } }),
      signal,
    });
  } catch (e) { throw wrapNetErr(e, ms, base); }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw wrapHttpErr(res.status, body);
  }
  const json = await res.json().catch((e) => { throw wrapNetErr(e, ms, base); });
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
      body: JSON.stringify({ model: cfg.model || 'deepseek-flash', messages, temperature: 0.4, stream: true, thinking: { type: 'disabled' } }),
      signal,
    });
  } catch (e) { throw wrapNetErr(e, ms, base); }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw wrapHttpErr(res.status, body);
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
    throw wrapNetErr(e, ms, base);
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
  /* 历史里的紧凑标记**绝不能**被复述出来：实测模型会把
     "(earlier reply, abridged) ACTION: proj_run|xxx" 整行当成回复吐回来，
     而 find() 只认行首 → 既匹配不到 en: 也匹配不到 ACTION:
     → action 丢了、这一整行还被当成 en（回复变成一句垃圾，也没人发现）。 */
  const ABRIDGED = /^\s*\(earlier reply,\s*abridged\)\s*/i;
  const lines = raw.split(/\r?\n/).map((l) => l.trim().replace(ABRIDGED, '')).filter(Boolean);
  const find = (labels) => {
    for (const l of lines) {
      const low = l.toLowerCase();
      for (const label of labels) if (low.startsWith(label.toLowerCase())) return l.slice(label.length).trim();
    }
    return '';
  };
  /* ACTION 不要求在行首：模型常把标记或说明和 ACTION 挤在同一行。
     只要行内出现 "action:" 就取它后面的内容（真伪交给 assistant.allowed/run 判）。
     ⚠️ 但**参数里可能含换行**：parseReply 在开头就把整段按行切了，所以
     `write_file|C:\x.py||第一行\n第二行` 里的第二行会被切掉 —— 实测她因此写不出
     任何多行脚本（"the write tool keeps cutting my content at the newline"，
     calc.py 只剩 14 字节）。所以：**权限表里带 || 的写入类 ACTION 要按"整段原文"取**，
     不能只看那一行。 */
  const findAction = () => {
    for (const l of lines) {
      const m = l.match(/(?:^|\s)action\s*[:：]\s*(.+)$/i);
      if (m) return m[1].trim();
    }
    return '';
  };
  /* 带 || 的写入类 ACTION：从原文里定位，取到**文末**（保留其中的换行）。
     只在确实出现 "||" 时才这么干，避免把普通 ACTION 后面的闲聊也吞进来。 */
  const findActionMultiline = () => {
    const re = /(?:^|\s)action\s*[:：]\s*([a-z][a-z0-9_]*)\s*\|([\s\S]*)$/i;
    const m = raw.match(re);
    if (!m) return '';
    const rest = m[2];
    if (!rest.includes('||')) return '';           // 没有 || 就不算写入类，交给逐行逻辑
    return m[1].toLowerCase() + '|' + rest.trim();
  };
  /* 【多行 EN/ZH】实测：她念基建排班表时，名单写在 "ZH:" 的**下一行起**，
     而上面这个 find() 只取标签所在的那一行 —— 于是她每一条回答都停在冒号处，
     名单整个消失（连着好几轮都这样，看起来像她"不肯说/答不出"，其实是被解析器吃了）。
     （同一个坑之前只在带 || 的写入类 ACTION 上被发现并修过，EN/ZH 一直漏着。）
     规则：取标签行剩下的内容 + 之后所有**不是标签**的行，遇到下一个标签就停。 */
  const LBL = ['en:', 'en：', 'zh:', 'zh：', 'words:', 'words：', 'mood:', 'mood：',
    'c1:', 'c1：', 'c1zh:', 'c1zh：', 'c2:', 'c2：', 'c2zh:', 'c2zh：', 'action:', 'action：'];
  const isLabel = (l) => { const low = String(l).toLowerCase(); return LBL.some((x) => low.startsWith(x)); };
  const findMultiline = (labels) => {
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      for (const label of labels) {
        if (!low.startsWith(label.toLowerCase())) continue;
        const out = [lines[i].slice(label.length).trim()];
        for (let j = i + 1; j < lines.length; j++) { if (isLabel(lines[j])) break; out.push(lines[j]); }
        return out.filter(Boolean).join('\n').trim();
      }
    }
    return '';
  };
  const en = findMultiline(['en:', 'en：']);
  const zh = findMultiline(['zh:', 'zh：']);
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
  // 先试「整段多行」版本（写入类必须用它，否则内容会在第一个换行处被切断），没有再退回逐行版本
  const actLine = findActionMultiline() || findAction();
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

  /* EN 的兜底**不能直接用 raw**：
     模型没按格式回答时 raw 兜底是有意义的（总比什么都不说好），
     但如果这一轮**只有 ACTION 行**，raw 就是 "ACTION: proj_run|calc/mul.py" 这种东西 ——
     拿它当台词会让她把工具调用念出来（实测就是这么吐出 "(earlier reply, abridged) ACTION: …" 的）。
     所以：先用"去掉 ACTION 行"的正文兜底；正文空（纯动作轮）就返回空串，让调用方跳过朗读。 */
  const isAct = (l) => /(?:^|\s)action\s*[:：]/i.test(l);
  const prose = lines.filter((l) => !isAct(l)).join(' ').trim();
  const strippedRaw = raw.replace(/(?:^|\r?\n)\s*\(earlier reply,\s*abridged\)\s*/gi, '\n').trim();

  return { en: en || prose || (lines.some((l) => !isAct(l)) ? strippedRaw : ''), zh, words, choices, action, mood: mood || '' };
}

module.exports = {
  net, request, stream, parseReply, DEFAULT_TIMEOUT_MS };
