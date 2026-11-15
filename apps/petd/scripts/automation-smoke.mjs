/**
 * 自动化/自主任务端到端冒烟：真起 petd → 真 WS → 真 LLM 手动跑一次任务。
 *
 * 验证：
 *   1. 启动后 config.get 有 automation 配置，automation.status 可用；
 *   2. 创建手动任务 → list/get 正确 → automation.run 真跑一轮（真 LLM）并返回输出/usage；
 *   3. 运行记录落 automation.runs，任务上回写 sessionId/runCount/lastStatus；
 *   4. 创建 interval 任务 → pause/resume 生效、nextAt 重算；
 *   5. 事件 automation.job.*、automation.run.* 都广播；
 *   6. 状态落盘 <home>/state/automations.json，重启 petd 后任务与运行记录还在、重新布防；
 *   7. 删除任务、优雅退出 exit=0、gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/automation-smoke.mjs               # 临时 home，跑完保留便于检查
 *   node scripts/automation-smoke.mjs --home D:\x  # 指定 home
 * 注意：会真调一次模型（花少量 token）。
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
const home = argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-automation-smoke-'));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ version: 1, automation: { enabled: true, tickSeconds: 5, catchUpMinutes: 15 } }, null, 2) + '\n',
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
    const checkReady = () => {
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
      setTimeout(checkReady, 20);
    };
    checkReady();
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
  const id = 'automation-smoke-' + Math.random().toString(36).slice(2, 8);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-automation-smoke', version: '0.0.1' } }));
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

let first = null;
let second = null;
try {
  // ── 第一次启动：建任务 / 真跑一次 / 暂停恢复 ──
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.automation?.enabled === true, 'config.get 返回 automation.enabled=true');
  check(cfg.data.automation?.tickSeconds === 5, 'config.get 返回 tickSeconds=5');

  const status0 = await call(ws, client, 'automation.status');
  check(status0.data.enabled === true, 'automation.status 可用且 enabled');
  check(status0.data.jobs === 0 && status0.data.nextAt === null, '启动时没有任务');

  const manual = await call(ws, client, 'automation.create', {
    name: '冒烟手动任务',
    prompt: '用一句话说说你现在在做什么，20 字以内。',
    schedule: { kind: 'manual' },
  });
  check(manual.ok && manual.data.id === 'a1', '创建手动任务，编号 a1');
  check(manual.data.scheduleText === '手动', 'scheduleText=手动');
  check(manual.data.nextRunAt === null, '手动任务没有下次运行时间');
  check(eventsOf(client, 'automation.job.created').length === 1, 'automation.job.created 已广播');

  const got = await call(ws, client, 'automation.get', { id: 'a1' });
  check(got.data.prompt.includes('一句话'), 'automation.get 内容正确');

  const run = await call(ws, client, 'automation.run', { id: 'a1' }, 240_000);
  check(run.data.status === 'succeeded', `真 LLM 手动跑成功（${run.data.status}）`);
  check(run.data.startedBy === 'manual', '运行来源 manual');
  check(typeof run.data.output === 'string' && run.data.output.length > 0, `有输出（${String(run.data.output).slice(0, 40)}）`);
  check(eventsOf(client, 'automation.run.started').length === 1, 'automation.run.started 已广播');
  check(eventsOf(client, 'automation.run.succeeded').length === 1, 'automation.run.succeeded 已广播');

  const afterRun = await call(ws, client, 'automation.get', { id: 'a1' });
  check(afterRun.data.runCount === 1, '任务 runCount=1');
  check(afterRun.data.lastStatus === 'succeeded', '任务 lastStatus=succeeded');
  check(typeof afterRun.data.sessionId === 'string' && afterRun.data.sessionId.startsWith('s-'), '回写专用会话 sessionId');

  const runs = await call(ws, client, 'automation.runs', { id: 'a1' });
  check(runs.data.runs.length === 1, 'automation.runs 能查到运行记录');
  check(runs.data.runs[0].status === 'succeeded', '运行记录状态 succeeded');
  check(runs.data.runs[0].usage !== null, '运行记录带 usage');

  const interval = await call(ws, client, 'automation.create', {
    prompt: '每隔一小时看看主人在忙什么。',
    schedule: { kind: 'interval', everyMinutes: 60 },
  });
  check(interval.data.id === 'a2' && interval.data.nextRunAt !== null, '创建 interval 任务 a2 并有下次时间');
  check(interval.data.nextInMinutes === 60, `下次运行约 60 分钟（${interval.data.nextInMinutes}）`);

  const paused = await call(ws, client, 'automation.pause', { id: 'a2' });
  check(paused.data.enabled === false && paused.data.nextRunAt === null, 'pause 后停用且无下次');
  const resumed = await call(ws, client, 'automation.resume', { id: 'a2' });
  check(resumed.data.enabled === true && resumed.data.nextRunAt !== null, 'resume 后重新排期');
  check(eventsOf(client, 'automation.job.updated').length >= 2, 'automation.job.updated 已广播');

  const list = await call(ws, client, 'automation.list');
  check(list.data.jobs.length === 2, 'list 有 2 条任务');

  const diskPath = path.join(home, 'state', 'automations.json');
  const disk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  check(disk.version === 1, '状态文件 version=1');
  check(disk.jobs.length === 2, '磁盘上 2 条任务');
  check(disk.runs.length === 1, '磁盘上 1 条运行记录');

  ws.close();
  const exit1 = await stopPetd(first.child);
  check(exit1 === 0, `第一次退出 exit=0（实际 ${exit1}）`);
  check(!fs.existsSync(path.join(home, 'gateway.json')), '退出后 gateway.json 已删除');
  first = null;

  // ── 第二次启动：任务与运行记录保留、重新布防 ──
  second = startPetd();
  const ready2 = await second.ready;
  const token2 = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws: ws2 } = await connect(ready2.port, token2.token);
  const client2 = makeClient(ws2);
  const resumedList = await call(ws2, client2, 'automation.list');
  check(resumedList.data.jobs.length === 2, '重启后任务还在');
  const resumedRuns = await call(ws2, client2, 'automation.runs', { limit: 10 });
  check(resumedRuns.data.runs.length === 1, '重启后运行记录还在');
  const status2 = await call(ws2, client2, 'automation.status');
  check(status2.data.nextAt !== null, '重启后已重新布防（nextAt 不为空）');

  const deleted = await call(ws2, client2, 'automation.delete', { id: 'a2' });
  check(deleted.data.deleted === true, '删除任务 a2 成功');
  const list2 = await call(ws2, client2, 'automation.list');
  check(list2.data.jobs.length === 1 && list2.data.jobs[0].id === 'a1', '删除后只剩 a1');

  ws2.close();
  const exit2 = await stopPetd(second.child);
  check(exit2 === 0, `第二次退出 exit=0（实际 ${exit2}）`);
  second = null;

  console.log(JSON.stringify({ ok: true, home, checks: checks.length, list: checks }, null, 2));
  process.exitCode = 0;
} catch (e) {
  console.error('AUTOMATION SMOKE FAILED:', e instanceof Error ? e.message : String(e));
  if (first?.stderr()) console.error('petd stderr（第一次）:', first.stderr().slice(-3000));
  if (second?.stderr()) console.error('petd stderr（第二次）:', second.stderr().slice(-3000));
  for (const proc of [first, second]) {
    if (proc?.child.exitCode === null) {
      try {
        proc.child.kill();
      } catch {
        /* ignore */
      }
    }
  }
  process.exitCode = 1;
}
