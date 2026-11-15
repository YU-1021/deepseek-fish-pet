/**
 * 附件 blob 端到端冒烟：真起 petd → 真 WS → 真 LLM（一次 chat.send，会花 token）。
 * 验证：blob.* 方法闭环、去重、Git 不跟踪 blobs/、带附件聊天能拿到句柄且会话正文不被污染。
 *
 * 跑法：
 *   node scripts/blob-smoke.mjs               # 临时 home，跑完删
 *   node scripts/blob-smoke.mjs --home D:\x  # 保留 home 便于检查 workspace/blobs/
 *
 * 前置：home 或 %APPDATA%/dayu-pet/config.json 里有可用 API Key（会迁移到 secrets.json）。
 */
import { execFileSync, spawn } from 'node:child_process';
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-blob-'));
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
  const id = 'blob-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-blob-smoke', version: '0.0.1' } }));
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

/** 一个 1×1 PNG 的最小字节（内容不重要，只验证二进制闭环） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const checks = [];
function check(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  checks.push(msg);
}

function gitNames(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'log', '--all', '--pretty=format:', '--name-only'], { encoding: 'utf8' });
  } catch {
    return '';
  }
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

  // ── blob.* 闭环 ──
  const empty = await call(ws, client, 'blob.list', {});
  check(empty.ok && Array.isArray(empty.data.blobs) && empty.data.blobs.length === 0, '初始没有附件');

  const put1 = await call(ws, client, 'blob.put', { dataBase64: PNG_1PX.toString('base64'), name: '一像素图.png' });
  check(put1.ok, 'blob.put 成功');
  const handle = put1.data.handle;
  check(/^blob:[0-9a-f]{16}-一像素图\.png$/.test(handle), `句柄格式正确（${handle}）`);
  check(put1.data.mime === 'image/png', 'mime 推断为 image/png');
  check(put1.data.size === PNG_1PX.length, `size 正确（${put1.data.size}）`);

  const put2 = await call(ws, client, 'blob.put', { dataBase64: PNG_1PX.toString('base64'), name: '一像素图.png' });
  check(put2.data.handle === handle, '同样内容去重：句柄一致');

  const listed = await call(ws, client, 'blob.list', {});
  check(listed.data.blobs.length === 1, 'blob.list 只有 1 个附件');

  const info = await call(ws, client, 'blob.info', { ref: handle });
  check(info.ok && info.data.handle === handle, 'blob.info 能按句柄解析');
  const infoByPath = await call(ws, client, 'blob.info', { ref: 'blobs/' + handle.replace(/^blob:/, '') });
  check(infoByPath.ok && infoByPath.data.handle === handle, 'blobs/<文件名> 也接受');

  const got = await call(ws, client, 'blob.get', { ref: handle });
  check(got.ok && Buffer.from(got.data.dataBase64, 'base64').equals(PNG_1PX), 'blob.get 取回原始字节');

  check(fs.existsSync(path.join(workspace, 'blobs', handle.replace(/^blob:/, ''))), '附件文件真的落在 workspace/blobs/');
  const ignore = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  check(ignore.split(/\r?\n/).some((l) => l.trim() === 'blobs/'), '.gitignore 忽略 blobs/');
  check(!gitNames(workspace).split(/\r?\n/).some((l) => l.includes('blobs/')), 'Git 历史里没有 blobs/ 路径');

  // ── 带附件聊天（真 LLM 一次） ──
  const t0 = Date.now();
  const sent = await call(
    ws,
    client,
    'chat.send',
    { text: '看看这个附件。如果它只是元数据、看不到画面，就直说看不到，别编内容。', attachments: [handle] },
    130000
  );
  const sendMs = Date.now() - t0;
  check(sent.ok, `带附件 chat.send 成功（${sendMs}ms）`);
  check(Array.isArray(sent.data.attachments) && sent.data.attachments.length === 1, 'chat.send 结果带 attachments');
  check(sent.data.attachments[0].handle === handle, '返回的附件句柄正确');
  const userStored = sent.data.userMessage;
  check(userStored.content === '看看这个附件。如果它只是元数据、看不到画面，就直说看不到，别编内容。', '会话正文只存原始文本（附件提示不落库）');
  const gotSession = await call(ws, client, 'session.get', { sessionId: sent.data.session.id });
  const storedUser = gotSession.data.session.messages.find((m) => m.role === 'user');
  check(storedUser.content === '看看这个附件。如果它只是元数据、看不到画面，就直说看不到，别编内容。', '落盘的 user 消息也不含附件提示');
  check(typeof sent.data.reply.text === 'string' && sent.data.reply.text.length > 0, `模型有回复（${sent.data.reply.text.slice(0, 40)}）`);

  // ── 删除 ──
  const del = await call(ws, client, 'blob.delete', { ref: handle });
  check(del.ok && del.data.deleted === true, 'blob.delete 删除成功');
  const afterDel = await call(ws, client, 'blob.list', {});
  check(afterDel.data.blobs.length === 0, '删除后附件列表为空');
  check(!fs.existsSync(path.join(workspace, 'blobs', handle.replace(/^blob:/, ''))), '磁盘文件已删除');

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
        handle,
        sendMs,
        answerPreview: sent.data.reply.text.slice(0, 160),
        usage: sent.data.reply.usage,
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('BLOB SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
