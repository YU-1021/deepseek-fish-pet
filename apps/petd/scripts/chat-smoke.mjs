/**
 * 聊天系统端到端冒烟：真起 petd → 真 WS → 真 LLM（会花一次 token）→ 持久化/事件/优雅退出。
 *
 * 跑法：
 *   node scripts/chat-smoke.mjs               # 临时 home，跑完删
 *   node scripts/chat-smoke.mjs --home D:\x  # 保留 home 便于检查 SOUL.md / sessions/
 *
 * 前置：home 或 %APPDATA%/dayu-pet/config.json 里有可用 API Key（会迁移到 secrets.json）。
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-chat-'));

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
    const timer = setTimeout(() => reject(new Error(`READY 超时；stderr=${stderr.slice(-2000)}`)), 15000);
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

/** 同时收集 event 帧，便于断言事件确实广播 */
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

async function call(ws, client, method, params, timeoutMs = 10000) {
  const id = 'chat-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-chat-smoke', version: '0.0.1' } }));
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

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}

const checks = [];
function check(cond, msg) {
  assert(cond, msg);
  checks.push(msg);
}

let childExited = false;
child.once('exit', () => {
  childExited = true;
});

try {
  const ready = await waitForReady();
  const gw = JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8'));
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  check(gw.port === ready.port, 'gateway.json 端口一致');

  // 迁移与播种
  check(fs.existsSync(path.join(home, 'config.json')), 'config.json 已创建');
  check(fs.existsSync(path.join(home, 'secrets.json')), 'secrets.json 已创建');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check(typeof cfg.llm?.model === 'string' && cfg.llm.model.length > 0, 'config.llm.model 有效');
  check(typeof cfg.llm?.apiBase === 'string' && /^https?:\/\//.test(cfg.llm.apiBase), 'config.llm.apiBase 有效');
  check(fs.existsSync(path.join(home, 'SOUL.md')), 'SOUL.md 已播种');
  const soul = fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8');
  check(soul.includes('大肥鱼'), 'SOUL.md 含人格名');
  const secrets = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
  check(typeof secrets.llm?.apiKey === 'string' && secrets.llm.apiKey.length >= 20, 'secrets.json 已迁移 API Key');

  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const list0 = await call(ws, client, 'session.list');
  check(list0.ok && Array.isArray(list0.data.sessions), 'session.list 可调用');

  const text = '用一句话跟我打个招呼，顺便说说你现在在干什么。';
  const t0 = Date.now();
  const sent = await call(ws, client, 'chat.send', { text }, 130000);
  const llmMs = Date.now() - t0;
  check(sent.ok, `chat.send 成功（${llmMs}ms）`);
  const reply = sent.data.reply;
  check(typeof reply.text === 'string' && reply.text.length > 0, '回复非空');
  check(reply.model.length > 0, '回复带模型名');
  const sessionId = sent.data.session.id;
  check(sent.data.session.messageCount === 2, '会话消息数=2');

  const sessionFile = path.join(home, 'sessions', sessionId + '.jsonl');
  check(fs.existsSync(sessionFile), '会话 JSONL 已落盘');
  const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
  check(lines.length === 2, 'JSONL 两行（user+assistant）');
  check(JSON.parse(lines[0]).role === 'user', '第一行是 user');

  const userEv = client.events.find((e) => e.event === 'chat.user_message');
  const assistantEv = client.events.find((e) => e.event === 'chat.assistant_message');
  check(Boolean(userEv) && Boolean(assistantEv), 'chat.* 事件已广播');

  const second = await call(ws, client, 'chat.send', { sessionId, text: '再夸我一句。' }, 130000);
  check(second.ok, '第二轮 chat.send 成功');
  check(second.data.session.messageCount === 4, '二轮后消息数=4');

  const got = await call(ws, client, 'session.get', { sessionId });
  check(got.ok && got.data.session.messages.length === 4, 'session.get 读到 4 条');

  const renamed = await call(ws, client, 'session.rename', { sessionId, title: '冒烟测试会话' });
  check(renamed.ok && renamed.data.title === '冒烟测试会话', 'session.rename 生效');

  const list1 = await call(ws, client, 'session.list');
  check(list1.ok && list1.data.sessions.length === 1, 'session.list 有 1 个会话');

  const del = await call(ws, client, 'session.delete', { sessionId });
  check(del.ok && del.data.deleted === true, 'session.delete 生效');
  check(!fs.existsSync(sessionFile), '删除后 JSONL 已移除');

  ws.close();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
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
        llmMs,
        sessionId,
        replyPreview: reply.text.slice(0, 120),
        usage: reply.usage,
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('CHAT SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
