/**
 * DSH 桥端到端冒烟：真起 petd → 真 WS → 真起 DSH SDK runtime（不点鼠标键盘）。
 *
 * 默认只验证「读方向 + 运行时生命周期」（不花 token）：
 *   1. config.get 的 dsh 段、dsh.status 初始状态与路径解析；
 *   2. dsh.observe 能读到桌面 GUI 最近会话（有则状态合法，没有也不报错）；
 *   3. dsh.start 真拉起私有 SDK runtime（handshake 成功）；
 *   4. dsh.stop 收起 runtime；
 *   5. 优雅退出 exit=0。
 *
 * 加 --live 才跑「写方向」：dsh.ask 一句极小 prompt（会花一点点 token）。
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
const live = process.argv.includes('--live');
const argHomeIdx = process.argv.indexOf('--home');
const home =
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-dsh-smoke-'));
fs.mkdirSync(home, { recursive: true });

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ version: 1, dsh: { enabled: true, observe: true, approvalPolicy: 'reject' } }, null, 2) + '\n',
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
    const timer = setTimeout(() => resolve('timeout'), 10000);
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

async function call(ws, client, method, params, timeoutMs = 30000) {
  const id = 'dsh-smoke-' + Math.random().toString(36).slice(2, 9);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-dsh-smoke', version: '0.0.1' } }));
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

let started = null;
try {
  started = startPetd();
  const ready = await started.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws } = await connect(ready.port, token.token);
  const client = makeClient(ws);

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.dsh?.enabled === true, 'config.get：dsh.enabled=true');
  check(cfg.data.dsh?.observe === true, 'config.get：dsh.observe=true');
  check(cfg.data.dsh?.approvalPolicy === 'reject', 'config.get：approvalPolicy=reject');

  const status0 = await call(ws, client, 'dsh.status');
  check(status0.data.enabled === true, 'dsh.status：bridge enabled');
  check(status0.data.started === true, 'dsh.status：启动时已开观察（observe=true）');
  check(typeof status0.data.paths?.exePath === 'string' && fs.existsSync(status0.data.paths.exePath), '自动找到 DeepSeek Harness.exe');
  check(
    typeof status0.data.paths?.cliPath === 'string' && status0.data.paths.cliPath.endsWith('cli.js'),
    '自动推导出 dsh cli.js（app.asar 内，普通 fs 看不见、Electron 能读）'
  );
  check(status0.data.runtime === null, '未预热时 runtime 为 null（懒启动）');

  const observed = await call(ws, client, 'dsh.observe');
  check(typeof observed.data.sessionsDir === 'string', 'dsh.observe：返回 sessionsDir');
  if (observed.data.session !== null) {
    const s = observed.data.session;
    check(['idle', 'thinking', 'working'].includes(s.state), `观察到的会话状态合法（${s.state}）`);
    check(typeof s.active === 'boolean', '观察到的会话带 active 标记');
    check(typeof s.workspace === 'string' && s.workspace.length > 0, '观察到的会话带 workspace 路径');
  } else {
    check(true, '当前没有可观察的会话（不影响桥本身）');
  }

  const startedRes = await call(ws, client, 'dsh.start', undefined, 60000);
  check(startedRes.data.started === true, 'dsh.start：返回 started=true');
  check(startedRes.data.runtime?.running === true, 'dsh.start：SDK runtime 已运行');
  check(startedRes.data.runtime?.provider === 'deepseek-official', 'runtime provider=deepseek-official');
  check(typeof startedRes.data.runtime?.serverInfo?.name === 'string', 'runtime 握手成功（有 serverInfo）');
  check(eventsOf(client, 'dsh.status').length > 0, 'dsh.status 事件已广播');

  if (live) {
    const asked = await call(ws, client, 'dsh.ask', { text: '只回复两个字：收到', timeoutMs: 120000 }, 180000);
    check(typeof asked.data.text === 'string' && asked.data.text.includes('收到'), `dsh.ask：模型回答包含“收到”（实际：${asked.data.text}）`);
    check(typeof asked.data.turn === 'number' && asked.data.turn >= 1, `dsh.ask：turn>=1（实际：${asked.data.turn}；会话持久化，turn 会累加）`);
    check(eventsOf(client, 'dsh.event').length > 0, 'dsh.event 事件已广播');
  } else {
    check(true, '未加 --live：跳过会花 token 的 dsh.ask');
  }

  const stoppedRes = await call(ws, client, 'dsh.stop', undefined, 30000);
  check(stoppedRes.data.stopped === true, 'dsh.stop：返回 stopped=true');
  const status1 = await call(ws, client, 'dsh.status');
  check(status1.data.runtime === null, 'dsh.stop 后 runtime 为 null');

  const code = await stopPetd(started.child);
  check(code === 0, '优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), 'gateway.json 已删除');
  started = null;

  console.log(`✅ dsh-smoke 通过 ${checks.length}/${checks.length} 项检查${live ? '（含 --live 真模型）' : '（未花 token）'}`);
  for (const c of checks) console.log('  · ' + c);
} catch (error) {
  console.error('❌ dsh-smoke 失败：' + (error instanceof Error ? error.message : String(error)));
  if (started) console.error('stderr:', started.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (started) await stopPetd(started.child);
}
