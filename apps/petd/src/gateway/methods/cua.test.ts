/**
 * CUA 方法注册与调用测试：cua.* 15 个方法 + run.pause/resume 控制面。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MethodRegistry } from '../registry.js';
import type { GatewayContext } from '@petd/protocol';
import { PauseGate } from '../../kernel/pause.js';
import type { CuaEngine } from '../../cua/engine.js';
import { registerCuaMethods } from './cua.js';
import { registerRunMethods } from './run.js';

const ctx: GatewayContext = {
  sessionId: 's-test',
  client: { name: 'test-client', version: '0.0.0' },
  signal: new AbortController().signal,
  startedAt: 1,
};

const STATUS = {
  enabled: true,
  control: true,
  permission: 'ask-once',
  grantedUntil: 0,
  terminalGrantedUntil: 0,
  paused: false,
  engine: 'win32',
  idleMs: 1234,
  foreground: { hwnd: 1, title: '记事本', app: 'notepad.exe', displayIndex: 0 },
  displays: [{ index: 0, primary: true, width: 1920, height: 1080, x: 0, y: 0, dpi: 96 }],
};

const SHOT = {
  ok: true,
  text: '屏幕截图：640×360',
  screenshot: {
    width: 640,
    height: 360,
    displayIndex: 0,
    scale: 1 / 3,
    displays: [{ index: 0, primary: true, width: 1920, height: 1080, x: 0, y: 0, dpi: 96 }],
    cursor: { x: 1, y: 2 },
    cursorText: '截图坐标 (3, 6)',
    foreground: { hwnd: 1, title: '记事本', app: 'notepad.exe', displayIndex: 0 },
    jpeg: Buffer.from('fake-jpeg'),
  },
};

function fakeCua(): CuaEngine {
  return {
    status: () => STATUS,
    screenshot: async () => SHOT,
    click: async () => ({ ok: true, text: '已在 (1, 2) 左键点击' }),
  } as unknown as CuaEngine;
}

function makeRegistry(engine: CuaEngine = fakeCua()) {
  const reg = new MethodRegistry();
  const answered: Array<{ id: string; accepted: boolean }> = [];
  registerCuaMethods(reg, {
    cua: engine,
    answerPermission: (id, accepted) => {
      answered.push({ id, accepted });
      return id === 'perm-1';
    },
  });
  const events: string[] = [];
  const pauseGate = new PauseGate({ now: () => 10 });
  registerRunMethods(reg, { pauseGate, publish: (event) => events.push(event) });
  return { reg, answered, events, pauseGate };
}

test('注册：15 个 cua.* 方法与 scope/幂等标记', () => {
  const { reg } = makeRegistry();
  const names = reg.names().filter((n) => n.startsWith('cua.'));
  assert.equal(names.length, 15);
  for (const name of ['cua.status', 'cua.screenshot', 'cua.zoom', 'cua.windows', 'cua.focus', 'cua.answer']) {
    assert.ok(reg.has(name), `缺少 ${name}`);
  }
  assert.equal(reg.requireMethod('cua.status').descriptor.scope, 'read');
  assert.equal(reg.requireMethod('cua.click').descriptor.scope, 'write');
  assert.equal(reg.requireMethod('cua.click').descriptor.idempotent, false);
});

test('cua.status：返回引擎状态', async () => {
  const { reg } = makeRegistry();
  const m = reg.requireMethod('cua.status');
  const result = (await m.handler({}, ctx)) as typeof STATUS;
  assert.equal(result.enabled, true);
  assert.equal(result.engine, 'win32');
  assert.equal(result.foreground?.app, 'notepad.exe');
});

test('cua.screenshot：includeImage 控制是否带 base64', async () => {
  const { reg } = makeRegistry();
  const m = reg.requireMethod('cua.screenshot');
  const plain = (await m.handler({ includeImage: false }, ctx)) as { width: number; imageBase64?: string };
  assert.equal(plain.width, 640);
  assert.equal(plain.imageBase64, undefined);

  const withImage = (await m.handler({ includeImage: true }, ctx)) as { imageBase64?: string };
  assert.equal(withImage.imageBase64, Buffer.from('fake-jpeg').toString('base64'));
});

test('cua.answer：转交权限回答并返回 found', async () => {
  const { reg, answered } = makeRegistry();
  const m = reg.requireMethod('cua.answer');
  const ok = (await m.handler({ id: 'perm-1', accepted: true }, ctx)) as { found: boolean };
  assert.deepEqual(ok, { found: true });
  assert.deepEqual(answered[0], { id: 'perm-1', accepted: true });

  const missing = (await m.handler({ id: 'perm-404', accepted: false }, ctx)) as { found: boolean };
  assert.equal(missing.found, false);
});

test('cua.click：调用引擎并返回回执', async () => {
  const { reg } = makeRegistry();
  const m = reg.requireMethod('cua.click');
  const r = (await m.handler({ x: 1, y: 2 }, ctx)) as { ok: boolean; text: string };
  assert.equal(r.ok, true);
  assert.match(r.text, /点击/);
});

test('run.*：暂停/恢复状态与事件', async () => {
  const { reg, events, pauseGate } = makeRegistry();
  const status = (await reg.requireMethod('run.status').handler({}, ctx)) as { paused: boolean };
  assert.equal(status.paused, false);

  const paused = (await reg.requireMethod('run.pause').handler({ reason: '测试' }, ctx)) as { paused: boolean; reason: string | null };
  assert.equal(paused.paused, true);
  assert.equal(paused.reason, '测试');
  assert.equal(pauseGate.paused, true);
  assert.ok(events.includes('run.paused'));

  const resumed = (await reg.requireMethod('run.resume').handler({}, ctx)) as { paused: boolean };
  assert.equal(resumed.paused, false);
  assert.ok(events.includes('run.resumed'));
});
