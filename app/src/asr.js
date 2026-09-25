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
const MIRRORS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
];

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

function status(cfgModel) {
  const name = MODELS[cfgModel] ? cfgModel : 'tiny.en';
  return {
    engine: 'whisper',
    binary: fs.existsSync(binPath()),
    model: name,
    hasModel: hasModel(name),
    modelPath: modelPath(name),
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, size: m.size, ready: hasModel(id) })),
    downloading: downloading ? { ...downloading } : null,
  };
}

/* 下载模型（带进度回调）。支持 http 重定向、写到 .part 再改名 */
function downloadModel(name, onProgress) {
  const m = MODELS[name] || MODELS['tiny.en'];
  if (downloading) return Promise.reject(new Error('已有模型正在下载'));
  const dest = modelPath(name);
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
      if (idx >= MIRRORS.length) { cleanup(); done(lastErr || new Error('全部镜像都失败')); return; }
      downloading.got = 0;                // 换镜像要重新计数，否则进度条会超过 100%
      const url = MIRRORS[idx++] + m.file;
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
              if (fs.statSync(part).size < 1024 * 1024) throw new Error('文件过小，可能下载失败');
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

/* 16kHz 单声道 WAV（Buffer）→ 文本。失败抛错，调用方决定是否回退 */
function transcribe(wavBuf, cfgModel) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(binPath())) return reject(new Error('缺少 whisper-cli.exe'));
    const name = MODELS[cfgModel] ? cfgModel : 'tiny.en';
    if (!hasModel(name)) return reject(new Error('语音模型还没下载'));
    const mp = modelPath(name);
    const base = path.join(os.tmpdir(), 'dayu-asr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    const wav = base + '.wav';
    try { fs.writeFileSync(wav, wavBuf); } catch (e) { return reject(e); }

    const args = ['-m', mp, '-f', wav, '-l', 'en', '-nt', '-otxt', '-of', base, '-np'];
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
      try { text = fs.readFileSync(base + '.txt', 'utf8'); } catch {}
      try { fs.unlinkSync(wav); } catch {}
      try { fs.unlinkSync(base + '.txt'); } catch {}
      if (!text) {
        // 没写成 txt 就从 stdout 兜底解析
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
      resolve(text);
    });
  });
}

module.exports = { status, downloadModel, transcribe, modelPath, binPath, MODELS, hasModel };
