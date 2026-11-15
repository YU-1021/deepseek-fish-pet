/**
 * 聊天记忆工具端到端冒烟：真起 petd → 真 WS → 真 LLM（会花两次 token）。
 * 验证：模型在聊天里主动调记忆工具 → 工作区真的多出文件（Git 有提交）→ 第二轮先读记忆再答。
 *
 * 跑法：
 *   node scripts/chat-memory-smoke.mjs               # 临时 home，跑完删
 *   node scripts/chat-memory-smoke.mjs --home D:\x  # 保留 home 便于检查 workspace/
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-chat-mem-'));
const workspace = path.join(home, 'workspace');

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
  const id = 'chat-mem-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-chat-memory-smoke', version: '0.0.1' } }));
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

const checks = [];
function check(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  checks.push(msg);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'blobs') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function toolNames(result) {
  return (result?.tools ?? []).map((t) => t.name);
}

let childExited = false;
child.once('exit', () => {
  childExited = true;
});

try {
  const ready = await waitForReady();
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const memBefore = await call(ws, client, 'memory.list', { dir: '' });
  check(memBefore.ok, 'memory.list 可调用');
  const seeded = walk(workspace).map((p) => path.relative(workspace, p).replace(/\\/g, '/'));
  check(seeded.includes('PARTNER.md') && seeded.includes('MEMORY.md'), '工作区已播种 PARTNER.md/MEMORY.md');
  const beforeSet = new Set(seeded);

  // ── 第一轮：让它把一件事写进记忆（明确点名工具，降低模型不配合的概率） ──
  const t0 = Date.now();
  const first = await call(
    ws,
    client,
    'chat.send',
    { text: '记一下：我下周三要去医院复查眼睛。请用 write_file 或 append_file 工具，把这件事写进你的记忆文件（比如 partner/ 或 notes/ 下），不要只在聊天里说。' },
    130000
  );
  const firstMs = Date.now() - t0;
  check(first.ok, `第一轮 chat.send 成功（${firstMs}ms）`);
  const firstTools = toolNames(first.data);
  check(firstTools.length > 0, `第一轮模型调用了记忆工具（${firstTools.join(',')}）`);
  const writeTools = ['write_file', 'append_file', 'edit_file', 'move_file'];
  check(firstTools.some((n) => writeTools.includes(n)), '第一轮包含写操作');
  check(firstTools.some((n) => ['read_file', 'glob_files', 'grep_files', 'list_files'].includes(n)), '第一轮包含读操作（先找再写）');
  check((first.data.tools ?? []).every((t) => t.ok), '第一轮工具全部成功');

  const toolEv = client.events.find((e) => e.event === 'chat.tool');
  check(Boolean(toolEv), 'chat.tool 事件已广播');

  const after = walk(workspace).map((p) => path.relative(workspace, p).replace(/\\/g, '/'));
  const added = after.filter((p) => !beforeSet.has(p));
  check(added.length > 0, `工作区新增文件（${added.join(',') || '无'}）`);
  const interesting = added.filter((p) => !p.startsWith('handoffs/'));
  check(interesting.length > 0, '新增的是用户内容文件而不是交接笔记');
  const content = interesting.map((p) => fs.readFileSync(path.join(workspace, p), 'utf8')).join('\n');
  check(/医院|复查|眼睛|周三/.test(content), '写入内容包含关键信息');

  const log = (await call(ws, client, 'memory.history', { limit: 10 })).data;
  check(Array.isArray(log.commits) && log.commits.length >= 3, `Git 历史有提交（${log.commits?.length}）`);
  check(log.commits.some((c) => /petd wrote|petd appended/i.test(c.message)), 'Git 提交消息来自 petd 写入');

  const firstSession = await call(ws, client, 'session.get', { sessionId: first.data.session.id });
  check(firstSession.data.session.messages.length === 2, '工具过程不落库：会话仍只有 user+assistant');

  // ── 第二轮：先读记忆再回答 ──
  const t1 = Date.now();
  const second = await call(ws, client, 'chat.send', { sessionId: first.data.session.id, text: '我下周三要做什么？先查你的记忆文件再回答，别猜。' }, 130000);
  const secondMs = Date.now() - t1;
  check(second.ok, `第二轮 chat.send 成功（${secondMs}ms）`);
  const secondTools = toolNames(second.data);
  check(secondTools.some((n) => ['read_file', 'glob_files', 'grep_files', 'list_files'].includes(n)), `第二轮先读了记忆（${secondTools.join(',')}）`);
  const answer = second.data.reply.text;
  check(/医院|复查|眼睛/.test(answer), `回答里带出记忆要点（片段：${answer.slice(0, 60)}）`);
  const secondSession = await call(ws, client, 'session.get', { sessionId: first.data.session.id });
  check(secondSession.data.session.messages.length === 4, '两轮后会话 4 条消息');

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
        firstMs,
        secondMs,
        addedFiles: interesting,
        firstTools,
        secondTools,
        answerPreview: answer.slice(0, 160),
        prompts: [first.data.reply.usage, second.data.reply.usage],
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('CHAT MEMORY SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
