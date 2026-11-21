/**
 * 静默活动端到端冒烟：真起 petd → 真 WS，不调模型、不动鼠标键盘。
 *
 * 验证：
 *   1. config.get 的 presence 段、presence.status 初始状态；
 *   2. presence.run_once 返回活动并在 state/presence.json 落盘；
 *   3. presence.activity 事件广播（quiet=true，只有事件、没有聊天消息）；
 *   4. presence.list 新→旧、编号递增、今日计数增加；
 *   5. 重启后记录还在、编号接着涨（p-0003）；
 *   6. 优雅退出 exit=0、gateway.json 被删除。
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
const home =
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-presence-smoke-'));
fs.mkdirSync(home, { recursive: true });

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      presence: {
        enabled: true,
        quiet: true,
        intervalMinutes: 5,
        idleMinutes: 0,
        maxPerDay: 12,
        nightQuiet: { enabled: true, start: '23:00', end: '07:00' },
      },
    },
    null,
    2
  ) + '\n',
  'utf8'
);

const checks = [];
function check(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  checks.push(msg);
}

function startPetd() {
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
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`READY 超时；stderr=${stderr.slice(-2000)}`)), 15000);
    const poll = () => {
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
      setTimeout(poll, 20);
    };
    poll();
  });
  return { child, ready, stderr: () => stderr };
}

function stopPetd(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.send({ type: 'shutdown' });
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
  const waitFrame = (match, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待帧超时：${label}`)), timeoutMs);
      waiters.push({ match, resolve, reject, timer });
    });
  return { events, waitFrame };
}

async function call(ws, client, method, params, timeoutMs = 15000) {
  const id = 'presence-smoke-' + Math.random().toString(36).slice(2, 9);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  if (!res.ok) throw new Error(`${method} 失败：${JSON.stringify(res.error)}`);
  return res;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-presence-smoke', version: '0.0.1' } }));
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

function eventsOf(client, name) {
  return client.events.filter((e) => e.event === name);
}

const KINDS = ['groom', 'stretch', 'window', 'nap', 'tidy', 'idle'];

async function session(label, expectTotalBefore) {
  const started = startPetd();
  const ready = await started.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', `${label}：握手成功`);
  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.presence?.enabled === true, `${label}：config.get presence.enabled=true`);
  check(cfg.data.presence?.quiet === true, `${label}：config.get presence.quiet=true`);
  check(cfg.data.presence?.intervalMinutes === 5, `${label}：intervalMinutes=5`);

  const status0 = await call(ws, client, 'presence.status');
  check(status0.data.enabled === true, `${label}：presence.status enabled`);
  check(status0.data.total === expectTotalBefore, `${label}：活动总数=${expectTotalBefore}`);

  return { ws, client, started, status0 };
}

let first = null;
let second = null;
try {
  first = await session('第一次启动', 0);
  const before = eventsOf(first.client, 'presence.activity').length;
  const a1 = await call(first.ws, first.client, 'presence.run_once');
  check(String(a1.data.id).startsWith('p-'), 'run_once 返回活动 id 形如 p-N');
  check(KINDS.includes(a1.data.kind), `活动类型合法（${a1.data.kind}）`);
  check(typeof a1.data.label === 'string' && a1.data.label.length > 0, '活动带中文 label');
  check(eventsOf(first.client, 'presence.activity').length === before + 1, 'presence.activity 事件已广播');
  const ev = eventsOf(first.client, 'presence.activity').slice(-1)[0];
  check(ev.data.quiet === true, '事件带 quiet=true');

  const a2 = await call(first.ws, first.client, 'presence.run_once');
  check(a2.data.id !== a1.data.id, '第二次活动 id 不同');

  const list = await call(first.ws, first.client, 'presence.list', { limit: 10 });
  check(Array.isArray(list.data.activities) && list.data.activities.length === 2, 'presence.list 返回 2 条');
  check(list.data.activities[0].id === a2.data.id, 'list 新→旧（最新在前）');
  check(list.data.activities[1].id === a1.data.id, 'list 第二条是第一次活动');

  const status1 = await call(first.ws, first.client, 'presence.status');
  check(status1.data.countToday === 2, '今日计数=2');
  check(status1.data.last.id === a2.data.id, 'status.last 是最新一条');
  check(eventsOf(first.client, 'chat.assistant_message').length === 0, '静默活动没有产生聊天消息');

  const presenceFile = path.join(home, 'state', 'presence.json');
  check(fs.existsSync(presenceFile), 'state/presence.json 落盘');
  const disk = JSON.parse(fs.readFileSync(presenceFile, 'utf8'));
  check(disk.version === 1 && Array.isArray(disk.entries) && disk.entries.length === 2, '落盘 version=1、entries=2');

  const code1 = await stopPetd(first.started.child);
  check(code1 === 0, '第一次优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), '第一次 gateway.json 已删除');
  first = null;

  second = await session('重启后', 2);
  const a3 = await call(second.ws, second.client, 'presence.run_once');
  check(a3.data.id === 'p-0003', '重启后编号接着涨（p-0003）');
  const status2 = await call(second.ws, second.client, 'presence.status');
  check(status2.data.total === 3, '重启后总数=3');

  const code2 = await stopPetd(second.started.child);
  check(code2 === 0, '第二次优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), '第二次 gateway.json 已删除');
  second = null;

  console.log(`✅ presence-smoke 通过 ${checks.length}/${checks.length} 项检查`);
  for (const c of checks) console.log('  · ' + c);
} catch (error) {
  console.error('❌ presence-smoke 失败：' + (error instanceof Error ? error.message : String(error)));
  if (first) console.error('stderr:', first.started.stderr().slice(-3000));
  if (second) console.error('stderr:', second.started.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (first) await stopPetd(first.started.child);
  if (second) await stopPetd(second.started.child);
}
