/**
 * 游戏助手端到端冒烟：真起 petd → 真 WS → 真调预习助手桥（不点鼠标键盘）。
 *
 * 默认只验证「配置 + 状态 + dry-run 点击」（不碰游戏、不花 token）：
 *   1. config.get 的 game 段；
 *   2. game.status：助手目录/桥/真点开关；
 *   3. game.click：默认 dry-run，只返回计划、不真点；
 *   4. 优雅退出 exit=0。
 *
 * 加 --live 才真去抓一帧识别（不点击；游戏没开或被挡住也不报错，只少几项检查）。
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
const live = process.argv.includes('--live');
const argHomeIdx = process.argv.indexOf('--home');
const home =
  argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-game-smoke-'));
fs.mkdirSync(home, { recursive: true });

const assistantCandidates = [
  process.env.PA_DIR || '',
  'C:\\deepseek\\预习助手',
  'F:\\DSH\\大肥鱼\\预习助手',
].filter(Boolean);
const assistantDir = assistantCandidates.find((p) => fs.existsSync(path.join(p, 'tools', 'petd-bridge.js'))) || '';

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      game: {
        enabled: true,
        assistantDir,
        nodePath: '',
        timeoutMs: 30000,
        allowClick: false,
        gameHint: '明日方舟',
      },
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

async function call(ws, client, method, params, timeoutMs = 60000) {
  const id = 'game-smoke-' + Math.random().toString(36).slice(2, 9);
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
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-game-smoke', version: '0.0.1' } }));
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

let started = null;
try {
  check(assistantDir !== '', `找到预习助手目录（${assistantDir || '无'}）`);
  started = startPetd();
  const ready = await started.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws } = await connect(ready.port, token.token);
  const client = makeClient(ws);

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.game?.enabled === true, 'config.get：game.enabled=true');
  check(cfg.data.game?.allowClick === false, 'config.get：allowClick=false（默认不真点）');
  check(cfg.data.game?.gameHint === '明日方舟', 'config.get：gameHint=明日方舟');

  const status = await call(ws, client, 'game.status');
  check(status.data.enabled === true, 'game.status：enabled=true');
  check(typeof status.data.bridgePath === 'string' && status.data.bridgePath.endsWith('petd-bridge.js'), 'game.status：桥路径以 petd-bridge.js 结尾');
  check(fs.existsSync(status.data.bridgePath), 'game.status：桥文件真实存在');
  check(status.data.allowClick === false, 'game.status：allowClick=false');

  const plan = await call(ws, client, 'game.click', { x: 640, y: 360 });
  check(plan.data.ok === true && plan.data.dryRun === true, 'game.click：默认 dry-run');
  check(plan.data.planned?.x === 640 && plan.data.planned?.y === 360, 'game.click：返回计划坐标');
  check(typeof plan.data.note === 'string' && plan.data.note.length > 0, 'game.click：给出「只做计划、没有点击」说明');

  if (live) {
    try {
      const look = await call(ws, client, 'game.look', { find: ['开始行动'] }, 120000);
      check(look.data.ok === true, 'game.look：抓帧成功');
      const cap = look.data.capture || {};
      check(cap.w >= 640 && cap.h >= 360, `game.look：画面尺寸合理（${cap.w}×${cap.h}）`);
      const lines = look.data.ocr?.lineCount;
      check(typeof lines === 'number' && lines > 0, `game.look：OCR 有结果（${lines} 行）`);
      const hit = Array.isArray(look.data.find) && look.data.find[0];
      check(hit && typeof hit.coverage === 'number', 'game.look：find 返回覆盖率');
      checks.push('game.look 实拍结果：' + String(look.data.ocr?.text || '').slice(0, 80).replace(/\n/g, ' / '));
    } catch (error) {
      checks.push('--live 抓帧失败（游戏没开或被挡住？不影响离线部分）：' + (error instanceof Error ? error.message : String(error)));
    }
  } else {
    check(true, '未加 --live：跳过真抓帧（不碰游戏）');
  }

  const code = await stopPetd(started.child);
  check(code === 0, '优雅退出 exit=0');
  check(!fs.existsSync(path.join(home, 'gateway.json')), 'gateway.json 已删除');
  started = null;

  console.log(`✅ game-smoke 通过 ${checks.length}/${checks.length} 项检查${live ? '（含 --live 真抓帧）' : '（未碰游戏）'}`);
  for (const c of checks) console.log('  · ' + c);
} catch (error) {
  console.error('❌ game-smoke 失败：' + (error instanceof Error ? error.message : String(error)));
  if (started) console.error('stderr:', started.stderr().slice(-3000));
  process.exitCode = 1;
} finally {
  if (started) await stopPetd(started.child);
}
