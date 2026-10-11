/* 口语练习：逐词清晰度打分 + 音标缓存 + 翻译器提示词
 *
 * 打分依据：whisper 的 token 概率（见 asr.js 的 groupTokens）。
 *   ⚠️ 它是"模型有多确信音频里是这个词"的**代理**，不是音素级发音评测：
 *      - 常见的词读糊了也可能高分（语言模型会补）
 *      - **句首的词天然偏低**（左侧没上下文）—— 实测 Hello 0.84 / there 0.83，
 *        而同句后面的词都在 0.96~0.99。界面上要说清楚，别让用户以为"第一个词总读不好"
 *      - 生僻词读对了也可能偏低
 *   真要做音素级评测得上强制对齐 + G2P，那是另一个工程量级。
 *
 * 音标：本地没有音标词典，只能靠模型给；但**给过一次就缓存**（ipa-cache.json），
 *      同一个词以后零成本、也不发请求。所以只看用户真正点/悬停过的词，成本极低。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/* 分档：p >= good 绿 / >= ok 黄 / 其余红。阈值可在 config 里覆盖（speakGoodP / speakOkP） */
const BANDS = [
  { key: 'good', label: '清晰', min: 0.8 },
  { key: 'ok', label: '一般', min: 0.55 },
  { key: 'poor', label: '含糊', min: 0 },
];
function thresholds(cfg) {
  const g = Number(cfg && cfg.speakGoodP);
  const o = Number(cfg && cfg.speakOkP);
  return {
    good: Number.isFinite(g) ? g : 0.8,
    ok: Number.isFinite(o) ? o : 0.55,
  };
}
function bandOf(p, cfg) {
  const t = thresholds(cfg);
  const v = Number(p);
  if (!Number.isFinite(v)) return 'ok';
  if (v >= t.good) return 'good';
  if (v >= t.ok) return 'ok';
  return 'poor';
}

/* 句首偏差补偿：
 * 第 0 个词左侧没有上下文，whisper 对它的 p 系统性偏低（实测 Hello 0.84 / there 0.83，
 * 而同句后面的词都在 0.96~0.99）。不补偿的话用户会以为"我第一个词总读不好"。
 * 补偿很小（把结构性低估抹平，不会把真读错的词洗白），且原值保留在 pRaw 里可查。
 * 关掉：config.speakPosBias = false */
const POS_BONUS = [0.12, 0.06];
function applyPosBias(words, cfg) {
  if (cfg && cfg.speakPosBias === false) return words;
  return (words || []).map((x, i) => {
    const k = POS_BONUS[i];
    if (!k || !Number.isFinite(Number(x.p))) return x;
    const p2 = Number(x.p) + k * (1 - Number(x.p));
    return Object.assign({}, x, { p: Math.round(p2 * 1000) / 1000, pRaw: Number(x.p) });
  });
}

/* words: [{w, p}] → { overall, band, words:[{w,p,pRaw,band}], counts } */
function scoreWords(words, cfg) {
  const list = applyPosBias((Array.isArray(words) ? words : []).filter((x) => x && x.w), cfg);
  const out = list.map((x) => ({ w: String(x.w), p: Number(x.p), pRaw: x.pRaw, band: bandOf(x.p, cfg) }));
  const ps = out.map((x) => x.p).filter(Number.isFinite);
  const overall = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
  return {
    overall: Math.round(overall * 1000) / 1000,
    band: bandOf(overall, cfg),
    words: out,
    counts: out.reduce((m, x) => { m[x.band] = (m[x.band] || 0) + 1; return m; }, {}),
  };
}

/* ---------------- 进步曲线：每次打分记一条 ---------------- */
const logFile = () => path.join(app.getPath('userData'), 'speak-log.json');
function readLog() {
  try {
    const j = JSON.parse(fs.readFileSync(logFile(), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j) ? j.filter((x) => x && Number.isFinite(Number(x.overall))) : [];
  } catch { return []; }
}
function logScore(entry) {
  try {
    const arr = readLog();
    arr.push({
      at: Date.now(),
      overall: Math.round((Number(entry && entry.overall) || 0) * 1000) / 1000,
      band: String((entry && entry.band) || ''),
      words: Number((entry && entry.n) || 0),
      poor: Number((entry && entry.poor) || 0),
    });
    fs.writeFileSync(logFile(), JSON.stringify(arr.slice(-800), null, 2));
  } catch {}
}
/* 按天汇总：{ days:[{date,n,avg}], total, avg, best } */
function trend(days) {
  const arr = readLog();
  const d = Math.max(1, Math.min(90, Number(days) || 14));
  const cutoff = Date.now() - d * 86400000;
  const by = {};
  for (const e of arr) {
    if (e.at < cutoff) continue;
    const k = new Date(e.at).toISOString().slice(0, 10);
    (by[k] || (by[k] = [])).push(Number(e.overall));
  }
  const list = Object.keys(by).sort().map((k) => ({
    date: k, n: by[k].length,
    avg: Math.round((by[k].reduce((a, b) => a + b, 0) / by[k].length) * 1000) / 1000,
  }));
  const all = arr.filter((e) => e.at >= cutoff).map((e) => Number(e.overall));
  return {
    days: list,
    total: all.length,
    avg: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 1000) / 1000 : 0,
    best: all.length ? Math.max.apply(null, all) : 0,
  };
}

/* ---------------- 音标缓存 ---------------- */
const ipaFile = () => path.join(app.getPath('userData'), 'ipa-cache.json');
let ipaCache = null;
function loadIpa() {
  if (ipaCache) return ipaCache;
  try {
    const j = JSON.parse(fs.readFileSync(ipaFile(), 'utf8').replace(/^\uFEFF/, ''));
    ipaCache = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { ipaCache = {}; }
  return ipaCache;
}
function saveIpa() {
  try { fs.writeFileSync(ipaFile(), JSON.stringify(ipaCache || {}, null, 2)); } catch {}
}
const key = (w) => String(w || '').trim().toLowerCase().replace(/[^a-z'-]/g, '');
/* 查缓存：返回 { word: {ipa, zh} }，只含查到的 */
function ipaGet(words) {
  const c = loadIpa();
  const out = {};
  for (const w of (Array.isArray(words) ? words : [])) {
    const k = key(w);
    if (k && c[k]) out[k] = c[k];
  }
  return out;
}
/* 写缓存 */
function ipaPut(map) {
  const c = loadIpa();
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    const kk = key(k);
    if (!kk || !v || (!v.ipa && !v.zh)) continue;
    c[kk] = { ipa: String(v.ipa || '').slice(0, 60), zh: String(v.zh || '').slice(0, 40) };
    n++;
  }
  if (n) saveIpa();
  return n;
}
/* 缺哪些（要去问模型的） */
function ipaMissing(words) {
  const c = loadIpa();
  const seen = {};
  const out = [];
  for (const w of (Array.isArray(words) ? words : [])) {
    const k = key(w);
    if (!k || c[k] || seen[k]) continue;
    seen[k] = 1;
    out.push(k);
  }
  return out;
}

function buildIpaPrompt(words) {
  return `你是英语发音词典。给下面每个单词标注**美式音标（IPA）**和简短中文意思。
只输出一个 JSON 对象：键是单词（小写原形），值是 {"ipa":"/.../","zh":"中文意思"}。
音标用斜杠包起来、只标一个最常见读音；不要解释、不要 markdown、不要多余文字。

单词：${(words || []).join(', ')}`;
}

/* ---------------- 翻译器 ---------------- */
function buildTranslatePrompt(zh, ctx) {
  const c = ctx || {};
  return `主人想用英语表达一句话，但不知道怎么说。请给出**地道、口语化**的英文说法。

【主人想说的（中文）】
${zh}

${c.scene ? '【场景】' + c.scene + '\n' : ''}要求：
- 给 1~3 种说法，从最常用到最讲究，按 natural 排序
- 每种都要：en（英文原句）、zh（中文回译，帮主人确认没跑偏）、note（什么时候用这一种，一句话）
- 每个 en 里挑 2~4 个值得记的词，给 ipa（美式音标，用斜杠包）和 zh（中文意思）
- 只输出 JSON，不要 markdown、不要解释：
{"options":[{"en":"...","zh":"...","note":"...","words":[{"w":"...","ipa":"/.../","zh":"..."}]}]}`;
}

/* 从模型返回里抠出 JSON（模型爱加 ``` 和废话） */
function parseJson(raw) {
  const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < 0) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

/* ---------------- 发音评测（"像不像"）的参考句缓存 ----------------
 * 方案依据见 发音评测可行性-20261001.md：拿"目标句的母语者 TTS"当参考，
 * 两边都算 MFCC 做 DTW，再按**参考句的词边界**把逐帧代价归到词，
 * 最后只用**相对分** S = 该词代价 / 其它词均值（绝对分会被音色差异淹没）。
 *
 * 这里缓存两样东西（key = sha1(句子文本)，同一句只算一次）：
 *   1. 参考音频：tts.js 自己已经按文本缓存 mp3，不用重复存
 *   2. **参考句的词级时间戳**：要靠 whisper 跑一遍那段 TTS 音频才有，
 *      实测 whisper-cli 能直接读 mp3（miniaudio 自带解码器），不用转 WAV
 */
const crypto = require('crypto');
const refDir = () => {
  const d = path.join(app.getPath('userData'), 'pron-cache');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
};
const refKey = (text) => crypto.createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 16);
const refFile = (text) => path.join(refDir(), refKey(text) + '.json');

function refGet(text) {
  try {
    const j = JSON.parse(fs.readFileSync(refFile(text), 'utf8').replace(/^\uFEFF/, ''));
    return (j && Array.isArray(j.words) && j.words.length) ? j : null;
  } catch { return null; }
}
function refPut(text, words, extra) {
  try {
    fs.writeFileSync(refFile(text), JSON.stringify(Object.assign({
      text: String(text || ''), words: words || [], at: Date.now(),
    }, extra || {}), null, 2));
    return true;
  } catch { return false; }
}

module.exports = {
  BANDS, bandOf, scoreWords, thresholds, applyPosBias, POS_BONUS, keyOf: key,
  logFile, readLog, logScore, trend,
  ipaFile, loadIpa, ipaGet, ipaPut, ipaMissing, buildIpaPrompt,
  buildTranslatePrompt, parseJson,
  refDir, refKey, refFile, refGet, refPut,
};
