/**
 * hooks/审批门端到端冒烟：真起 petd → 真 WS，不调模型、不动鼠标键盘。
 *
 * 验证：
 *   1. config.get / hooks.status 返回配置与内置规则数；
 *   2. 内置 ask 规则：memory.delete 先广播 approval.requested，approval.answer 允许后执行；
 *   3. 记住本次（remember=true）后同一连接不再询问；
 *   4. 拒绝：approval.answer accepted=false → 请求回 E_FORBIDDEN「你拒绝了这次操作」；
 *   5. 超时：不回答 → 等超时后自动拒绝（E_FORBIDDEN「等待确认超时」）；
 *   6. 用户 deny 规则：hooks.create → 目标方法被拒（E_FORBIDDEN 自定义文案）并广播 hooks.blocked；
 *      toggle 关闭后放行，hooks.delete 后恢复；
 *   7. 优雅退出 exit=0、gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/hooks-smoke.mjs            # 临时 home
 *   node scripts/hooks-smoke.mjs --home D:\x
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
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-hooks-smoke-'));
fs.mkdirSync(home, { recursive: true });

const APPROVAL_TIMEOUT_MS = 5000;
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      hooks: { enabled: true, mode: 'rules', approvalEnabled: true, approvalTimeoutMs: APPROVAL_TIMEOUT_MS },
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
  const id = 'hooks-smoke-' + Math.random().toString(36).slice(2, 9);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  if (!res.ok) throw new Error(`${method} 失败：${JSON.stringify(res.error)}`);
  return res;
}

async function callExpectError(ws, client, method, params, timeoutMs = 15000) {
  const id = 'hooks-smoke-' + Math.random().toString(36).slice(2, 9);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  if (res.ok) throw new Error(`${method} 本应失败但成功了：${JSON.stringify(res.data)}`);
  return res.error;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-hooks-smoke', version: '0.0.1' } }));
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
try {
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.hooks?.enabled === true, 'config.get 返回 hooks.enabled=true');
  check(cfg.data.hooks?.mode === 'rules', "config.get 返回 hooks.mode='rules'");
  check(cfg.data.hooks?.approvalEnabled === true, 'config.get 返回 approvalEnabled=true');
  check(cfg.data.hooks?.approvalTimeoutMs === APPROVAL_TIMEOUT_MS, `approvalTimeoutMs=${APPROVAL_TIMEOUT_MS}`);

  const status = await call(ws, client, 'hooks.status');
  check(status.data.enabled === true, 'hooks.status enabled');
  check(status.data.mode === 'rules', "hooks.status mode='rules'");
  check(status.data.ruleCount >= 9, `内置规则 ${status.data.ruleCount} 条`);
  check(status.data.pendingCount === 0, '初始没有待答审批');

  const list = await call(ws, client, 'hooks.list');
  check(
    Array.isArray(list.data.rules) && list.data.rules.some((r) => r.id === 'method-memory-delete' && r.action === 'ask'),
    '内置规则 method-memory-delete 是 ask'
  );

  // 准备一个可删的文件
  await call(ws, client, 'memory.write', { path: 'hooks-smoke.md', content: '# 冒烟\n' });

  // ── 内置 ask：拒绝 ──
  const deniedId = 'delete-deny-' + Math.random().toString(36).slice(2, 8);
  const askedP = client.waitFrame((f) => f.type === 'event' && f.event === 'approval.requested', 5000, 'approval.requested');
  const deniedResP = client.waitFrame((f) => f.type === 'res' && f.id === deniedId, 10000, 'memory.delete(deny)');
  ws.send(JSON.stringify({ type: 'req', id: deniedId, method: 'memory.delete', params: { path: 'hooks-smoke.md' } }));
  const asked = await askedP;
  check(asked.data.kind === 'method' && asked.data.name === 'memory.delete', '审批请求 kind=method name=memory.delete');
  check(asked.data.ruleId === 'method-memory-delete', 'ruleId=method-memory-delete');
  check(String(asked.data.id).startsWith('ap-'), '审批 id 形如 ap-N');
  const answeredDeny = await call(ws, client, 'approval.answer', { id: asked.data.id, accepted: false });
  check(answeredDeny.data.found === true, 'approval.answer 找到待答审批');
  const deniedRes = await deniedResP;
  check(deniedRes.ok === false && deniedRes.error.code === 'E_FORBIDDEN', '拒绝 → E_FORBIDDEN');
  check(String(deniedRes.error.message).includes('你拒绝了这次操作'), '拒绝文案正确');

  // ── 内置 ask：允许并记住 ──
  const allowedId = 'delete-allow-' + Math.random().toString(36).slice(2, 8);
  const askedP2 = client.waitFrame((f) => f.type === 'event' && f.event === 'approval.requested', 5000, 'approval.requested(2)');
  const allowedResP = client.waitFrame((f) => f.type === 'res' && f.id === allowedId, 10000, 'memory.delete(allow)');
  ws.send(JSON.stringify({ type: 'req', id: allowedId, method: 'memory.delete', params: { path: 'hooks-smoke.md' } }));
  const asked2 = await askedP2;
  await call(ws, client, 'approval.answer', { id: asked2.data.id, accepted: true, remember: true });
  const allowedRes = await allowedResP;
  check(allowedRes.ok === true && allowedRes.data.path === 'hooks-smoke.md', '允许后删除成功');
  check(eventsOf(client, 'approval.resolved').length === 2, 'approval.resolved 广播 2 次（拒绝+允许）');

  // 记住后同一连接不再问
  await call(ws, client, 'memory.write', { path: 'hooks-smoke2.md', content: 'x' });
  const beforeAsked = eventsOf(client, 'approval.requested').length;
  const del2 = await call(ws, client, 'memory.delete', { path: 'hooks-smoke2.md' });
  check(del2.ok === true && del2.data.path === 'hooks-smoke2.md', '记住后第二次删除直接执行');
  check(eventsOf(client, 'approval.requested').length === beforeAsked, '没有再次弹出审批');

  // ── 超时：不回答 ──
  await call(ws, client, 'memory.write', { path: 'hooks-timeout.md', content: 'x' });
  // 先新建一条 ask 规则给 memory.move（内置没有），确保触发审批
  await call(ws, client, 'hooks.create', {
    id: 'ask-move',
    kind: 'method',
    names: ['memory.move'],
    action: 'ask',
    description: '移动文件前确认',
    priority: 1,
  });
  const timeoutErr = await callExpectError(
    ws,
    client,
    'memory.move',
    { from: 'hooks-timeout.md', to: 'hooks-timeout2.md' },
    10000
  );
  check(timeoutErr.code === 'E_FORBIDDEN' && String(timeoutErr.message).includes('等待确认超时'), '超时未答 → 自动拒绝');
  const resolved = eventsOf(client, 'approval.resolved');
  check(
    resolved.some((e) => e.data?.reason === 'timeout'),
    'approval.resolved 里有 reason=timeout'
  );

  // ── 用户 deny 规则 → toggle → delete ──
  await call(ws, client, 'hooks.create', {
    id: 'deny-session-write',
    kind: 'method',
    names: ['session.delete'],
    action: 'deny',
    message: '冒烟里不允许删会话',
    priority: 1,
  });
  const made = await call(ws, client, 'session.create', { title: 'hooks-smoke' });
  const sessionId = made.data.id ?? made.data.session?.id;
  check(typeof sessionId === 'string', '创建冒烟会话');
  const blocked = await callExpectError(ws, client, 'session.delete', { sessionId });
  check(blocked.code === 'E_FORBIDDEN' && String(blocked.message).includes('冒烟里不允许删会话'), 'deny 规则生效');
  check(eventsOf(client, 'hooks.blocked').length >= 1, 'hooks.blocked 已广播');

  const toggled = await call(ws, client, 'hooks.toggle', { id: 'deny-session-write', enabled: false });
  check(toggled.data.enabled === false, 'toggle 关闭规则');
  // 关掉自定义 deny 后，还有内置的 ask 规则：会弹审批，允许后删除
  const delId = 'session-del-' + Math.random().toString(36).slice(2, 8);
  const askP3 = client.waitFrame((f) => f.type === 'event' && f.event === 'approval.requested', 5000, 'approval.requested(3)');
  const delResP = client.waitFrame((f) => f.type === 'res' && f.id === delId, 10000, 'session.delete(ask)');
  ws.send(JSON.stringify({ type: 'req', id: delId, method: 'session.delete', params: { sessionId } }));
  const ask3 = await askP3;
  check(ask3.data.ruleId === 'method-session-delete', '关闭 deny 后落到内置 ask 规则');
  await call(ws, client, 'approval.answer', { id: ask3.data.id, accepted: true });
  const deleted = await delResP;
  check(deleted.ok === true && deleted.data.deleted === true, '关闭 deny 规则并允许后可删会话');

  const removed = await call(ws, client, 'hooks.delete', { id: 'deny-session-write' });
  check(removed.data.deleted === true, 'hooks.delete 删除规则');
  const removedAgain = await call(ws, client, 'hooks.delete', { id: 'deny-session-write' });
  check(removedAgain.data.deleted === false, '删除不存在的规则返回 deleted=false');

  const hooksChanged = eventsOf(client, 'hooks.changed');
  check(hooksChanged.length >= 3, 'hooks.changed 已广播多次（create/toggle/delete）');

  const exit = await stopPetd(first.child);
  check(exit === 0, `优雅退出 exit=${exit}`);
  first = null;
  check(!fs.existsSync(path.join(home, 'gateway.json')), 'gateway.json 已删除');

  console.log(`\n✅ hooks-smoke 通过 ${checks.length}/${checks.length} 项检查`);
  for (const c of checks) console.log('  · ' + c);
} catch (e) {
  console.error('\n❌ hooks-smoke 失败：' + (e && e.stack ? e.stack : e));
  if (first) console.error('stderr tail:\n' + first.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (first) {
    try {
      await stopPetd(first.child);
    } catch {
      /* 忽略 */
    }
    try {
      first.child.kill();
    } catch {
      /* 忽略 */
    }
  }
}
