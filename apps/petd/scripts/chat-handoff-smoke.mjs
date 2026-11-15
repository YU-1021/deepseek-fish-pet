/**
 * 上下文交接笔记端到端冒烟：真起 petd → 真 WS → 真 LLM（会花几次 token）。
 *
 * 验证：
 *   1. 会话变长后自动触发交接（chat.handoff 事件）→ 工作区 handoffs/ 出现笔记 + Git 提交；
 *   2. 交接只是「之后带笔记 + 最近的消息」，会话 JSONL 里的历史一条不少；
 *   3. 手动 chat.handoff 方法可用；
 *   4. 交接状态写进会话元数据（contextStart / handoffFiles / lastPromptTokens）。
 *
 * 跑法：
 *   node scripts/chat-handoff-smoke.mjs               # 临时 home，跑完删
 *   node scripts/chat-handoff-smoke.mjs --home D:\x  # 保留 home 便于检查
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-handoff-'));
const workspace = path.join(home, 'workspace');

// 先把阈值调小，几轮就能触发交接（正常配置是 64000）
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ version: 1, chat: { contextMaxTokens: 600, softRatio: 0.5, keepRatio: 0.12, handoffNoteMaxChars: 1000 } }, null, 2) + '\n',
  'utf8'
);

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
  const id = 'handoff-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-handoff-smoke', version: '0.0.1' } }));
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

function handoffFiles() {
  const dir = path.join(workspace, 'handoffs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
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

  const cfg = await call(ws, client, 'config.get');
  check(cfg.ok, 'config.get 可调用');
  check(cfg.data.chat.contextMaxTokens === 600, '启动时读到的交接阈值生效');

  // ── 会话 A：四轮对话（第三轮后历史 6 条），下一轮因超过软阈值而自动交接 ──
  let sessionId = '';
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    last = await call(ws, client, 'chat.send', { sessionId: sessionId || undefined, text: '第' + i + '轮：' + '我们在聊桌宠的架构。'.repeat(60) }, 130000);
    check(last.ok, `第 ${i + 1} 轮 chat.send 成功`);
    sessionId = last.data.session.id;
  }
  const handoffEv = client.events.find((e) => e.event === 'chat.handoff');
  check(Boolean(handoffEv), 'chat.handoff 事件已广播');
  check(handoffEv.data.compressed > 0 && handoffEv.data.kept >= 2, '事件里有 compressed/kept');
  check(typeof handoffEv.data.tokensAfter === 'number' && handoffEv.data.tokensAfter < handoffEv.data.tokensBefore, '交接后 token 估算变小');

  const files = handoffFiles();
  check(files.length === 1, `工作区 handoffs/ 里有 1 篇笔记（实际 ${files.length}）`);
  const note = fs.readFileSync(path.join(workspace, 'handoffs', files[0]), 'utf8');
  check(note.startsWith('# 交接笔记'), '笔记以 # 交接笔记 开头');
  check(note.length > 100, '笔记有内容');

  const got = await call(ws, client, 'session.get', { sessionId });
  check(got.ok, 'session.get 可调用');
  check(got.data.session.messages.length === 8, `会话 JSONL 历史一条不少（8 条，实际 ${got.data.session.messages.length}）`);
  check(got.data.session.contextStart > 0, `contextStart 已前移（${got.data.session.contextStart}）`);
  check((got.data.session.handoffFiles ?? []).length === 1, '会话元数据记下 handoffFiles');
  check(typeof got.data.session.lastPromptTokens === 'number', '会话元数据记下 lastPromptTokens');

  const log = await call(ws, client, 'memory.history', { limit: 20 });
  check(log.data.commits.some((c) => /petd wrote handoffs\//.test(c.message)), 'Git 历史里有交接笔记的提交');

  // ── 会话 B：两轮对话后手动 chat.handoff ──
  const b1 = await call(ws, client, 'chat.send', { text: '手动交接测试：第一句' }, 130000);
  check(b1.ok, '手动交接会话第一轮成功');
  const b2 = await call(ws, client, 'chat.send', { sessionId: b1.data.session.id, text: '手动交接测试：第二句' }, 130000);
  check(b2.ok, '手动交接会话第二轮成功');
  const manual = await call(ws, client, 'chat.handoff', { sessionId: b1.data.session.id }, 30000);
  check(manual.ok, 'chat.handoff 手动调用成功');
  check(manual.data.compressed === 2 && manual.data.kept === 2, `手动交接压缩 2 条保留 2 条（实际 ${manual.data.compressed}/${manual.data.kept}）`);
  check(handoffFiles().length === 2, '手动交接又写了一篇笔记（共 2 篇）');

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
        autoHandoff: handoffEv.data,
        manualHandoff: manual.data,
        notes: handoffFiles(),
        usage: last?.data?.reply?.usage,
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('CHAT HANDOFF SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
