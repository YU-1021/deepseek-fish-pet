/**
 * 技能 / 插件端到端冒烟：真起 petd → 真 WS → 技能 CRUD + 插件启停 + 重启持久。
 *
 * 验证：
 *   1. config.get 返回 skills/plugins 配置；skill.list 可用（插件技能带前缀出现）；
 *   2. skill.create/get/update/delete 全流程，正文与 frontmatter 字段正确；
 *   3. 插件技能只读（update/delete 报 E_FORBIDDEN）；
 *   4. plugin.list/get/enable/disable，plugin.changed 事件广播；
 *   5. 重启后：工作区技能、插件启用状态都持久；
 *   6. 优雅退出 exit=0、gateway.json 被删除。
 *
 * 跑法：
 *   node scripts/skills-plugins-smoke.mjs               # 临时 home，跑完保留便于检查
 *   node scripts/skills-plugins-smoke.mjs --home D:\x  # 指定 home
 * 注意：不调模型，纯本地，约 3 秒。
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
const home = argHomeIdx >= 0 ? path.resolve(process.argv[argHomeIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'petd-skills-smoke-'));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ version: 1, skills: { enabled: true }, plugins: { enabled: true } }, null, 2) + '\n',
  'utf8'
);

// 预置一个声明式插件：home/plugins/demo/{plugin.json,prompt.md,skills/hello/SKILL.md}
const pluginRoot = path.join(home, 'plugins', 'demo');
fs.mkdirSync(path.join(pluginRoot, 'skills', 'hello'), { recursive: true });
fs.writeFileSync(
  path.join(pluginRoot, 'plugin.json'),
  JSON.stringify({ name: '演示插件', version: '1.0.0', description: '冒烟用插件', author: 'test' }, null, 2) + '\n',
  'utf8'
);
fs.writeFileSync(path.join(pluginRoot, 'prompt.md'), '这个插件会演示它自己的能力。\n', 'utf8');
fs.writeFileSync(
  path.join(pluginRoot, 'skills', 'hello', 'SKILL.md'),
  ['---', 'name: hello', 'description: 打招呼', 'always: true', '---', '', '先说你好，再自我介绍。', ''].join('\n'),
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
  const id = 'skills-smoke-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, timeoutMs, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  if (!res.ok) throw new Error(`${method} 失败：${JSON.stringify(res.error)}`);
  return res;
}

async function callExpectError(ws, client, method, params, code) {
  const id = 'skills-smoke-err-' + Math.random().toString(36).slice(2, 8);
  const p = client.waitFrame((f) => f.type === 'res' && f.id === id, 10000, method);
  ws.send(JSON.stringify({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
  const res = await p;
  check(!res.ok, `${method} 应失败`);
  check(res.error?.code === code, `${method} 错误码应为 ${code}，实际 ${res.error?.code}`);
  return res;
}

function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'petd-skills-smoke', version: '0.0.1' } }));
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
  // ── 第一次启动：技能 CRUD + 插件启停 ──
  first = startPetd();
  const ready = await first.ready;
  const token = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws, hello } = await connect(ready.port, token.token);
  const client = makeClient(ws);
  check(hello.server.name === 'petd', '握手成功');

  const cfg = await call(ws, client, 'config.get');
  check(cfg.data.skills?.enabled === true, 'config.get 返回 skills.enabled=true');
  check(cfg.data.skills?.promptMaxChars === 4000, 'config.get 返回 skills.promptMaxChars=4000');
  check(cfg.data.plugins?.enabled === true, 'config.get 返回 plugins.enabled=true');
  check(typeof cfg.data.plugins?.dir === 'string' && cfg.data.plugins.dir.length > 0, 'config.get 返回 plugins.dir');

  const initial = await call(ws, client, 'skill.list');
  check(initial.data.skills.length === 1 && initial.data.skills[0].key === 'demo/hello', '启动时只有插件技能 demo/hello');
  check(initial.data.skills[0].always === true, '插件技能 always=true');

  const pluginSkill = await call(ws, client, 'skill.get', { key: 'demo/hello' });
  check(pluginSkill.data.source === 'plugin', 'skill.get 返回来源 plugin');
  check(pluginSkill.data.body.includes('先说你好'), 'skill.get 返回正文');

  await callExpectError(ws, client, 'skill.update', { name: 'demo/hello', body: '改' }, 'E_FORBIDDEN');
  await callExpectError(ws, client, 'skill.delete', { name: 'demo/hello' }, 'E_FORBIDDEN');

  const created = await call(ws, client, 'skill.create', {
    name: 'focus',
    description: '专注工作',
    body: '每 25 分钟提醒休息，并帮我总结进展。',
    keywords: ['专注', '效率'],
    always: false,
  });
  check(created.data.key === 'focus', '创建技能 key=focus');
  check(created.data.bodyChars > 0, '创建返回正文长度');

  const listed = await call(ws, client, 'skill.list');
  check(listed.data.skills.length === 2, '技能列表 2 个');
  const keys = listed.data.skills.map((s) => s.key).sort();
  check(keys.join(',') === 'demo/hello,focus', `技能 keys 正确（${keys.join(',')}）`);

  const updated = await call(ws, client, 'skill.update', { name: 'focus', always: true, description: '更专注' });
  check(updated.data.always === true, 'skill.update 修改 always');
  const reread = await call(ws, client, 'skill.get', { key: 'focus' });
  check(reread.data.description === '更专注', '修改后 description 生效');
  check(fs.existsSync(path.join(home, 'skills', 'focus', 'SKILL.md')), '技能文件落盘 home/skills/focus/SKILL.md');

  const plugins = await call(ws, client, 'plugin.list');
  check(plugins.data.plugins.length === 1 && plugins.data.plugins[0].id === 'demo', '插件列表含 demo');
  check(plugins.data.plugins[0].enabled === true, 'demo 默认启用');
  check(plugins.data.plugins[0].skillCount === 1, 'demo 技能数=1');

  const pluginInfo = await call(ws, client, 'plugin.get', { id: 'demo' });
  check(pluginInfo.data.hasPrompt === true, 'plugin.get 检测到 prompt.md');
  check(pluginInfo.data.name === '演示插件', 'plugin.get 返回 name');

  const disabled = await call(ws, client, 'plugin.disable', { id: 'demo' });
  check(disabled.data.enabled === false, 'plugin.disable 生效');
  check(eventsOf(client, 'plugin.changed').length === 1, 'plugin.changed 已广播');
  const afterDisable = await call(ws, client, 'plugin.get', { id: 'demo' });
  check(afterDisable.data.enabled === false, 'plugin.get 反映停用');

  const enabled = await call(ws, client, 'plugin.enable', { id: 'demo' });
  check(enabled.data.enabled === true, 'plugin.enable 生效');
  check(eventsOf(client, 'plugin.changed').length === 2, 'plugin.changed 第二次广播');

  await call(ws, client, 'skill.delete', { name: 'focus' });
  check(fs.existsSync(path.join(home, 'skills', 'focus')) === false, '技能目录已删除');

  // 重启前再建一个技能，并停用一个插件
  await call(ws, client, 'skill.create', { name: 'persist-check', body: '重启后应该还在。' });
  await call(ws, client, 'plugin.disable', { id: 'demo' });

  const code1 = await stopPetd(first.child);
  check(code1 === 0, `第一次退出 exit=0（实际 ${code1}）`);
  check(fs.existsSync(path.join(home, 'gateway.json')) === false, 'gateway.json 已删除');
  first = null;

  // ── 第二次启动：验证持久 ──
  second = startPetd();
  const ready2 = await second.ready;
  const token2 = JSON.parse(fs.readFileSync(path.join(home, 'token.json'), 'utf8'));
  const { ws: ws2, hello: hello2 } = await connect(ready2.port, token2.token);
  const client2 = makeClient(ws2);
  check(hello2.server.name === 'petd', '重启后握手成功');

  const listed2 = await call(ws2, client2, 'skill.list');
  const keys2 = listed2.data.skills.map((s) => s.key).sort();
  // demo 插件在重启前被停用，所以它的技能不应出现在清单里；工作区技能应在
  check(keys2.join(',') === 'persist-check', `重启后技能仍在、停用插件技能隐藏（${keys2.join(',')}）`);

  const plugin2 = await call(ws2, client2, 'plugin.get', { id: 'demo' });
  check(plugin2.data.enabled === false, '重启后插件停用状态保留');

  await call(ws2, client2, 'skill.delete', { name: 'persist-check' });
  const code2 = await stopPetd(second.child);
  check(code2 === 0, `第二次退出 exit=0（实际 ${code2}）`);
  second = null;

  console.log(`skills/plugins smoke OK：${checks.length} 项全过（home=${home}）`);
} catch (e) {
  if (first !== null) {
    try {
      await stopPetd(first.child);
    } catch {
      /* ignore */
    }
  }
  if (second !== null) {
    try {
      await stopPetd(second.child);
    } catch {
      /* ignore */
    }
  }
  console.error('skills/plugins smoke 失败：', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
