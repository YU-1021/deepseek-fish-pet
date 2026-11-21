/**
 * 学习闭环端到端冒烟：真起 petd → 真 WS → 走一遍「AI 提案 → 人批准（灰度）→ 回滚」。
 *
 * 不花 token、不碰网络：只验证 learning.* 方法与磁盘产物（proposals/、learning/、skills/）。
 *   1. config.get 的 learning 段、learning.status 初始状态；
 *   2. learning.propose 写候选（preference / skill），learning.list/get 能读回正文；
 *   3. learning.approve 灰度批准 → 写 learning/<name>.agent.json，状态 gray；
 *   4. learning.rollback 回滚 → 产物删除、状态 rolledback、审计留痕；
 *   5. 技能提案批准 → skills/<name>/SKILL.md 落盘；回滚删除；
 *   6. 事件 learning.proposed / learning.approved / learning.rolledback 都广播；
 *   7. 优雅退出 exit=0。
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
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-learning-smoke-'));
fs.mkdirSync(home, { recursive: true });

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ version: 1, learning: { enabled: true } }, null, 2) + '\n',
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
  const id = 'learning-smoke-' + Math.random().toString(36).slice(2, 9);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-learning-smoke', version: '0.0.1' } }));
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
  check(cfg.data.learning?.enabled === true, 'config.get：learning.enabled=true');
  check(cfg.data.learning?.requireApproval === true, 'config.get：learning.requireApproval=true');
  check(typeof cfg.data.learning?.grayPercent === 'number', 'config.get：learning.grayPercent 有值');

  const status0 = await call(ws, client, 'learning.status');
  check(status0.data.enabled === true, 'learning.status：enabled=true');
  check(status0.data.counts.pending === 0, 'learning.status：初始没有待审提案');
  check(typeof status0.data.dirs?.proposals === 'string', 'learning.status：返回 proposals 目录');

  // 1) AI 提案（偏好）
  const prefRes = await call(ws, client, 'learning.propose', {
    kind: 'preference',
    name: 'reply_style',
    content: '回答尽量短一点。',
    reason: '主人多次要求简短',
  });
  const pref = prefRes.data.item;
  check(pref.status === 'pending', 'learning.propose：偏好提案初始 pending');
  check(fs.existsSync(path.join(home, 'proposals', `${pref.id}.agent.md`)), '学习提案已落盘 proposals/<id>.agent.md');
  check(eventsOf(client, 'learning.proposed').length === 1, 'learning.proposed 事件已广播');

  const list1 = await call(ws, client, 'learning.list', { status: 'pending' });
  check(list1.data.items.some((it) => it.id === pref.id), 'learning.list：能列出待审提案');
  const got1 = await call(ws, client, 'learning.get', { id: pref.id });
  check(got1.data.item.body === '回答尽量短一点。', 'learning.get：读回提案正文');

  // 2) 灰度批准
  const approved = await call(ws, client, 'learning.approve', { id: pref.id, gray: true });
  check(approved.data.item.status === 'gray', 'learning.approve：灰度批准后状态 gray');
  check(fs.existsSync(path.join(home, 'learning', 'reply_style.agent.json')), '批准结果落盘 learning/<name>.agent.json');
  check(eventsOf(client, 'learning.approved').length === 1, 'learning.approved 事件已广播');
  const status1 = await call(ws, client, 'learning.status');
  check(status1.data.activeGray.length === 1, 'learning.status：activeGray 有 1 条');

  // 3) 回滚
  const rolled = await call(ws, client, 'learning.rollback', { id: pref.id });
  check(rolled.data.item.status === 'rolledback', 'learning.rollback：状态 rolledback');
  check(!fs.existsSync(path.join(home, 'learning', 'reply_style.agent.json')), '回滚后学习产物已删除');
  check(eventsOf(client, 'learning.rolledback').length === 1, 'learning.rolledback 事件已广播');
  const auditFile = path.join(home, 'state', 'agent-audit.jsonl');
  check(fs.existsSync(auditFile), '回滚进了审计流水（state/agent-audit.jsonl）');

  // 4) 技能提案 → 批准 → 回滚
  const skillRes = await call(ws, client, 'learning.propose', {
    kind: 'skill',
    name: 'daily_report',
    content: '# 日报\n\n每天 20:00 汇总今天的记忆。',
    reason: '主人每天要日报',
  });
  const skill = skillRes.data.item;
  check(fs.existsSync(path.join(home, 'skills', 'staging', `${skill.id}.agent.md`)), '技能候选落盘 skills/staging/<id>.agent.md');
  const approvedSkill = await call(ws, client, 'learning.approve', { id: skill.id });
  check(approvedSkill.data.item.status === 'approved', '技能批准后状态 approved');
  const skillFile = path.join(home, 'skills', 'daily_report', 'SKILL.md');
  check(fs.existsSync(skillFile), '技能转正为 skills/daily_report/SKILL.md');
  check(fs.readFileSync(skillFile, 'utf8').includes('每天 20:00'), 'SKILL.md 正文正确');
  await call(ws, client, 'learning.rollback', { id: skill.id });
  check(!fs.existsSync(skillFile), '技能回滚后 SKILL.md 已删除');

  const code = await stopPetd(started.child);
  check(code === 0, '优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), 'gateway.json 已删除');
  started = null;

  console.log(`✅ learning-smoke 通过 ${checks.length}/${checks.length} 项检查（未花 token）`);
  for (const c of checks) console.log('  · ' + c);
} catch (error) {
  console.error('❌ learning-smoke 失败：' + (error instanceof Error ? error.message : String(error)));
  if (started) console.error('stderr:', started.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (started) await stopPetd(started.child);
}
