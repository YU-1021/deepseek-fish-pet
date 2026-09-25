/* 大肥鱼桌宠 · 语音合成（Edge 神经语音，英文音色）
 * 说明：桌宠说的是英语，所以这里选的都是英文神经音色。
 * 合成结果按 音色+语速+音调+文本 缓存到 userData/tts-cache，重复句子不再联网。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app } = require('electron');
const WebSocket = require('../vendor/ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CRLF = String.fromCharCode(13, 10);

/* 音色表：value 送 Edge，label 给界面看 */
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声（推荐）', lang: 'zh-CN' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼女声', lang: 'zh-CN' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声', lang: 'zh-CN' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳男声', lang: 'zh-CN' },
  { id: 'en-US-AnaNeural', label: '小安娜 · 英文童声', lang: 'en-US' },
  { id: 'en-US-AriaNeural', label: '阿丽娅 · 英文温柔', lang: 'en-US' },
  { id: 'en-US-JennyNeural', label: '珍妮 · 英文亲切', lang: 'en-US' },
  { id: 'en-US-MichelleNeural', label: '米歇尔 · 英文知性', lang: 'en-US' },
  { id: 'en-US-AvaMultilingualNeural', label: '艾娃 · 英文自然', lang: 'en-US' },
  { id: 'en-US-EmmaMultilingualNeural', label: '艾玛 · 英文清亮', lang: 'en-US' },
  { id: 'en-GB-SoniaNeural', label: '索尼娅 · 英伦女声', lang: 'en-GB' },
  { id: 'en-US-GuyNeural', label: '盖伊 · 英文男声', lang: 'en-US' },
  { id: 'en-US-AndrewMultilingualNeural', label: '安德鲁 · 英文沉稳男声', lang: 'en-US' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 日语女声', lang: 'ja-JP' },
];

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/* 语气预设：rate/pitch 为最终值（1.0 是原声）；与参考软件一致，可被 ttsRate/ttsPitch 覆盖 */
const STYLES = {
  tsundere: { label: '傲娇少女（推荐）', rate: 1.02, pitch: 1.12 },
  cute: { label: '元气可爱', rate: 1.08, pitch: 1.22 },
  gentle: { label: '温柔小声', rate: 0.90, pitch: 1.04 },
  cool: { label: '清冷御姐', rate: 0.96, pitch: 0.94 },
};
const DEFAULT_STYLE = 'tsundere';

const voiceById = (id) => VOICES.find((v) => v.id === id) || VOICES.find((v) => v.id === DEFAULT_VOICE);
function resolveStyle(id) { return STYLES[id] ? id : (STYLES[DEFAULT_STYLE] ? DEFAULT_STYLE : Object.keys(STYLES)[0]); }

function generateSecMsGecToken() {
  const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return crypto.createHash('sha256')
    .update(String(rounded) + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex').toUpperCase();
}

const escapeXml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const toPercent = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '+0%';
  const pct = Math.round((n - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
};

function cacheDir() {
  const dir = path.join(app.getPath('userData'), 'tts-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/* 把长句切成小段，避免单次请求过长、也提高命中缓存的概率 */
function toSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.match(/[^.!?;:]+[.!?;:]*/g) || [t];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 180 && cur) { out.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 12);
}

function synthesizeOnce(voice, text, outPath, rate, pitch) {
  return new Promise((resolve, reject) => {
    const secMsGec = generateSecMsGecToken();
    const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (e) { reject(e); return; }

    const chunks = [];
    let settled = false;
    let sawEnd = false;                 // 收到 Path:turn.end 才算这次合成完整
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('TTS 超时')); }
    }, 45000);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) { reject(err); return; }
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) { reject(new Error('音频过短 ' + buf.length)); return; }
      /* 原子落盘：先写 .part 再改名。否则写到一半异常会留下半截 mp3，
         而它已经被当成"缓存命中"（只判 size>100），以后每次都返这段残缺音频，永不自愈。 */
      const tmp = outPath + '.part';
      try {
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, outPath);
        resolve(buf.length);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        reject(e);
      }
    }

    ws.on('open', () => {
      const requestId = crypto.randomBytes(16).toString('hex');
      const speechConfig = { context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const lang = voice.split('-').slice(0, 2).join('-');
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
        + `<voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="default">`
        + `${escapeXml(text)}</prosody></voice></speak>`;
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send('X-RequestId:' + requestId + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    });

    ws.on('message', (data, isBinary) => {
      if (settled) return;
      if (!isBinary) { if (String(data).includes('Path:turn.end')) { sawEnd = true; finish(null); } return; }
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) { const body = raw.subarray(idx + marker.length); if (body.length) chunks.push(body); }
      else if (raw.length) chunks.push(raw);
    });

    ws.on('error', (e) => finish(e instanceof Error ? e : new Error(String((e && e.message) || e))));
    ws.on('close', (e) => {
      if (settled) return;
      /* 异常关闭（1006/连接抖动）时，只要已经收到部分音频，以前就按成功收尾了 ——
         于是残缺 mp3 被写进**最终缓存路径**，以后每次命中都返回它。现在必须收到
         turn.end 才算成功，否则抛错走重试。 */
      if (sawEnd && chunks.length) finish(null);
      else finish(new Error(`连接中断 code=${(e && e.code) || ''}`));
    });
  });
}

async function oneSentence(voice, rateNum, pitchNum, text) {
  const rate = toPercent(rateNum);
  const pitch = toPercent(pitchNum);
  const key = crypto.createHash('sha256').update(`${voice}|${rate}|${pitch}|${text}`).digest('hex');
  const file = path.join(cacheDir(), `edge-${key}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 100) return { file, cached: true, key };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await synthesizeOnce(voice, text, file, rate, pitch); return { file, cached: false, key }; }
    catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (!msg.includes('1006')) break;
    }
  }
  throw lastErr || new Error('语音合成失败');
}

/* 对外：合成整段文本，返回 { ok, dataUrl, url, voice, cached } */
async function synthesize(text, opts = {}) {
  const clean = String(text || '').replace(/\[[^\]]*\]/g, '').trim();
  if (!clean) throw new Error('没有可朗读的文本');
  const voice = voiceById(opts.voice).id;
  const styleId = resolveStyle(opts.style);
  const style = STYLES[styleId];
  const pick = (v, base) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : base);
  const rateNum = pick(opts.rate, style.rate);
  const pitchNum = pick(opts.pitch, style.pitch);

  const sentences = toSentences(clean);
  if (!sentences.length) throw new Error('没有可朗读的文本');

  const pieces = [];
  let allCached = true;
  let firstKey = '';
  for (const s of sentences) {
    const r = await oneSentence(voice, rateNum, pitchNum, s);
    if (!r.cached) allCached = false;
    if (!firstKey) firstKey = r.key;
    pieces.push(fs.readFileSync(r.file));
  }
  const buf = Buffer.concat(pieces);

  /* 单段直接复用缓存文件，多段拼一个混合文件 */
  let file;
  if (sentences.length === 1) {
    file = path.join(cacheDir(), `edge-${firstKey}.mp3`);
  } else {
    /* key 必须包含"内容 + 音色 + 语速 + 音调"：以前只用各段字节长度拼，
       同一段文字换音色就可能撞 key，于是 url/file 指向别人的音频，
       而 dataUrl 是这次新拼的 —— 两者内容不一致（渲染层只用 dataUrl 所以暂时听不出来）。 */
    const sig = voice + '|' + styleId + '|' + rateNum + '|' + pitchNum + '|' + sentences.join('\u0001');
    const key = crypto.createHash('sha256').update(sig + '|' + pieces.map((b) => b.length).join('-')).digest('hex');
    file = path.join(cacheDir(), `mix-${key}.mp3`);
    if (!fs.existsSync(file)) {
      const tmp = file + '.part';
      try { fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); }
      catch { try { fs.unlinkSync(tmp); } catch {} }
    }
  }
  return {
    ok: true,
    file,
    url: pathToFileURL(file).href,
    dataUrl: 'data:audio/mpeg;base64,' + buf.toString('base64'),
    voice,
    style: styleId,
    rate: rateNum,
    pitch: pitchNum,
    cached: allCached,
  };
}

module.exports = { synthesize, VOICES, STYLES, DEFAULT_VOICE, DEFAULT_STYLE, resolveStyle, voiceById };
