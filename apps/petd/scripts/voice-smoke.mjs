/**
 * 语音端到端冒烟：真起 petd → 真 WS → 本机 SAPI 合成（离线，不依赖 Edge）+ 一次真 LLM 聊天朗读。
 *
 * 验证：
 *   1. voice.status / voice.voices 可用（至少本机 SAPI 音色）；
 *   2. voice.speak 返回 wav base64、时长 > 0，第二次命中缓存；
 *   3. voice.speech 事件已广播；
 *   4. chat.send 带 speak:true 时结果里有 speech，会话里只存文字不存音频；
 *   5. 优雅退出。
 *
 * 跑法：
 *   node scripts/voice-smoke.mjs               # 临时 home，跑完删
 *   node scripts/voice-smoke.mjs --home D:\x  # 保留 home 便于检查
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-voice-smoke-'));

// 用离线 SAPI，避免冒烟依赖 Edge 网络；maxToolRounds=0 让聊天只走一轮
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      voice: { enabled: true, engine: 'sapi', voice: 'Microsoft Huihui Desktop', rate: 1, pitch: 1, maxChars: 400, autoSpeak: false, fallbackToSapi: true },
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
    const timer = setTimeout(() => reject(new Error(`READY 超时；stderr=${stderr.slice(-2000)}`)), 20000);
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

async function call(ws, client, method, params, timeoutMs = 15000) {
  const id = 'voice-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 6000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-voice-smoke', version: '0.0.1' } }));
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

  const status = await call(ws, client, 'voice.status');
  check(status.ok, 'voice.status 可调用');
  check(status.data.enabled === true, '语音已启用');
  check(status.data.engine === 'sapi', `强制的离线引擎生效（${status.data.engine}）`);

  const voices = await call(ws, client, 'voice.voices');
  check(voices.ok, 'voice.voices 可调用');
  check(voices.data.voices.some((v) => v.engine === 'sapi'), '至少有一个本机 SAPI 音色');

  const text = '你好，我是大肥鱼，这是一次语音冒烟测试。';
  const first = await call(ws, client, 'voice.speak', { text }, 60000);
  check(first.ok, 'voice.speak 成功');
  check(first.data.engine === 'sapi', '合成走的是 SAPI');
  check(first.data.mime === 'audio/wav', '返回 wav');
  check(first.data.bytes > 1000, `音频大小合理（${first.data.bytes} 字节）`);
  check(first.data.durationMs > 0, `时长大于 0（${first.data.durationMs}ms）`);
  const audio = Buffer.from(first.data.audioBase64, 'base64');
  check(audio.subarray(0, 4).toString() === 'RIFF', 'base64 解出来是 WAV（RIFF 头）');
  check(fs.existsSync(first.data.file), '音频文件已落盘到缓存');

  const second = await call(ws, client, 'voice.speak', { text }, 60000);
  check(second.ok, '第二次 voice.speak 成功');
  check(second.data.cached === true, '第二次命中缓存');
  check(second.data.id === first.data.id, '同一段文本 id 一致');

  check(client.events.some((e) => e.event === 'voice.speech'), 'voice.speech 事件已广播');

  const sent = await call(ws, client, 'chat.send', { text: '用一句话向我打个招呼', speak: true }, 130000);
  check(sent.ok, 'chat.send 成功');
  check(sent.data.speech !== null && sent.data.speech !== undefined, '结果里带 speech');
  check(sent.data.speech.engine === 'sapi', '聊天朗读也走 SAPI');
  check(typeof sent.data.reply.text === 'string' && sent.data.reply.text.length > 0, '模型有文字回复');

  const got = await call(ws, client, 'session.get', { sessionId: sent.data.session.id });
  check(got.ok, 'session.get 可调用');
  check(got.data.session.messages.length === 2, `会话里只有 2 条消息（实际 ${got.data.session.messages.length}）`);
  const raw = fs.readFileSync(path.join(home, 'sessions', sent.data.session.id + '.jsonl'), 'utf8');
  check(!raw.includes('audioBase64') && !raw.includes('RIFF'), '会话 JSONL 不存音频');

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
        engine: first.data.engine,
        voice: first.data.voice,
        bytes: first.data.bytes,
        durationMs: first.data.durationMs,
        cached: second.data.cached,
        chatSpeech: {
          engine: sent.data.speech.engine,
          bytes: sent.data.speech.bytes,
          durationMs: sent.data.speech.durationMs,
          elapsedMs: sent.data.speech.elapsedMs,
        },
        reply: sent.data.reply.text,
        usage: sent.data.reply.usage,
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('VOICE SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
