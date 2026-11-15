/**
 * 提醒/日程端到端冒烟：真起 petd → 真 WS（不调模型）。
 *
 * 验证：
 *   1. 启动后 config.get 有 reminders 配置，reminder.status 可用且没有待响；
 *   2. reminder.create（N 分钟后 / HH:MM）→ list 能看到、inMinutes 正确；
 *   3. 到点广播 reminder.due（短提醒 3 秒后触发），列表里变成已响；
 *   4. snooze / cancel 生效，reminder.created/snoozed/cancelled 事件都有；
 *   5. 状态落盘 <home>/state/reminders.json，重启 petd 后待响提醒还在；
 *   6. 优雅退出，gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/reminder-smoke.mjs               # 临时 home，跑完删
 *   node scripts/reminder-smoke.mjs --home D:\x  # 保留 home 便于检查
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-reminder-smoke-'));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1 }, null, 2) + '\n', 'utf8');

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
  const id = 'reminder-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-reminder-smoke', version: '0.0.1' } }));
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
  // ── 第一次启动：建提醒 / 到点 / 稍后 / 取消 ──
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.ok, 'config.get 可调用');
  check(cfg.data.reminders?.enabled === true, 'config.get 返回 reminders.enabled');
  check(cfg.data.reminders?.maxPending === 50, '默认 maxPending=50');

  const status0 = await call(ws, client, 'reminder.status');
  check(status0.ok && status0.data.enabled === true, 'reminder.status 可用且 enabled');
  check(status0.data.pending === 0 && status0.data.nextAt === null, '启动时没有待响提醒');

  // 3 秒后的短提醒（inMinutes 支持小数）
  const dueSoon = await call(ws, client, 'reminder.create', { text: '喝水', inMinutes: 0.05 });
  check(dueSoon.ok, 'reminder.create（N 分钟后）成功');
  check(dueSoon.data.id === 'r1', `编号从 r1 开始（${dueSoon.data.id}）`);
  check(dueSoon.data.inMinutes >= 1 && dueSoon.data.inMinutes <= 4, `inMinutes 正确（${dueSoon.data.inMinutes}）`);
  check(eventsOf(client, 'reminder.created').length === 1, 'reminder.created 事件已广播');

  // 60 分钟后的长提醒（用于稍后/重启验证）
  const later = await call(ws, client, 'reminder.create', { text: '交电费', inMinutes: 60 });
  check(later.ok && later.data.id === 'r2', '第二条提醒编号 r2');

  const list1 = await call(ws, client, 'reminder.list');
  check(list1.ok && list1.data.items.length === 2, 'list 能看到两条待响提醒');
  check(list1.data.items[0].id === 'r1', 'list 按时间排序（r1 在前）');

  // 等 reminder.due
  const due = await client.waitFrame((f) => f.type === 'event' && f.event === 'reminder.due', 15000, 'reminder.due');
  check(due.data.item.id === 'r1' && due.data.item.text === '喝水', '到点事件携带 item(id/text)');
  const list2 = await call(ws, client, 'reminder.list');
  check(list2.data.items.length === 1 && list2.data.items[0].id === 'r2', '响过的提醒不再出现在待响列表');

  const snoozed = await call(ws, client, 'reminder.snooze', { id: 'r2', minutes: 10 });
  check(snoozed.ok && snoozed.data.snoozes === 1 && snoozed.data.inMinutes === 10, 'snooze 后 10 分钟再响');
  check(eventsOf(client, 'reminder.snoozed').length === 1, 'reminder.snoozed 事件已广播');

  const third = await call(ws, client, 'reminder.create', { text: '倒垃圾', atClock: '23:59' });
  check(third.ok && third.data.id === 'r3', 'HH:MM 形式提醒创建成功');
  const cancelled = await call(ws, client, 'reminder.cancel', { id: 'r3' });
  check(cancelled.ok && cancelled.data.id === 'r3', 'cancel 成功');
  check(!(await call(ws, client, 'reminder.list')).data.items.some((i) => i.id === 'r3'), '取消后不在待响列表');
  check(eventsOf(client, 'reminder.cancelled').length === 1, 'reminder.cancelled 事件已广播');

  const status1 = await call(ws, client, 'reminder.status');
  check(status1.data.pending === 1, `待响剩 1 条（${status1.data.pending}）`);

  const disk = JSON.parse(fs.readFileSync(path.join(home, 'state', 'reminders.json'), 'utf8'));
  check(fs.existsSync(path.join(home, 'state', 'reminders.json')), '状态文件 reminders.json 已落盘');
  check(disk.items.length === 3, `磁盘保留 3 条历史（${disk.items.length}）`);
  check(disk.items.filter((i) => i.status === 'pending').length === 1, '磁盘里只有 1 条待响');
  check(disk.items.find((i) => i.id === 'r1').status === 'fired', 'r1 在磁盘上是 fired');

  ws.close();
  const exit1 = await stopPetd(first.child);
  check(exit1 === 0, `第一次退出 exit=0（实际 ${exit1}）`);
  check(!fs.existsSync(path.join(home, 'gateway.json')), '退出后 gateway.json 已删除');
  first = null;

  // ── 第二次启动：待响提醒保留 ──
  second = startPetd();
  const ready2 = await second.ready;
  const token2 = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws: ws2 } = await connect(ready2.port, token2.token);
  const client2 = makeClient(ws2);
  const resumed = await call(ws2, client2, 'reminder.list');
  check(resumed.ok && resumed.data.items.length === 1, '重启后待响提醒还在');
  check(resumed.data.items[0].id === 'r2' && resumed.data.items[0].snoozes === 1, '重启后稍后提醒的状态保留');
  const status2 = await call(ws2, client2, 'reminder.status');
  check(status2.data.pending === 1 && status2.data.nextAt !== null, '重启后 nextAt 不为空且已重新布防');
  ws2.close();
  const exit2 = await stopPetd(second.child);
  check(exit2 === 0, `第二次退出 exit=0（实际 ${exit2}）`);
  second = null;

  console.log(JSON.stringify({ ok: true, home, checks: checks.length, list: checks }, null, 2));
  process.exitCode = 0;
} catch (e) {
  console.error('REMINDER SMOKE FAILED:', e instanceof Error ? e.message : String(e));
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
