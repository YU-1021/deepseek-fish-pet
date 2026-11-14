/**
 * 工作区记忆端到端冒烟：真起 petd → 真 WS → 真工作区 + 真 Git（不花 LLM token）。
 *
 * 覆盖：播种/目录、status/tree/list、write/append/read/glob/grep/history、move/delete、
 * 常驻文件保护、路径逃逸拒绝、重启后仍在、优雅退出。
 *
 * 跑法：
 *   node scripts/memory-smoke.mjs               # 临时 home，跑完删
 *   node scripts/memory-smoke.mjs --home D:\x  # 保留 home 便于检查工作区与 .git
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-memory-'));
const workspace = path.join(home, 'workspace');

function startPetd() {
  const child = spawn(process.execPath, ['dist/index.js', '--home', home, '--port', '0', '--echo'], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const state = { child, stdout: '', stderr: '', exited: false };
  child.stdout.on('data', (d) => {
    state.stdout += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    state.stderr += d.toString('utf8');
  });
  child.once('exit', () => {
    state.exited = true;
  });
  state.waitForReady = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`READY 超时；stderr=${state.stderr.slice(-2000)}`)), 15000);
      const check = () => {
        const m = /(^|\n)(\{[^\n]*"type":"ready"[^\n]*\})/.exec(state.stdout);
        if (m) {
          clearTimeout(timer);
          resolve(JSON.parse(m[2]));
          return;
        }
        if (state.exited) {
          clearTimeout(timer);
          reject(new Error(`进程提前退出 code=${child.exitCode}；stderr=${state.stderr.slice(-2000)}`));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  state.stop = () => {
    if (state.exited) return Promise.resolve(0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('timeout');
      }, 8000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.send({ type: 'shutdown' });
    });
  };
  return state;
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

async function call(ws, client, method, params, timeoutMs = 15000) {
  const id = 'mem-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name, version: '0.0.1' } }));
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

function readToken() {
  return JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8')).token;
}

const checks = [];
function check(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  checks.push(msg);
  console.log('  ✓ ' + msg);
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

let petd = startPetd();
let ws = null;

try {
  const ready = await petd.waitForReady();
  const gw = JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8'));
  check(gw.port === ready.port, 'gateway.json 端口一致');

  // 播种与 Git
  check(fs.existsSync(workspace), '工作区目录已创建');
  check(fs.existsSync(path.join(workspace, 'PARTNER.md')), 'PARTNER.md 已播种');
  check(fs.existsSync(path.join(workspace, 'MEMORY.md')), 'MEMORY.md 已播种');
  check(fs.existsSync(path.join(workspace, 'todo.md')), 'todo.md 已播种');
  for (const d of ['partner', 'notes', 'handoffs', 'archive', 'blobs']) {
    check(fs.existsSync(path.join(workspace, d)), `目录 ${d}/ 已创建`);
  }
  check(fs.existsSync(path.join(workspace, '.git')), '工作区是 Git 仓库');

  ({ ws } = await connect(ready.port, readToken(), 'petd-memory-smoke'));
  const client = makeClient(ws);
  check(Boolean(ws), 'WS 已连接');

  const status = await call(ws, client, 'memory.status');
  check(status.ok, 'memory.status 可调用');
  check(path.resolve(status.data.dir) === path.resolve(workspace), 'status.dir 指向工作区');
  check(status.data.fileCount >= 3, 'status.fileCount >= 3');
  check(status.data.git.repo === true, 'status 报告 Git 仓库');
  check(status.data.git.dirty === false, '刚启动时工作区干净');
  check(status.data.git.tags.includes('checkpoint0'), 'Git tag checkpoint0 存在');
  check(status.data.git.tags.some((t) => t.startsWith('start-')), 'Git tag start-<版本> 存在');

  const tree = await call(ws, client, 'memory.tree');
  check(tree.ok && tree.data.tree.includes('PARTNER.md'), 'memory.tree 有 PARTNER.md');

  const list = await call(ws, client, 'memory.list');
  check(list.ok && list.data.entries.some((e) => e.path === 'PARTNER.md'), 'memory.list 列出 PARTNER.md');

  // 写入 / 追加 / 读取 / 提交
  const wrote = await call(ws, client, 'memory.write', {
    path: 'partner/偏好.md',
    content: '主人喜欢安静的环境，写代码时不要一直说话。',
  });
  check(wrote.ok, 'memory.write 成功');
  check(typeof wrote.data.commit === 'string' && /^[0-9a-f]{7,40}$/.test(wrote.data.commit), 'write 返回 Git 提交');
  check(fs.readFileSync(path.join(workspace, 'partner', '偏好.md'), 'utf8').includes('安静'), '文件已真实落盘');

  const appended = await call(ws, client, 'memory.append', {
    path: 'partner/偏好.md',
    content: '深夜写代码时喜欢听雨声。',
  });
  check(appended.ok, 'memory.append 成功');

  const read = await call(ws, client, 'memory.read', { path: 'partner/偏好.md' });
  check(read.ok && read.data.content.includes('雨声') && read.data.content.includes('安静'), 'memory.read 读到全部内容');

  const glob = await call(ws, client, 'memory.glob', { pattern: 'partner/*.md' });
  check(glob.ok && glob.data.files.includes('partner/偏好.md'), 'memory.glob 命中');

  const grep = await call(ws, client, 'memory.grep', { query: '雨声' });
  check(grep.ok && grep.data.hits.length === 1, 'memory.grep 命中 1 处');
  check(grep.data.hits[0].path === 'partner/偏好.md' && grep.data.hits[0].line === 2, 'grep 路径与行号正确');

  const history = await call(ws, client, 'memory.history', { limit: 10 });
  check(history.ok && history.data.commits.some((c) => c.message === 'petd wrote partner/偏好.md'), 'history 有写入提交');
  check(history.data.commits.some((c) => c.message === 'petd appended to partner/偏好.md'), 'history 有追加提交');

  const diff = await call(ws, client, 'memory.diff', { hash: wrote.data.commit, path: 'partner/偏好.md' });
  check(diff.ok && diff.data.diff.includes('+主人喜欢安静的环境'), 'memory.diff 能看到新增内容');

  // 移动 / 删除
  const moved = await call(ws, client, 'memory.move', { from: 'partner/偏好.md', to: 'archive/偏好.md' });
  check(moved.ok && fs.existsSync(path.join(workspace, 'archive', '偏好.md')), 'memory.move 生效');
  const afterMove = await call(ws, client, 'memory.glob', { pattern: 'partner/*.md' });
  check(afterMove.ok && afterMove.data.files.length === 0, 'move 后原位置没有文件');

  const removed = await call(ws, client, 'memory.delete', { path: 'archive/偏好.md' });
  check(removed.ok && !fs.existsSync(path.join(workspace, 'archive', '偏好.md')), 'memory.delete 生效');

  // 护栏
  const denyResident = await call(ws, client, 'memory.delete', { path: 'PARTNER.md' });
  check(denyResident.ok === false && denyResident.error.code === 'E_FORBIDDEN', '常驻文件 PARTNER.md 禁删');
  const denyEscape = await call(ws, client, 'memory.read', { path: '../token.json' });
  check(denyEscape.ok === false, '路径逃逸被拒');
  const denyBad = await call(ws, client, 'memory.write', { path: 'a.md' });
  check(denyBad.ok === false && denyBad.error.code === 'E_BAD_PARAMS', '缺 content 被参数校验拒绝');

  // 重启后仍在
  ws.close();
  ws = null;
  const exitCode = await petd.stop();
  check(exitCode === 0, `优雅退出 exit=0（实际 ${exitCode}）`);
  check(!fs.existsSync(path.join(home, 'gateway.json')), '退出后 gateway.json 已删除');

  petd = startPetd();
  const ready2 = await petd.waitForReady();
  ({ ws } = await connect(ready2.port, readToken(), 'petd-memory-smoke-2'));
  const client2 = makeClient(ws);
  const status2 = await call(ws, client2, 'memory.status');
  check(status2.ok && status2.data.git.head === removed.data.commit, '重启后 Git HEAD 停在最后一次写入');
  check(status2.data.git.dirty === false, '重启后工作区干净');
  const listAfter = await call(ws, client2, 'memory.list');
  check(listAfter.ok && listAfter.data.entries.some((e) => e.path === 'MEMORY.md'), '重启后工作区仍在');

  ws.close();
  const exit2 = await petd.stop();
  check(exit2 === 0, `二次优雅退出 exit=0（实际 ${exit2}）`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        home: keep ? home : '(临时目录，已删除)',
        workspace,
        checks: checks.length,
        head: status.data.git.head,
        commitCount: history.data.commits.length,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('MEMORY SMOKE FAILED:', err instanceof Error ? err.message : String(err));
  if (ws) ws.close();
  console.error('stderr:', petd.stderr.slice(-3000));
  console.error('stdout tail:', petd.stdout.slice(-2000));
  if (!petd.exited) petd.child.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  if (petd && !petd.exited) petd.child.kill('SIGKILL');
  if (!keep) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}
