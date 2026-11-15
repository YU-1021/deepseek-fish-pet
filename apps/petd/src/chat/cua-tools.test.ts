/**
 * CUA 工具接入聊天工具箱的测试：工具清单、截图转图片、错误文案、不计写配额。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CuaEngine } from '../cua/engine.js';
import { CUA_TOOL_NAMES, CUA_TOOLS, executeCuaTool } from './cua-tools.js';
import { MemoryToolbox, type MemoryToolboxOptions } from './tools.js';

const SCREENSHOT = {
  ok: true,
  text: '屏幕截图：640×360（显示器 1，物理 1920×1080）',
  screenshot: {
    width: 640,
    height: 360,
    displayIndex: 0,
    scale: 1 / 3,
    displays: [{ index: 0, primary: true, width: 1920, height: 1080, x: 0, y: 0, dpi: 96 }],
    cursor: { x: 10, y: 20 },
    cursorText: '截图坐标 (30, 60)',
    foreground: { hwnd: 1, title: '记事本', app: 'notepad.exe', displayIndex: 0 },
    jpeg: Buffer.from('fake-jpeg'),
  },
};

function fakeCua(over: { enabled?: boolean } = {}): CuaEngine {
  const cua = {
    enabled: over.enabled ?? true,
    screenshot: async () => SCREENSHOT,
    zoom: async () => SCREENSHOT,
    windows: async () => ({ ok: true, text: '窗口（1 个）：\n- [0x1] 「记事本」(notepad.exe) 前台' }),
    focus: async () => ({ ok: true, text: '已切到窗口「记事本」' }),
    click: async () => ({ ok: true, text: '已在 (10, 20) 左键点击' }),
    move: async () => ({ ok: true, text: '鼠标已移到截图坐标 (10, 20)' }),
    drag: async () => ({ ok: true, text: '已从 (1, 2) 拖到 (3, 4)' }),
    mouseDown: async () => ({ ok: true, text: '已按住鼠标左键' }),
    mouseUp: async () => ({ ok: true, text: '已松开鼠标左键' }),
    scroll: async () => ({ ok: true, text: '已在 (10, 20) 滚动' }),
    type: async () => ({ ok: true, text: '已在光标处输入 2 个字符' }),
    key: async () => ({ ok: true, text: '已按 ctrl+s' }),
    wait: async () => ({ ok: true, text: '等了 1 秒' }),
  };
  return cua as unknown as CuaEngine;
}

function makeToolbox(cua: CuaEngine | undefined, includeImages: boolean): MemoryToolbox {
  const opts: MemoryToolboxOptions = {
    service: {} as never,
    maxWrites: 3,
    maxResultChars: 4000,
    ...(cua === undefined ? {} : { cua, cuaIncludeImages: includeImages }),
  };
  return new MemoryToolbox(opts);
}

test('工具清单：启用 CUA 时追加 13 个 cua_* 工具', () => {
  assert.equal(CUA_TOOLS.length, 13);
  assert.equal(CUA_TOOL_NAMES.size, 13);
  const toolbox = makeToolbox(fakeCua(), true);
  const names = toolbox.definitions().map((t) => t.function.name);
  assert.ok(names.includes('cua_screenshot'));
  assert.ok(names.includes('cua_click'));
  assert.ok(names.includes('cua_type'));
  assert.ok(names.includes('list_files'));
  assert.equal(names.filter((n) => n.startsWith('cua_')).length, 13);
});

test('未启用 CUA：清单里没有 cua_*，执行 cua_* 给明确错误', async () => {
  const toolbox = makeToolbox(undefined, false);
  const names = toolbox.definitions().map((t) => t.function.name);
  assert.equal(names.filter((n) => n.startsWith('cua_')).length, 0);

  const res = await toolbox.execute({ id: '1', name: 'cua_screenshot', arguments: '{}' });
  assert.equal(res.ok, false);
  assert.match(res.text, /电脑操作没有开启/);
});

test('cua_screenshot：includeImages=true 时返回 JPEG base64', async () => {
  const toolbox = makeToolbox(fakeCua(), true);
  const res = await toolbox.execute({ id: '1', name: 'cua_screenshot', arguments: '{}' });
  assert.equal(res.ok, true);
  assert.match(res.text, /屏幕截图：640×360/);
  assert.equal(res.images?.length, 1);
  assert.equal(res.images?.[0]?.mime, 'image/jpeg');
  assert.equal(res.images?.[0]?.data, Buffer.from('fake-jpeg').toString('base64'));
});

test('cua_screenshot：includeImages=false 时不带图片', async () => {
  const toolbox = makeToolbox(fakeCua(), false);
  const res = await toolbox.execute({ id: '1', name: 'cua_screenshot', arguments: '{}' });
  assert.equal(res.ok, true);
  assert.equal(res.images, undefined);
});

test('cua_click：参数映射与错误文案', async () => {
  const toolbox = makeToolbox(fakeCua(), true);
  const ok = await toolbox.execute({ id: '1', name: 'cua_click', arguments: JSON.stringify({ x: 10, y: 20, button: 'right', clicks: 2 }) });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /左键点击/);

  const bad = await toolbox.execute({ id: '2', name: 'cua_click', arguments: JSON.stringify({ x: 'a' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /错误/);
});

test('executeCuaTool：未知 CUA 工具 / 参数校验', async () => {
  await assert.rejects(executeCuaTool(fakeCua(), 'cua_nope', {}, { includeImages: false }), /没有这个电脑操作工具/);
  await assert.rejects(executeCuaTool(fakeCua(), 'cua_click', {}, { includeImages: false }), /参数 x 必须是数字/);
});
