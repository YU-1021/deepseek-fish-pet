// 视觉模型调用：把截图 + 问题发给一个 OpenAI 兼容的多模态模型，让它"看懂"画面。
// 默认用 DeepSeek 自己的 deepseek-flash（视觉），复用主模型的 apiBase/apiKey。
// 也可以单独配 visionBase / visionKey / visionModel 换别的多模态模型。
//
// 注意：必须带超时。游戏助手主循环是 await 这个调用的，没有超时的话
// 一次黑洞连接就会让循环既不前进也不响应"停"（stopFlag 只在间隔等待里检查）。
//
// 错误信息复用 llm.js 的翻译（net.wrapNetErr / net.wrapHttpErr）：
//   这里原本自己抛 `HTTP ${status} ${body}` 和裸网络错误 —— 和 llm.js 修之前一模一样。
//   更糟的是 screen_look 那头是 `catch { text = '' }` 静默降级，
//   于是 key 过期 / 余额不足 / 网络不通，用户在界面上只会觉得"她好像没看见"。
const llm = require('./llm');

async function describe(cfg, imageDataUrl, question, detail) {
  const base = String(cfg.visionBase || cfg.apiBase || '').replace(/\/+$/, '');
  const key = String(cfg.visionKey || cfg.apiKey || '');
  const model = cfg.visionModel || 'deepseek-flash';
  if (!base || !key) throw new Error('未配置视觉模型（config.json 里填 visionKey/visionBase，或直接复用主模型的 apiKey）');

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
            /* ⚠️ 默认从 'low' 改成 'high'：卡片上的干员名只有 ~15px，low 会把它压没。
         实测（公招计算器找水月）：high 能一次读准，low 连名字都糊。
         assistant.js 那条路径本来就传 cfg.visionDetail || 'high'，只有直接调 describe 的
         地方会吃到这个默认值 —— 改成 high 免得以后踩。 */
            { type: 'image_url', image_url: { url: imageDataUrl, detail: detail || 'high' } },
          ],
        }],
        /* ⚠️ 必须显式声明 thinking —— 和 llm.js 一样。
         * 起因：用户反馈"看屏幕 6-7 秒太慢"。分段计时后发现抓帧只要 22ms（热态）
         * 而视觉调用要 6~8.5 秒，可模型只输出 19 个字。
         * A/B 实测（同一个"找左下角开始按钮并给坐标"的问题）：
         *   不带 thinking 参数 → 6080ms / 8526ms，usage.out=1100~1600，
         *                        并且返回里带 reasoning_content 1966~2849 字 ← 全花在这
         *   thinking 显式关闭   →  932ms /  650ms，usage.out=7，答案一样（甚至更准）
         * 即 **6.5~13 倍提速，输出 token 降到 1/150**。
         * 默认关闭；要她"深度思考"再把 config.visionThinking 设 true。 */
        thinking: { type: (cfg && cfg.visionThinking) ? 'enabled' : 'disabled' },
      }),
      /* ⚠️ signal 必须放在 **fetch 的选项**里，不能写进 body 的 JSON。
         我重构这个文件时曾把它挪进 JSON.stringify 里面 —— 结果 AbortSignal.timeout()
         完全失效，一次不响应的请求会挂到 undici 自己的 300 秒默认超时才报错，
         而游戏助手主循环就卡在那儿既不前进也不响应"停"（实测跑了 304.6s）。
         测试里那条"永不响应 → 超时"就是为了守这个。 */
      signal,
    });
  } catch (e) {
    throw llm.net.wrapNetErr(e, ms, base);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw llm.net.wrapHttpErr(res.status, body);
  }
  const json = await res.json().catch((e) => { throw llm.net.wrapNetErr(e, ms, base); });
  /* ★ 所有视觉回答统一带来源标签 ✗→✓（2026-10-10 主人的要求）★
     主人原话：「视觉模型太拉了，让她能知道是哪个视觉工具运作，更好知道是哪个工具错了」
     ★ 为什么在**这一层**加✗★：`screen_look` / `tile_read` / `strip_read` /
       `icon_pick` / `grid_scan` / `som_look` ★全都走这里** ✗ ——
       一处加上 ✓，★ 任何一条回答就都能追到「这是视觉模型说的」 ✓
       （而 OCR 会说「OCR 实际读到的文字」✓、模板会说「相似度」✓、
        UIA 会说 uia-hwnd ✓ —— ★那几个本来就带来源 ✓★）
     ★★ 注意 ✗：标签只说明来源 ✓，★**不**代表它可信 ✗★ ——
       实测它给的位置会漂（同一处问四次给四种答案 ✓）。
       ★ 所以拿去点东西前，必须用**另一个来源**复核 ✓★（见规程「铁律 4」✓）。 */
  const _c = json?.choices?.[0]?.message?.content || '';
  return _c ? ('[视觉模型·看图] ' + _c) : '';
}

module.exports = { describe };
