/**
 * 人格自编系统端到端冒烟：真起 petd → 真 WS → 真 LLM 一次 persona.evolve（会花 token）
 * → patch/lock/history/rollback/权限/事件/落盘/优雅退出。
 *
 * 跑法：
 *   node scripts/persona-smoke.mjs               # 临时 home，跑完删
 *   node scripts/persona-smoke.mjs --home D:\x  # 保留 home 便于检查 SOUL.md / persona-state.json
 *
 * 前置：%APPDATA%/dayu-pet/config.json 里有可用 API Key（会自动迁移到临时 home 的 secrets.json）。
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
const home = keep ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-persona-'));

// 预置一段真实对话作为「最近经历」，让 persona.evolve 有依据可演（不额外调模型）
function seedExperience() {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const id = 's-smoke-seed-000001';
  const now = Date.now();
  const iso = (offset) => new Date(now + offset * 1000).toISOString();
  const messages = [
    { role: 'user', content: '今天加班到十点，脑子都木了。', ts: iso(0) },
    { role: 'assistant', content: '哼，又逞强。先把水喝了，剩下的明天再说。', ts: iso(1) },
    { role: 'user', content: '你陪我说说话就行，不用讲大道理。', ts: iso(2) },
    { role: 'assistant', content: '那我就在这儿，不说话也行。……不过你最好还是早点睡。', ts: iso(3) },
    { role: 'user', content: '以后我加班回来别急着催我睡，先陪我安静五分钟，行不行？', ts: iso(4) },
    { role: 'assistant', content: '……行。那五分钟里我不闹你，你想说就说，不想说我就待着。', ts: iso(5) },
    { role: 'user', content: '还有，别老叫我「主人」，叫我阿深就好。', ts: iso(6) },
    { role: 'assistant', content: '阿深……哼，叫顺口了可别怪我。', ts: iso(7) },
  ];
  fs.writeFileSync(path.join(dir, id + '.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        sessions: [{ id, title: '加班后的夜聊', createdAt: iso(0), updatedAt: iso(3), messageCount: messages.length }],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}
seedExperience();

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
  const id = 'persona-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  return p;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-persona-smoke', version: '0.0.1' } }));
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

let childExited = false;
child.once('exit', () => {
  childExited = true;
});

try {
  const ready = await waitForReady();
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const soulFile = path.join(home, 'SOUL.md');
  const stateFile = path.join(home, 'persona-state.json');
  check(fs.existsSync(soulFile), 'SOUL.md 已播种');
  check(fs.existsSync(stateFile), 'persona-state.json 已创建');
  const state0 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check(state0.version === 1, '初始人格版本=1');
  check(state0.history?.[0]?.version === 1, '保留了初始版本历史（可回滚到 v1）');
  check(state0.history?.[0]?.actor === 'system', '初始版本 actor=system');
  const soul0 = fs.readFileSync(soulFile, 'utf8');
  check(soul0.length > 0, 'SOUL.md 非空');

  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const got0 = await call(ws, client, 'persona.get');
  check(got0.ok, 'persona.get 可调用');
  const snap0 = got0.data;
  check(snap0.version === 1, 'persona.get 版本=1');
  check(Array.isArray(snap0.sections) && snap0.sections.length > 0, 'persona.get 返回小节');
  check(snap0.sections.some((s) => s.key === 'character' && s.aiEditable), 'character 可被 AI 改');
  check(snap0.sections.some((s) => s.key === 'speaking'), '有说话方式小节');
  check(snap0.sections.some((s) => s.key === 'worldview' && s.userOnly), '世界观存在且仅用户可改');

  // 用户改人格
  const newSpeaking = '- 冒烟测试专用语气：简短、自然。';
  const patched = await call(ws, client, 'persona.patch', { sections: { speaking: newSpeaking }, reason: '冒烟改说话方式' });
  check(patched.ok && patched.data.changed === true, 'persona.patch 生效');
  check(patched.data.version === 2, 'patch 后版本=2');
  check(patched.data.applied.includes('speaking'), 'applied 含 speaking');
  check(fs.readFileSync(soulFile, 'utf8').includes(newSpeaking), 'SOUL.md 已落盘新内容');
  const ev1 = client.events.find((e) => e.event === 'persona.changed' && e.data?.actor === 'user');
  check(Boolean(ev1), 'persona.changed(user) 已广播');

  // 乐观并发
  const conflict = await call(ws, client, 'persona.patch', { sections: { speaking: '- 旧版本写入' }, expectedVersion: 1 });
  check(conflict.ok === false && conflict.error?.code === 'E_CONFLICT', 'expectedVersion 冲突 E_CONFLICT');

  // 锁
  const locked = await call(ws, client, 'persona.lock', { key: 'character', locked: true });
  check(locked.ok && locked.data.locks.character === true, 'persona.lock 上锁生效');
  const badLock = await call(ws, client, 'persona.lock', { key: 'worldview', locked: true });
  check(badLock.ok === false && badLock.error?.code === 'E_BAD_PARAMS', '世界观不能上锁');

  // 历史
  const hist = await call(ws, client, 'persona.history', { limit: 10 });
  check(hist.ok && hist.data.revisions.length >= 2, 'persona.history 有历史版本');
  check(hist.data.revisions[0].version === 2, '最新历史版本=2');

  // 真 LLM 自演化（1 次调用；改不改都算通过）
  const t0 = Date.now();
  const evolved = await call(ws, client, 'persona.evolve', {}, 130000);
  const evolveMs = Date.now() - t0;
  check(evolved.ok, `persona.evolve 成功（${evolveMs}ms）`);
  const ev = evolved.data;
  check(typeof ev.reason === 'string' && ev.reason.length > 0, 'evolve 返回原因');
  check(typeof ev.version === 'number' && ev.version >= 2, 'evolve 返回版本号');
  const soulAfterEv = fs.readFileSync(soulFile, 'utf8');
  if (ev.changed) {
    check(soulAfterEv !== soul0, 'evolve 改动已落盘');
    const ev2 = client.events.find((e) => e.event === 'persona.changed' && e.data?.actor === 'agent');
    check(Boolean(ev2), 'persona.changed(agent) 已广播');
  }
  const afterEvolveVersion = ev.version;

  // 回滚到 v2
  const rb = await call(ws, client, 'persona.rollback', { version: 2 });
  check(rb.ok && rb.data.changed === true, 'persona.rollback 生效');
  check(rb.data.version === afterEvolveVersion + 1, `回滚后版本=上一版+1（${rb.data.version}）`);
  check(fs.readFileSync(soulFile, 'utf8').includes(newSpeaking), '回滚到 v2 后含 v2 内容');

  // 解锁
  const unlocked = await call(ws, client, 'persona.lock', { key: 'character', locked: false });
  check(unlocked.ok && !unlocked.data.locks.character, 'persona.lock 解锁生效');

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
  const stateEnd = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check(stateEnd.version === afterEvolveVersion + 1, 'persona-state.json 最终版本一致');

  console.log(
    JSON.stringify(
      {
        ok: true,
        home: keep ? home : '(临时目录，已删除)',
        evolveMs,
        evolveChanged: ev.changed,
        evolveReason: ev.reason,
        finalVersion: stateEnd.version,
        checks: checks.length,
        checksList: checks,
      },
      null,
      2
    )
  );
} catch (err) {
  console.error('PERSONA SMOKE FAILED:', err instanceof Error ? err.message : String(err));
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
