/**
 * CUA（电脑操作）端到端冒烟：真起 petd → 真 WS → 真实截图/窗口列表，不移动真实鼠标键盘。
 *
 * 验证：
 *   1. config.get / cua.status 配置与状态正确（enabled/control/permission/显示器/前台）；
 *   2. cua.screenshot 真截图（缩放后尺寸、JPEG base64）；
 *   3. cua.windows 真枚举窗口；
 *   4. 权限门：输入前广播 cua.permission，cua.answer 拒绝后不产生输入（E_FORBIDDEN）；
 *   5. 暂停门：run.pause 后 cua.screenshot / chat.send 都拒绝，run.resume 恢复；事件广播；
 *   6. 只读模式（control=false）：能看不能动；
 *   7. 优雅退出 exit=0、gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/cua-smoke.mjs            # 临时 home
 *   node scripts/cua-smoke.mjs --home D:\x
 * 注意：会真的截屏（内容不出本机）；不会点击/打字（拒绝路径在输入之前就返回）。
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
const home = argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-cua-smoke-'));
fs.mkdirSync(home, { recursive: true });

function writeConfig(overrides) {
  const config = {
    version: 1,
    cua: {
      enabled: true,
      control: true,
      permission: 'ask-once',
      grantMinutes: 30,
      skipTerminalAsk: false,
      screenshot: { maxWidth: 800, maxHeight: 600, quality: 60, afterAction: false, settleMs: 100 },
      userIdleMs: 0,
      maxYieldWaitMs: 2000,
      typeChunkDelayMs: 10,
      includeImages: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

writeConfig({});

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
  const id = 'cua-smoke-' + Math.random().toString(36).slice(2, 9);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  if (!res.ok) throw new Error(`${method} 失败：${JSON.stringify(res.error)}`);
  return res;
}

async function callExpectError(ws, client, method, params, timeoutMs = 15000) {
  const id = 'cua-smoke-' + Math.random().toString(36).slice(2, 9);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-cua-smoke', version: '0.0.1' } }));
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
  // ── 第一次启动：状态/截图/窗口/权限门/暂停门 ──
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.cua?.enabled === true, 'config.get 返回 cua.enabled=true');
  check(cfg.data.cua?.control === true, 'config.get 返回 cua.control=true');
  check(cfg.data.cua?.permission === 'ask-once', 'config.get 返回 permission=ask-once');

  const status = await call(ws, client, 'cua.status');
  check(status.data.enabled === true, 'cua.status enabled');
  check(status.data.engine === 'win32', 'cua.status engine=win32');
  check(Array.isArray(status.data.displays) && status.data.displays.length >= 1, `检测到 ${status.data.displays.length} 个显示器`);
  check(status.data.foreground !== null, `前台窗口「${status.data.foreground?.title}」`);

  const shot = await call(ws, client, 'cua.screenshot', { includeImage: true });
  check(shot.data.width > 0 && shot.data.height > 0, `截图 ${shot.data.width}×${shot.data.height}（scale ${shot.data.scale.toFixed(2)}）`);
  check(typeof shot.data.text === 'string' && shot.data.text.includes('屏幕截图'), '截图说明里有尺寸/坐标约定');
  check(typeof shot.data.imageBase64 === 'string' && shot.data.imageBase64.startsWith('/9j/'), '截图返回 JPEG base64（SOI 头）');
  check(shot.data.imageBase64.length > 1000, `JPEG ${Math.round(shot.data.imageBase64.length / 1024)}KB`);

  const windows = await call(ws, client, 'cua.windows');
  check(Array.isArray(windows.data.windows), `窗口列表 ${windows.data.windows.length} 个`);
  check(typeof windows.data.text === 'string' && windows.data.text.includes('窗口'), '窗口说明文本');

  // 权限门：点一下会先广播 cua.permission；拒绝后不应产生任何输入
  const clickId = 'cua-deny-' + Math.random().toString(36).slice(2, 8);
  const permP = client.waitFrame((f) => f.type === 'event' && f.event === 'cua.permission', 5000, 'cua.permission');
  const clickResP = client.waitFrame((f) => f.type === 'res' && f.id === clickId, 10000, 'cua.click(deny)');
  ws.send(JSON.stringify({ type: 'req', id: clickId, method: 'cua.click', params: { x: 10, y: 10 } }));
  const perm = await permP;
  check(perm.data.kind === 'act', '权限询问 kind=act');
  check(typeof perm.data.id === 'string' && perm.data.id.startsWith('perm-'), '权限询问带 id');
  const answered = await call(ws, client, 'cua.answer', { id: perm.data.id, accepted: false });
  check(answered.data.found === true, 'cua.answer 找到并回答了权限请求');
  const denied = await clickResP;
  check(denied.ok === false && denied.error.code === 'E_FORBIDDEN', '拒绝授权 → E_FORBIDDEN：' + JSON.stringify(denied));
  check(String(denied.error.message).includes('用户拒绝了这次操作'), '拒绝文案正确');

  const missing = await call(ws, client, 'cua.answer', { id: 'perm-404', accepted: true });
  check(missing.data.found === false, 'cua.answer 未知 id 返回 found=false');

  // 暂停门：暂停后看/聊/动都停，恢复后继续
  const run0 = await call(ws, client, 'run.status');
  check(run0.data.paused === false, '初始未暂停');
  const paused = await call(ws, client, 'run.pause', { reason: '冒烟测试暂停' });
  check(paused.data.paused === true && paused.data.reason === '冒烟测试暂停', 'run.pause 生效');
  check(eventsOf(client, 'run.paused').length === 1, 'run.paused 已广播');

  const shotPaused = await callExpectError(ws, client, 'cua.screenshot', {});
  check(shotPaused.code === 'E_UNAVAILABLE' && String(shotPaused.message).includes('已暂停运行'), '暂停后不能截图');
  const chatPaused = await callExpectError(ws, client, 'chat.send', { text: '在吗' }, 30000);
  check(chatPaused.code === 'E_UNAVAILABLE' && String(chatPaused.message).includes('运行已暂停'), '暂停后聊天被拒（不调用模型）');

  const resumed = await call(ws, client, 'run.resume');
  check(resumed.data.paused === false, 'run.resume 生效');
  check(eventsOf(client, 'run.resumed').length === 1, 'run.resumed 已广播');
  const shotAgain = await call(ws, client, 'cua.screenshot', {});
  check(shotAgain.data.width > 0, '恢复后可以继续截图');

  const exit1 = await stopPetd(first.child);
  check(exit1 === 0, `第一次优雅退出 exit=${exit1}`);
  first = null;
  check(!fs.existsSync(path.join(home, 'gateway.json')), 'gateway.json 已删除');

  // ── 第二次启动：只读模式 ──
  writeConfig({ control: false, permission: 'never-ask' });
  second = startPetd();
  const ready2 = await second.ready;
  const token2 = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const conn2 = await connect(ready2.port, token2.token);
  const client2 = makeClient(conn2.ws);

  const status2 = await call(conn2.ws, client2, 'cua.status');
  check(status2.data.control === false, '只读模式 control=false');
  const shot2 = await call(conn2.ws, client2, 'cua.screenshot', {});
  check(shot2.data.width > 0, '只读模式仍能看屏幕');
  const roError = await callExpectError(conn2.ws, client2, 'cua.click', { x: 10, y: 10 });
  check(roError.code === 'E_FORBIDDEN' && String(roError.message).includes('只读模式'), '只读模式不能操作');

  const exit2 = await stopPetd(second.child);
  check(exit2 === 0, `第二次优雅退出 exit=${exit2}`);
  second = null;

  console.log(`\n✅ cua-smoke 通过 ${checks.length}/${checks.length} 项检查`);
  for (const c of checks) console.log('  · ' + c);
} catch (e) {
  console.error('\n❌ cua-smoke 失败：' + (e && e.stack ? e.stack : e));
  if (first) console.error('first stderr tail:\n' + first.stderr().slice(-3000));
  if (second) console.error('second stderr tail:\n' + second.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  for (const inst of [first, second]) {
    if (!inst) continue;
    try {
      await stopPetd(inst.child);
    } catch {
      /* 忽略 */
    }
    try {
      inst.child.kill();
    } catch {
      /* 忽略 */
    }
  }
}
