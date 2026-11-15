/**
 * petd 端到端冒烟：真起进程 → 读 READY/gateway.json → WS 握手 → 调方法 → SIGTERM 优雅退出。
 *
 * 跑法：node scripts/smoke.mjs
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-smoke-'));
const t0 = Date.now();

const child = spawn(process.execPath, ['dist/index.js', '--home', home, '--port', '0', '--echo'], {
  cwd: appDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});

let stdout = '';
let stderr = '';
const lines = [];
child.stdout.on('data', (d) => {
  stdout += d.toString('utf8');
  lines.push(...stdout.split('\n'));
});
child.stderr.on('data', (d) => {
  stderr += d.toString('utf8');
});

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`READY 超时；stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)), 10000);
    const check = () => {
      const m = /(^|\n)(\{[^\n]*"type":"ready"[^\n]*\})/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[2]));
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`进程提前退出 code=${child.exitCode}；stderr=${stderr}`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function rpc(ws, state, method, params) {
  const id = 'smoke-' + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc 超时：${method}`)), 5000);
    const onMessage = (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type !== 'res' || f.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(f);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-smoke', version: '0.0.1' } }));
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

try {
  const ready = await waitForReady();
  const bootMs = Date.now() - t0;
  assert(ready.pid === child.pid, 'READY pid 与子进程一致');
  assert(typeof ready.port === 'number' && ready.port > 0, 'READY 端口有效');

  const gwFile = path.join(home, 'gateway.json');
  const tokenFile = path.join(home, 'token.json');
  assert(fs.existsSync(gwFile), 'gateway.json 已写');
  assert(fs.existsSync(tokenFile), 'token.json 已写');
  const gw = JSON.parse(fs.readFileSync(gwFile, 'utf8'));
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  assert(gw.port === ready.port, 'gateway.json 端口一致');
  assert(/^[0-9a-f]{64}$/.test(token.token), 'token 为 32 字节 hex');
  assert(fs.existsSync(path.join(home, 'config.json')), 'config.json 自动创建');

  const { ws, hello } = await connect(ready.port, token.token);
  assert(hello.server.name === 'petd', 'hello.server.name=petd');
  assert(hello.server.protocol === 1, '协议版本 1');

  const ping = await rpc(ws, null, 'health.ping');
  assert(ping.ok && ping.data.pong === true, 'health.ping 正常');

  const status = await rpc(ws, null, 'health.status');
  assert(status.ok, 'health.status 正常');
  assert(status.data.server.version === '0.1.0', '版本 0.1.0');
  assert(status.data.gateway.port === ready.port, 'status 端口一致');
  assert(status.data.gateway.clients === 1, '客户端数=1');
  const names = status.data.methods.map((m) => m.name);
  for (const n of ['health.ping', 'health.status', 'config.get']) {
    assert(names.includes(n), `方法清单包含 ${n}`);
  }

  const cfg = await rpc(ws, null, 'config.get');
  assert(cfg.ok && cfg.data.version === 1, 'config.get 返回 version=1');
  assert(cfg.data.gateway.host === '127.0.0.1', 'config gateway.host 正确');

  const bad = await rpc(ws, null, 'nope.nothing');
  assert(!bad.ok && bad.error.code === 'E_UNKNOWN_METHOD', '未知方法错误码正确');

  ws.close();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    // Windows 上 SIGTERM 会被直接终结；走 ipc 请求优雅退出
    child.send({ type: 'shutdown' });
  });
  assert(exitCode === 0, `SIGTERM 后 exit=0（实际 ${exitCode}）`);
  assert(!fs.existsSync(gwFile), '退出后 gateway.json 已删除');

  console.log(JSON.stringify({
    ok: true,
    bootMs,
    port: ready.port,
    methods: names.length,
    checks: ['ready', 'gateway.json', 'token.json', 'config.json', 'handshake', 'health.ping', 'health.status', 'config.get', 'unknown-method', 'graceful-exit'],
    stdoutLines: lines.filter(Boolean).length,
  }, null, 2));
} catch (err) {
  console.error('SMOKE FAILED:', err instanceof Error ? err.message : String(err));
  console.error('stderr:', stderr.slice(-2000));
  child.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
}
