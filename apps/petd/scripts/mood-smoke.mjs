/**
 * 情绪与状态端到端冒烟：真起 petd → 真 WS → 真 LLM（两次：一轮聊天 + 一次情绪评估）。
 *
 * 验证：
 *   1. 启动播种默认值（心情 70 / 好感 30 / 精力 80），config.get 能读到 mood 配置；
 *   2. mood.adjust / mood.poke / mood.history 生效并广播 mood.changed；
 *   3. chat.send 一轮成功后按 chatNudge 小步变化（记得开心一点、更亲近、稍微耗精力）；
 *   4. mood.evaluate 让模型看最近对话并应用评估结果（source=llm）；
 *   5. 状态落盘到 <home>/state/mood.json，重启 petd 后数值保留；
 *   6. 优雅退出，gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/mood-smoke.mjs               # 临时 home，跑完删
 *   node scripts/mood-smoke.mjs --home D:\x  # 保留 home 便于检查
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mood-smoke-'));
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
  const id = 'mood-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-mood-smoke', version: '0.0.1' } }));
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

function moodChangedEvents(client) {
  return client.events.filter((e) => e.event === 'mood.changed');
}

let first = null;
let second = null;
try {
  // ── 第一次启动：读写情绪 + 一轮聊天 + 模型评估 ──
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.ok, 'config.get 可调用');
  check(cfg.data.mood?.enabled === true, 'config.get 返回 mood.enabled');
  check(cfg.data.mood?.chatNudge === true, '默认开启聊天情绪微调（chatNudge）');

  const initial = await call(ws, client, 'mood.status');
  check(initial.ok && initial.data.enabled === true, 'mood.status 可用且 enabled');
  check(initial.data.state.mood === 70 && initial.data.state.affection === 30 && initial.data.state.energy === 80, '默认值 70/30/80');
  check(initial.data.state.tiers.mood === '心情不错', `心情档位正确（${initial.data.state.tiers.mood}）`);

  const adjusted = await call(ws, client, 'mood.adjust', { mood: 5, affection: 2, reason: '被夸了' });
  check(adjusted.ok, 'mood.adjust 成功');
  check(adjusted.data.state.mood === 75 && adjusted.data.state.affection === 32, 'adjust 后数值正确 75/32');
  check(adjusted.data.applied.length === 2, 'adjust 记了 2 条变化');
  check(moodChangedEvents(client).length >= 1, 'mood.changed 事件已广播');

  const hist = await call(ws, client, 'mood.history', { limit: 10 });
  check(hist.ok && hist.data.entries.some((e) => e.reason === '被夸了'), 'history 里能找到调整记录');

  const poked = await call(ws, client, 'mood.poke');
  check(poked.ok && poked.data.pokes === 1, 'poke 记了 1 次被戳');
  check(poked.data.mood === 76 && poked.data.affection === 32.5, 'poke 后心情 +1、好感 +0.5');

  const beforeChat = await call(ws, client, 'mood.status');
  const chat = await call(ws, client, 'chat.send', { text: '今天有点累，但还是想陪你一会儿' }, 130000);
  check(chat.ok, 'chat.send 一轮成功');
  const afterChat = await call(ws, client, 'mood.status');
  check(afterChat.data.state.mood > beforeChat.data.state.mood, '聊天后心情小幅上升');
  check(afterChat.data.state.affection > beforeChat.data.state.affection, '聊天后好感小幅上升');
  check(afterChat.data.state.energy < beforeChat.data.state.energy, '聊天后精力小幅下降');
  const nudgedEvent = moodChangedEvents(client).find((e) => e.data?.source === 'chat');
  check(Boolean(nudgedEvent), '聊天微调发出了 mood.changed（source=chat）');

  const evaluated = await call(ws, client, 'mood.evaluate', {}, 130000);
  check(evaluated.ok, 'mood.evaluate 调用成功');
  check(evaluated.data.applied.every((e) => e.source === 'llm'), '模型评估的变化 source=llm');
  check(moodChangedEvents(client).some((e) => e.data?.source === 'llm'), '模型评估发出了 mood.changed（source=llm）');
  const finalState = await call(ws, client, 'mood.status');
  const persisted = JSON.parse(fs.readFileSync(path.join(home, 'state', 'mood.json'), 'utf8'));
  check(fs.existsSync(path.join(home, 'state', 'mood.json')), '状态文件 mood.json 已落盘');
  check(persisted.state.mood === finalState.data.state.mood, '磁盘状态与内存一致');
  check(Array.isArray(persisted.history) && persisted.history.length > 0, '历史已落盘');

  ws.close();
  const exit1 = await stopPetd(first.child);
  check(exit1 === 0, `第一次退出 exit=0（实际 ${exit1}）`);
  check(!fs.existsSync(path.join(home, 'gateway.json')), '退出后 gateway.json 已删除');
  first = null;

  // ── 第二次启动：同一 home，数值保留 ──
  second = startPetd();
  const ready2 = await second.ready;
  const token2 = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws: ws2 } = await connect(ready2.port, token2.token);
  const client2 = makeClient(ws2);
  const resumed = await call(ws2, client2, 'mood.status');
  check(resumed.ok, '重启后 mood.status 可用');
  check(Math.abs(resumed.data.state.mood - finalState.data.state.mood) < 2, `重启后心情保留（${finalState.data.state.mood} → ${resumed.data.state.mood}）`);
  check(resumed.data.state.pokes === 1, '重启后被戳次数保留');
  ws2.close();
  const exit2 = await stopPetd(second.child);
  check(exit2 === 0, `第二次退出 exit=0（实际 ${exit2}）`);
  second = null;

  console.log(JSON.stringify({ ok: true, home, checks: checks.length, list: checks }, null, 2));
  process.exitCode = 0;
} catch (e) {
  console.error('MOOD SMOKE FAILED:', e instanceof Error ? e.message : String(e));
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
