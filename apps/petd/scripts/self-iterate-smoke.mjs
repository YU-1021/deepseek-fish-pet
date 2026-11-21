/**
 * 自我迭代（审计 + 回滚）端到端冒烟：真起 petd → 真 WS，不调模型、不改文件以外的东西。
 *
 * 验证：
 *   1. agent.scope 返回后缀约定、可写目录与审计文件路径；
 *   2. 外部写入 SOUL.agent.md（模拟 AI 外圈）后 persona.get 能合并、标 source=agent；
 *   3. 用户改同名小节时外圈被清空，并自动记一条 action=delete、actor=user 的审计；
 *   4. agent.audit.list / agent.audit.get 能读到这条记录（带前后正文与 diff）；
 *   5. agent.rollback 把外圈恢复回滚前内容，广播 agent.rollback，并再追加一条回滚记录；
 *   6. 审计落盘 state/agent-audit.jsonl，重启后记录还在；
 *   7. 优雅退出 exit=0、gateway.json 被删除。
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
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-self-iterate-smoke-'));
fs.mkdirSync(home, { recursive: true });

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
  const id = 'self-iterate-smoke-' + Math.random().toString(36).slice(2, 9);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-self-iterate-smoke', version: '0.0.1' } }));
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

async function session(label) {
  const started = startPetd();
  const ready = await started.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', `${label}：握手成功`);
  return { ws, client, started };
}

const EXTERNAL_AGENT_SOUL = '## 说话方式\n\n更短、更随意。\n';

let first = null;
let second = null;
try {
  first = await session('第一次启动');

  const scope = await call(first.ws, first.client, 'agent.scope');
  check(scope.data.memoryZone === 'workspace', 'agent.scope：记忆区=workspace');
  check(Array.isArray(scope.data.zones) && scope.data.zones.length === 4, 'agent.scope：4 个可写目录');
  check(String(scope.data.scope).includes('.agent'), 'agent.scope：说明里带 .agent 后缀约定');
  check(
    String(scope.data.auditFile) === path.join(home, 'state', 'agent-audit.jsonl'),
    'agent.scope：审计文件路径正确'
  );

  const p0 = await call(first.ws, first.client, 'persona.get');
  check(path.basename(String(p0.data.agentFile)) === 'SOUL.agent.md', 'persona.get：agentFile=SOUL.agent.md');
  check(String(p0.data.agentFile).startsWith(home), 'persona.get：agentFile 在 home 下');
  check(p0.data.hasAgentOverrides === false, 'persona.get：初始没有外圈覆盖');

  fs.writeFileSync(path.join(home, 'SOUL.agent.md'), EXTERNAL_AGENT_SOUL, 'utf8');
  const p1 = await call(first.ws, first.client, 'persona.get');
  check(p1.data.hasAgentOverrides === true, '外部写外圈后 persona.get 显示 hasAgentOverrides=true');
  const speaking1 = (p1.data.sections ?? []).find((s) => s.key === 'speaking');
  check(speaking1?.source === 'agent', 'persona.get：说话方式来源=agent');
  check(String(speaking1?.content ?? '').includes('更短、更随意'), 'persona.get：读到外圈内容');

  await call(first.ws, first.client, 'persona.patch', {
    sections: { speaking: '用户最终说法。' },
    expectedVersion: p1.data.version,
  });
  check(fs.readFileSync(path.join(home, 'SOUL.agent.md'), 'utf8').trim() === '', '用户改同名小节后外圈被清空');
  const p2 = await call(first.ws, first.client, 'persona.get');
  const speaking2 = (p2.data.sections ?? []).find((s) => s.key === 'speaking');
  check(speaking2?.source === 'core', 'persona.get：说话方式回到内核');

  const list1 = await call(first.ws, first.client, 'agent.audit.list', { limit: 10 });
  check(list1.data.total === 1, 'agent.audit.list：用户清外圈记了 1 条');
  const auditId = list1.data.entries[0].id;
  check(list1.data.entries[0].path === 'SOUL.agent.md', '审计记录路径=SOUL.agent.md');
  check(list1.data.entries[0].actor === 'user', '审计记录 actor=user');
  check(list1.data.entries[0].action === 'delete', '审计记录 action=delete');
  check(list1.data.entries[0].before?.text === undefined, '列表记录不含正文');

  const got = await call(first.ws, first.client, 'agent.audit.get', { id: auditId });
  check(String(got.data.entry.before?.text ?? '').includes('更短、更随意'), '详情：before 是外圈原文');
  check(String(got.data.entry.diff ?? '').includes('-'), '详情：带逐行 diff');

  const eventsBefore = eventsOf(first.client, 'agent.rollback').length;
  const rb = await call(first.ws, first.client, 'agent.rollback', { id: auditId });
  check(rb.data.restored === 'content', 'agent.rollback：恢复为内容恢复');
  check(rb.data.path === 'SOUL.agent.md', 'agent.rollback：路径正确');
  check(
    fs.readFileSync(path.join(home, 'SOUL.agent.md'), 'utf8').includes('更短、更随意'),
    'agent.rollback：外圈文件已恢复'
  );
  check(eventsOf(first.client, 'agent.rollback').length === eventsBefore + 1, 'agent.rollback 事件已广播');
  const ev = eventsOf(first.client, 'agent.rollback').slice(-1)[0];
  check(ev.data.targetId === auditId, 'agent.rollback 事件带 targetId');

  const p3 = await call(first.ws, first.client, 'persona.get');
  const speaking3 = (p3.data.sections ?? []).find((s) => s.key === 'speaking');
  check(p3.data.hasAgentOverrides === true && speaking3?.source === 'agent', '回滚后外圈覆盖重新生效');

  const list2 = await call(first.ws, first.client, 'agent.audit.list', { limit: 10 });
  check(list2.data.total === 2, '回滚本身也追加一条审计（共 2 条）');
  const auditFile = path.join(home, 'state', 'agent-audit.jsonl');
  check(fs.existsSync(auditFile), 'state/agent-audit.jsonl 落盘');

  const code1 = await stopPetd(first.started.child);
  check(code1 === 0, '第一次优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), '第一次 gateway.json 已删除');
  first = null;

  second = await session('重启后');
  const list3 = await call(second.ws, second.client, 'agent.audit.list', { limit: 10 });
  check(list3.data.total === 2, '重启后审计记录还在（2 条）');
  const code2 = await stopPetd(second.started.child);
  check(code2 === 0, '第二次优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), '第二次 gateway.json 已删除');
  second = null;

  console.log(`✅ self-iterate-smoke 通过 ${checks.length}/${checks.length} 项检查`);
  for (const c of checks) console.log('  · ' + c);
} catch (error) {
  console.error('❌ self-iterate-smoke 失败：' + (error instanceof Error ? error.message : String(error)));
  if (first) console.error('stderr:', first.started.stderr().slice(-3000));
  if (second) console.error('stderr:', second.started.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (first) await stopPetd(first.started.child);
  if (second) await stopPetd(second.started.child);
}
