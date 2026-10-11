/* 本地语音识别（whisper.cpp）—— 完全离线，不依赖任何在线服务
 *
 * 为什么换掉浏览器自带的 Web Speech API：它走 Google 在线语音服务，
 * 国内网络下会直接报 network 识别不了（实测）。whisper.cpp 是本地推理，
 * 任何机器、任何网络都能用，也不需要 Key。
 *
 * 组成：
 *   二进制  app/vendor/whisper/whisper-cli.exe + 依赖 dll（随包发布，约 15MB）
 *   模型    ggml-*.bin（体积大，首次使用时从镜像下载，缓存在 userData/asr）
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const MODELS = {
  'tiny.en': { file: 'ggml-tiny.en.bin', size: 75 * 1024 * 1024, label: 'Tiny（最快，约 75MB）' },
  'base.en': { file: 'ggml-base.en.bin', size: 142 * 1024 * 1024, label: 'Base（更准，约 142MB）' },
  'small.en': { file: 'ggml-small.en.bin', size: 466 * 1024 * 1024, label: 'Small（最准，约 466MB）' },
};
/* 顺序 = 尝试顺序。**国内源放第一顺位**：实测 hf-mirror / huggingface 经常整站连不上
   （hf-mirror 还会 302 跳到 xethub CDN，长连接必卡死），
   而 ai.gitcode.com（国内 GitHub 镜像）稳定可达、支持 Range 断点续传。 */
const MIRRORS = [
  'https://ai.gitcode.com/hf_mirrors/ai-gitcode/whisper.cpp/resolve/main/',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
];

/* ---------------- VAD（语音活动检测 / 跳过静音） ----------------
 * whisper 自带 VAD，但要额外一个 silero 模型。**实测收益很大**：
 *   65.8 秒音频（前后各 30 秒静音 + 中间 5.8 秒说话）
 *     不用 VAD：3689 ms，而且静音段产生幻觉词（开头冒 "you"、结尾冒 "Thank you."）
 *     用 VAD  ：1734 ms（**快 53%**），输出干净
 * 模型：仓库 models/ 里那份叫 for-tests-silero-v6.2.0-ggml.bin，实测功能正常
 *   （whisper 日志确认：model type: silero-16k / version 6.2.0 / n_encoder_layers 4）；
 *   官方版在 HF 的 ggml-org/whisper-vad，网络通的时候会优先走官方。
 * 下载用 name='vad' 调 downloadModel()。 */
const VAD = {
  id: 'vad',
  file: 'ggml-silero-v6.2.0.bin',
  size: 885098,
  urls: [
    'https://ghproxy.net/https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/for-tests-silero-v6.2.0-ggml.bin',
    'https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
    'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  ],
};
const vadPath = () => path.join(modelDir(), VAD.file);
const hasVad = () => { try { return fs.statSync(vadPath()).size > 300 * 1024; } catch { return false; } };

let downloading = null;   // { name, got, total }

/* 二进制路径：打包后 exe 会被解到 app.asar.unpacked 下（原生程序不能放 asar 里跑） */
function binDir() {
  const dev = path.join(__dirname, '..', 'vendor', 'whisper');
  const packed = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'vendor', 'whisper');
  if (fs.existsSync(path.join(dev, 'whisper-cli.exe'))) return dev;
  if (fs.existsSync(path.join(packed, 'whisper-cli.exe'))) return packed;
  return dev;
}
const binPath = () => path.join(binDir(), 'whisper-cli.exe');

/* 模型目录：外部优先（可以把 ggml-*.bin 直接丢进来），否则用 userData/asr */
function modelDir() {
  const d = path.join(app.getPath('userData'), 'asr');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function modelPath(name) {
  const m = MODELS[name] || MODELS['tiny.en'];
  const local = path.join(modelDir(), m.file);
  if (fs.existsSync(local)) return local;
  // 也认 app/vendor/whisper 下随手放的模型
  const vendored = path.join(binDir(), m.file);
  if (fs.existsSync(vendored)) return vendored;
  return local;
}
const hasModel = (name) => { try { return fs.statSync(modelPath(name)).size > 1024 * 1024; } catch { return false; } };

/* 配的模型还没下 → 退到已下载里最好的那档，别让识别直接失败（用户可能还没点下载） */
function pickModel(cfgModel) {
  const want = MODELS[cfgModel] ? cfgModel : 'base.en';
  if (hasModel(want)) return want;
  for (const n of ['small.en', 'base.en', 'tiny.en']) if (hasModel(n)) return n;
  return want;
}

function status(cfgModel) {
  const name = pickModel(cfgModel);
  return {
    engine: 'whisper',
    binary: fs.existsSync(binPath()),
    model: name,
    hasModel: hasModel(name),
    modelPath: modelPath(name),
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, size: m.size, ready: hasModel(id) })),
    vad: { id: VAD.id, label: 'VAD 静音检测（约 0.9MB，建议装：免幻觉 + 快一半）', size: VAD.size, ready: hasVad(), path: vadPath() },
    downloading: downloading ? { ...downloading } : null,
  };
}

/* 下载模型（带进度回调）。支持 http 重定向、写到 .part 再改名。
   name='vad' 时下载 VAD 模型（URL 列表不同，所以单独取）。 */
function downloadModel(name, onProgress) {
  const isVad = (name === VAD.id);
  const m = isVad ? { file: VAD.file, size: VAD.size } : (MODELS[name] || MODELS['tiny.en']);
  if (downloading) return Promise.reject(new Error('已有模型正在下载'));
  const dest = isVad ? vadPath() : modelPath(name);
  const part = dest + '.part';
  downloading = { name, got: 0, total: m.size };
  return new Promise((resolve, reject) => {
    let idx = 0;
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      downloading = null;                 // 任何结局都必须把状态放掉，否则永久"下载中"
      err ? reject(err) : resolve(val);
    };
    const cleanup = () => { try { fs.unlinkSync(part); } catch {} };
    let lastErr = null;
    const tryNext = (err) => {
      if (settled) return;
      if (err) lastErr = err;
      const total = isVad ? VAD.urls.length : MIRRORS.length;
      if (idx >= total) { cleanup(); done(lastErr || new Error('全部镜像都失败')); return; }
      downloading.got = 0;                // 换镜像要重新计数，否则进度条会超过 100%
      const url = isVad ? VAD.urls[idx] : (MIRRORS[idx] + m.file);
      idx++;
      get(url, 0);
    };
    const get = (url, depth) => {
      if (settled) return;
      if (depth > 5) return tryNext(new Error('重定向过多'));
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'dayu-pet' } }, (res) => {
        if (settled) { try { res.resume(); } catch {} return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, url).href, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return tryNext(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length']) || m.size;
        downloading.total = total;
        const out = fs.createWriteStream(part);
        /* 传输中途被重置（RST）时，Node 只会给 res 发 'aborted'/'error'，
           而 res.pipe(out) 会把错误吞掉 → out 既不 finish 也不 error，
           以前就这样永远挂着：downloading 永远非 null，之后任何下载都被拒，只能重启。 */
        const onStreamFail = (e) => {
          if (settled) return;
          try { out.destroy(); } catch {}
          cleanup();
          tryNext(e instanceof Error ? e : new Error('连接中断'));
        };
        res.on('error', onStreamFail);
        res.on('aborted', () => onStreamFail(new Error('连接被中断')));
        req.on('error', onStreamFail);
        res.on('data', (c) => {
          downloading.got += c.length;
          try { onProgress && onProgress({ got: downloading.got, total }); } catch {}
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (settled) return;
            try {
              /* 完整性下限：whisper 模型都 ≥75MB，用 1MB 兜底；
                 VAD 模型只有 864KB，必须按它自己的预期大小算 —— 否则会被误判成"下载失败" */
              const minOk = Math.min(1024 * 1024, Math.floor(m.size * 0.9));
              if (fs.statSync(part).size < minOk) throw new Error('文件过小，可能下载失败');
              fs.renameSync(part, dest);
              done(null, { ok: true, path: dest });
            } catch (e) { cleanup(); tryNext(e); }
          });
        });
        out.on('error', onStreamFail);
      });
      req.on('error', (e) => { if (!settled) tryNext(e); });
      req.setTimeout(30000, () => { req.destroy(new Error('超时')); });
    };
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
    tryNext(null);
  });
}

/* whisper 的 token 流 → 单词（带概率）
 * 分组规则：**前导空格** = 新词开始；没有前导空格的 token 是上一个词的碎片（BPE 续接）。
 * 纯标点/符号的 token 直接跳过 —— 它们的 p 没有意义（实测句号的 p 只有 0.48，
 * 把它算进 "there." 会把一个好词拖成"含糊"）。
 * p 的含义：模型有多确信"这段音频对应这个词"。**不是音素级发音评测**，
 * 常见的词读糊了也可能高分（语言模型会补）。当"读清楚了没"的代理用。 */
function groupTokens(tokens) {
  const words = [];
  let cur = null;
  for (const tk of (tokens || [])) {
    const raw = String(tk && tk.text != null ? tk.text : '');
    const t = raw.trim();
    if (!t) continue;
    if (!/[a-zA-Z0-9]/.test(t)) continue;                 // 纯标点/符号
    if (/^\[.*\]$/.test(t) || /^<\|.*\|>$/.test(t)) continue;   // [BLANK_AUDIO] 之类
    const p = Number(tk && tk.p);
    const startsWord = /^\s/.test(raw) || !cur;
    if (startsWord) { cur = { w: t, ps: [], from: null, to: null }; words.push(cur); }
    else cur.w += t;
    if (Number.isFinite(p)) cur.ps.push(p);
    const off = tk && tk.offsets;
    if (off) { if (cur.from == null) cur.from = off.from; cur.to = off.to; }
  }
  return words
    .map((x) => {
      const ps = x.ps;
      const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
      return {
        w: x.w.replace(/^[^\w']+|[^\w']+$/g, ''),
        p: mean == null ? null : Math.round(mean * 1000) / 1000,
        pMin: ps.length ? Math.round(Math.min.apply(null, ps) * 1000) / 1000 : null,
        from: x.from, to: x.to,
      };
    })
    .filter((x) => x.w && x.p != null);
}

/* 静音裁剪：whisper 对首尾长静音很敏感（会把静音也解码出幻觉词，还会拖慢）。
 * **纯能量法，不需要额外模型**（whisper 自带的 VAD 要另下一个 silero 模型，网络不通时用不了）。
 * 按 20ms 窗算 RMS，掐掉首尾低于"峰值 8%"的部分，前后各留 100ms 缓冲。 */
function trimSilence(wavBuf) {
  try {
    const b = wavBuf;
    if (!Buffer.isBuffer(b) || b.length < 44) return wavBuf;
    let off = 12, dataOff = -1, dataLen = 0, fmtOff = -1;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const sz = b.readUInt32LE(off + 4);
      if (id === 'fmt ') fmtOff = off + 8;
      if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
      off += 8 + sz + (sz % 2);
    }
    if (dataOff < 0 || dataLen < 6400) return wavBuf;
    const channels = fmtOff >= 0 ? b.readUInt16LE(fmtOff + 2) : 1;
    const rate = fmtOff >= 0 ? b.readUInt32LE(fmtOff + 4) : 16000;
    const bits = fmtOff >= 0 ? b.readUInt16LE(fmtOff + 14) : 16;
    if (bits !== 16 || !rate) return wavBuf;
    const frame = 2 * channels;
    const win = Math.floor(rate * 0.02) * frame;                 // 20ms
    const total = Math.min(dataLen, b.length - dataOff);
    const nWin = Math.floor(total / win);
    if (nWin < 3) return wavBuf;
    const rms = [];
    let peak = 0;
    for (let w = 0; w < nWin; w++) {
      let sum = 0;
      for (let i = 0; i + frame <= win; i += frame) {
        const s = b.readInt16LE(dataOff + w * win + i);
        sum += s * s;
      }
      const r = Math.sqrt(sum / (win / frame));
      rms.push(r);
      if (r > peak) peak = r;
    }
    const th = Math.max(120, peak * 0.08);
    let a = 0, z = nWin - 1;
    while (a < nWin && rms[a] < th) a++;
    while (z > a && rms[z] < th) z--;
    if (a === 0 && z === nWin - 1) return wavBuf;                // 本来就没静音
    /* 头部缓冲要留够：实测只留 100ms 时，句首词的 p 会从 0.84 掉到 0.77
       （切得太贴，模型少了起音的那点余量）。尾部 100ms 够用。 */
    const padIn = Math.floor(rate * 0.28) * frame;
    const padOut = Math.floor(rate * 0.1) * frame;
    const start = Math.max(0, a * win - padIn);
    const end = Math.min(total, (z + 1) * win + padOut);
    if (end - start < 6400) return wavBuf;
    const out = Buffer.concat([b.slice(0, dataOff), b.slice(dataOff + start, dataOff + end)]);
    out.writeUInt32LE(end - start, dataOff - 4);                 // data 大小
    out.writeUInt32LE(out.length - 8, 4);                        // RIFF 大小
    return out;
  } catch { return wavBuf; }
}

/* 16kHz 单声道 WAV → { text, words, vad }。失败抛错，调用方决定是否回退
 * opts.vad=false 关掉 VAD；opts.vadThreshold 调灵敏度（0~1，默认 0.5） */
function transcribeDetailed(wavBuf, cfgModel, opts) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(binPath())) return reject(new Error('缺少 whisper-cli.exe'));
    const name = pickModel(cfgModel);
    if (!hasModel(name)) return reject(new Error('语音模型还没下载（设置里点「下载语音模型」）'));
    const mp = modelPath(name);
    const base = path.join(os.tmpdir(), 'dayu-asr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    /* ext 默认 'wav'。传 'mp3' 等其它格式时**不能做静音裁剪** —— trimSilence 是按 PCM 解析字节的，
       拿去处理 mp3 会把文件改坏。whisper-cli 自己能解 mp3（miniaudio 自带解码器）。 */
    const ext = String((opts && opts.ext) || 'wav').replace(/[^a-z0-9]/gi, '') || 'wav';
    const wav = base + '.' + ext;
    const trimmed = (ext === 'wav') ? trimSilence(wavBuf) : wavBuf;
    try { fs.writeFileSync(wav, trimmed); } catch (e) { return reject(e); }

    /* -ojf: 输出含 token 概率 + 词级时间戳的完整 JSON（逐词打分和逐词归因都靠它）
       **绝对不能加 -nt**：实测 -nt（"不要时间戳"）会把 JSON 里 token 的 offsets 一起关掉 ——
         加 -nt  → 15 个 token 只有 3 个有非零时间跨度（前两个词吃掉整段、其余全是零长）
         不加 -nt → 16 个 token 有 11 个正常（Hello[170-760] / practice[2680-3210] …）
       文字的干净度不受影响：JSON 的 transcription[0].text 始终是纯文本，没有时间戳前缀。
       --vad: 只处理语音段（跳过静音：免幻觉 + 快一半，见文件上方 VAD 注释） */
    const useVad = !(opts && opts.vad === false) && hasVad();
    const args = ['-m', mp, '-f', wav, '-l', 'en', '-ojf', '-of', base, '-np'];
    if (useVad) {
      args.push('--vad', '-vm', vadPath());
      const vt = Number(opts && opts.vadThreshold);
      if (Number.isFinite(vt) && vt > 0 && vt < 1) args.push('-vt', String(vt));
    }
    let child;
    try { child = spawn(binPath(), args, { cwd: binDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { try { fs.unlinkSync(wav); } catch {} return reject(e); }

    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('识别超时')); }, 60000);
    child.on('error', (e) => { clearTimeout(timer); try { fs.unlinkSync(wav); } catch {} reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      let text = '';
      let words = [];
      try {
        const j = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
        const tr = (j && j.transcription && j.transcription[0]) || null;
        if (tr) { text = String(tr.text || ''); words = groupTokens(tr.tokens); }
      } catch {}
      try { fs.unlinkSync(wav); } catch {}
      try { fs.unlinkSync(base + '.json'); } catch {}
      try { fs.unlinkSync(base + '.txt'); } catch {}
      if (!text) {
        // 没写成 json 就从 stdout 兜底解析
        text = out.split(/\r?\n/)
          .filter((l) => l && !/^\[/.test(l.trim()) && !/load_backend|read_audio_data|whisper_|ggml_|main:/.test(l))
          .join(' ');
      }
      // 清掉 whisper 的时间戳 / 非语音标注（[BLANK_AUDIO]、[ Silence ]、(humming)、(music)…）
      text = String(text || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      resolve({ text, words, vad: useVad });
    });
  });
}

/* 只取文本（老接口，保留） */
async function transcribe(wavBuf, cfgModel, opts) {
  const r = await transcribeDetailed(wavBuf, cfgModel, opts);
  return r.text;
}

module.exports = {
  status, downloadModel, transcribe, transcribeDetailed, groupTokens, trimSilence, pickModel,
  modelPath, binPath, MODELS, hasModel,
  VAD, vadPath, hasVad,
};
