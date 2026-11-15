/**
 * 语音识别端到端冒烟：真起 petd → 真 WS → 本机 SAPI 合成 16k WAV → whisper.cpp 真识别。
 *
 * 验证：
 *   1. asr.status / asr.models：whisper 二进制与 base 模型就绪；
 *   2. asr.transcribe：整段 WAV 能识别出中文，且唤醒词能命中（含模糊匹配）；
 *   3. asr.listen.start/feed/stop：PCM 分片喂进去，VAD 切句、识别、asr.segment 事件；
 *   4. 优雅退出。
 *
 * 依赖本机已有 whisper-cli（旧桌宠 app/vendor/whisper）与模型
 * （%APPDATA%/dayu-pet/asr/ggml-base.bin），不联网。
 *
 * 跑法：
 *   node scripts/asr-smoke.mjs               # 临时 home，跑完删
 *   node scripts/asr-smoke.mjs --home D:\x  # 保留 home 便于检查
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argHomeIdx = process.argv.indexOf('--home');
const keep = argHomeIdx >= 0;
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-asr-smoke-'));

const legacyAsrDir = path.join(process.env.APPDATA ?? os.homedir(), 'dayu-pet', 'asr');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      asr: {
        enabled: true,
        binaryDir: '',
        modelDir: legacyAsrDir,
        model: 'base',
        language: 'zh',
        useVad: true,
        vadThreshold: 0.5,
        prompt: '你好大肥鱼。大肥鱼。小鱼。',
        wakeEnabled: true,
        wakeWords: ['你好大肥鱼', '大肥鱼', '你好大飞鱼'],
        autoChat: false,
        sampleRate: 16000,
        energyThreshold: 0.012,
        minSpeechMs: 300,
        silenceMs: 600,
        maxSegmentMs: 15000,
      },
      chat: { maxToolRounds: 0 },
    },
    null,
    2
  ) + '\n',
  'utf8'
);

const child = spawn(process.execPath, ['dist/index.js', '--home', home, '--port', '0', '--echo'], {
  cwd: appDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => {
  stdout += d.toString('utf8');
});
child.stderr.on('data', (d) => {
  stderr += d.toString('utf8');
});

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`READY 超时；stderr=${stderr.slice(-2000)}`)), 30000);
    const check = () => {
      const m = /(^|\n)(\{[^\n]*"type":"ready"[^\n]*\})/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[2]));
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`进程提前退出 code=${child.exitCode}；stderr=${stderr.slice(-2000)}`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function makeClient(ws) {
  const waiters = [];
  const events = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === 'event') events.push(f);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.match(f)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
  });
  return {
    events,
    waitFrame(match, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待帧超时：${label}`)), timeoutMs);
        waiters.push({ match, resolve, reject, timer });
      });
    },
  };
}

async function call(ws, client, method, params, timeoutMs = 30000) {
  const id = 'asr-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 6000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-asr-smoke', version: '0.0.1' } }));
    });
    ws.on('message', function onHello(raw) {
      const f = JSON.parse(raw.toString());
      if (f.type !== 'hello') return;
      clearTimeout(timer);
      ws.off('message', onHello);
      resolve({ ws, hello: f });
    });
    ws.once('error', (e) => reject(e));
  });
}

/** 用本机 SAPI 合成 16k 单声道 WAV（离线，不依赖 Edge） */
function synthesize(text) {
  const wav = path.join(home, 'speech.wav');
  const txt = path.join(home, 'speech.txt');
  fs.writeFileSync(txt, text, 'utf8');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(appDir, 'scripts', 'sapi-tts.ps1'),
      '-OutFile',
      wav,
      '-TextFile',
      txt,
      '-Voice',
      'Microsoft Huihui Desktop',
      '-SampleRate',
      '16000',
    ]);
    let err = '';
    ps.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    ps.on('close', (code) => {
      if (code !== 0) reject(new Error(`SAPI 合成失败 code=${code}：${err.slice(-500)}`));
      else resolve(wav);
    });
  });
}

/** 从 WAV 里取 PCM 数据区（简单解析 RIFF） */
function wavPcm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return { pcm: buf, sampleRate: 16000 };
  let offset = 12;
  let sampleRate = 16000;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(offset + 12);
    if (id === 'data') return { pcm: buf.subarray(offset + 8, offset + 8 + Math.min(size, buf.length - offset - 8)), sampleRate };
    offset += 8 + size + (size % 2);
  }
  return { pcm: Buffer.alloc(0), sampleRate };
}

const checks = [];
function check(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  checks.push(msg);
}

let childExited = false;
child.once('exit', () => {
  childExited = true;
});

try {
  const ready = await waitForReady();
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const status = await call(ws, client, 'asr.status');
  check(status.ok, 'asr.status 可调用');
  check(status.data.enabled === true, '语音识别已启用');
  check(status.data.engine === 'whisper.cpp', '引擎是 whisper.cpp');
  check(status.data.binary.found === true, `找到 whisper-cli（${status.data.binary.path ?? '未找到'}）`);
  check(status.data.model === 'base', '当前模型 base');
  check(status.data.models.modelReady !== false, '模型就绪状态正常');

  const models = await call(ws, client, 'asr.models');
  check(models.ok, 'asr.models 可调用');
  check(models.data.models.length === 3, '列出 tiny/base/small 三档');
  check(models.data.models.find((m) => m.id === 'base')?.ready === true, 'base 模型已就绪');

  const text = '你好大肥鱼，今天天气不错，陪我聊两句吧。';
  const wavPath = await synthesize(text);
  const wav = fs.readFileSync(wavPath);
  check(wav.length > 5000, `SAPI 合成 WAV 大小合理（${wav.length} 字节）`);

  const t0 = Date.now();
  const tr = await call(ws, client, 'asr.transcribe', { audioBase64: wav.toString('base64') }, 180000);
  check(tr.ok, 'asr.transcribe 成功');
  check(typeof tr.data.text === 'string' && tr.data.text.length > 0, `识别出文本：${tr.data.text}`);
  check(tr.data.tookMs > 0, `识别耗时 ${tr.data.tookMs}ms（整体 ${Date.now() - t0}ms）`);
  check(tr.data.wake !== null, `唤醒词命中：${tr.data.wake}`);

  const { pcm } = wavPcm(wav);
  const started = await call(ws, client, 'asr.listen.start');
  check(started.ok, 'asr.listen.start 成功');
  check(typeof started.data.streamId === 'string', '拿到 streamId');
  const chunkBytes = Math.round(16000 * 2 * 0.3); // 300ms
  let segments = [];
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    const chunk = pcm.subarray(off, Math.min(pcm.length, off + chunkBytes));
    const fed = await call(
      ws,
      client,
      'asr.listen.feed',
      { streamId: started.data.streamId, pcmBase64: chunk.toString('base64') },
      180000
    );
    check(fed.ok, 'asr.listen.feed 成功');
    segments = segments.concat(fed.data.segments ?? []);
    if (segments.length > 0) break;
  }
  // 补 1 秒静音触发 VAD 切句
  const silence = Buffer.alloc(16000 * 2, 0);
  for (let i = 0; i < 5 && segments.length === 0; i++) {
    const fed = await call(
      ws,
      client,
      'asr.listen.feed',
      { streamId: started.data.streamId, pcmBase64: silence.toString('base64') },
      180000
    );
    segments = segments.concat(fed.data.segments ?? []);
  }
  check(segments.length >= 1, `VAD 切出 ${segments.length} 句`);
  const firstSeg = segments[0];
  check(typeof firstSeg?.text === 'string' && firstSeg.text.length > 0, `流式识别文本：${firstSeg?.text}`);
  check(firstSeg?.durationMs > 0, `句子时长 ${firstSeg?.durationMs}ms`);
  check(client.events.some((e) => e.event === 'asr.segment'), 'asr.segment 事件已广播');

  const stopped = await call(ws, client, 'asr.listen.stop', { streamId: started.data.streamId }, 180000);
  check(stopped.ok, 'asr.listen.stop 成功');

  ws.close();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.send({ type: 'shutdown' });
  });
  check(exitCode === 0, `优雅退出 exit=0（实际 ${exitCode}）`);
  check(!fs.existsSync(path.join(home, 'gateway.json')), '退出后 gateway.json 已删除');

  console.log(
    JSON.stringify(
      {
        ok: true,
        home: keep ? home : '(临时目录，已删除)',
        transcribe: {
          text: tr.data.text,
          language: tr.data.language,
          wake: tr.data.wake,
          tookMs: tr.data.tookMs,
        },
        listen: { segments: segments.length, firstText: firstSeg?.text, firstDurationMs: firstSeg?.durationMs },
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('ASR SMOKE FAILED:', err instanceof Error ? err.message : String(err));
  console.error('stderr:', stderr.slice(-3000));
  console.error('stdout tail:', stdout.slice(-2000));
  if (!childExited) child.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  if (!keep && !childExited) child.kill('SIGKILL');
  if (!keep) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}
