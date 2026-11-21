/**
 * CUA 引擎测试：假驱动覆盖感知、坐标映射、授权档位、让位、暂停/只读、终端保护与输入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import { PauseGate } from '../kernel/pause.js';
import { CuaEngine, type CuaDriver } from './engine.js';
import type {
  AskPermission,
  CursorPoint,
  DisplayInfo,
  ForegroundInfo,
  MouseButton,
  WindowEntry,
} from './types.js';

type CuaConfig = typeof DEFAULT_CONFIG.cua;

class FakeDriver implements CuaDriver {
  platform: 'win32' | 'unsupported' = 'win32';
  display: DisplayInfo = { index: 0, primary: true, width: 1920, height: 1080, x: 0, y: 0, dpi: 96 };
  cursor: CursorPoint = { x: 100, y: 100 };
  foregroundApp = 'code.exe';
  foregroundTitle = 'main.ts - Visual Studio Code';
  idleMs = 60_000;
  captures = 0;
  clicks: Array<{ x: number; y: number; button: MouseButton; count: number }> = [];
  moves: Array<{ x: number; y: number }> = [];
  scrolls: Array<{ x: number; y: number; down: number; right: number }> = [];
  chords: number[][] = [];
  typed = '';
  releases = 0;
  focusResult = true;
  windowsList: WindowEntry[] = [];

  listDisplays(): DisplayInfo[] {
    return [this.display];
  }
  cursorPos(): CursorPoint {
    return this.cursor;
  }
  foreground(): ForegroundInfo {
    return { hwnd: 11, title: this.foregroundTitle, app: this.foregroundApp, displayIndex: 0 };
  }
  capture(display: DisplayInfo): { bgra: Buffer; width: number; height: number } {
    this.captures += 1;
    return { bgra: Buffer.alloc(display.width * display.height * 4, 0x40), width: display.width, height: display.height };
  }
  windows(): WindowEntry[] {
    return this.windowsList;
  }
  focus(): boolean {
    return this.focusResult;
  }
  moveMouse(x: number, y: number): void {
    this.moves.push({ x, y });
    this.cursor = { x, y };
  }
  clickAt(x: number, y: number, button: MouseButton, count: number): void {
    this.clicks.push({ x, y, button, count });
    this.cursor = { x, y };
  }
  mouseDown(): void {}
  mouseUp(): void {}
  scrollAt(x: number, y: number, down: number, right: number): void {
    this.scrolls.push({ x, y, down, right });
  }
  keyChord(vks: number[]): void {
    this.chords.push(vks);
  }
  keyDown(): void {}
  keyUp(): void {}
  sendUnicodeText(text: string, from: number): number {
    const rest = text.slice(from);
    const n = Math.min(rest.length, 3);
    this.typed += rest.slice(0, n);
    return from + n;
  }
  releaseAll(): void {
    this.releases += 1;
  }
  sampleActivity(): { idleMs: number; cursor: CursorPoint } {
    return { idleMs: this.idleMs, cursor: this.cursor };
  }
}

function makeConfig(over: Partial<CuaConfig> = {}): CuaConfig {
  const base = DEFAULT_CONFIG.cua;
  return {
    ...base,
    enabled: true,
    ...over,
    screenshot: {
      ...base.screenshot,
      afterAction: false,
      settleMs: 0,
      maxWidth: 640,
      maxHeight: 360,
      ...(over.screenshot ?? {}),
    },
  };
}

function makeEngine(opts: { over?: Partial<CuaConfig>; ask?: AskPermission; pauseGate?: PauseGate; now?: () => number } = {}) {
  const driver = new FakeDriver();
  const asks: Array<{ kind: 'see' | 'act'; question: string }> = [];
  const ask: AskPermission =
    opts.ask ??
    (async (kind, question) => {
      asks.push({ kind, question });
      return true;
    });
  const engine = new CuaEngine({
    config: makeConfig(opts.over),
    driver,
    ask,
    logger: { info: () => {}, warn: () => {} },
    ...(opts.pauseGate === undefined ? {} : { pauseGate: opts.pauseGate }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return { driver, engine, asks };
}

test('status：开关/显示器/前台/空闲/未暂停', () => {
  const { engine } = makeEngine();
  const s = engine.status();
  assert.equal(s.enabled, true);
  assert.equal(s.control, true);
  assert.equal(s.engine, 'win32');
  assert.equal(s.idleMs, 60_000);
  assert.equal(s.paused, false);
  assert.equal(s.displays.length, 1);
  assert.equal(s.foreground?.app, 'code.exe');
});

test('未开启 / 非 Windows：感知与输入都报 E_UNAVAILABLE', async () => {
  const off = makeEngine({ over: { enabled: false } });
  await assert.rejects(off.engine.screenshot(), /电脑操作未开启/);

  const driver = new FakeDriver();
  driver.platform = 'unsupported';
  const engine = new CuaEngine({ config: makeConfig(), driver, logger: { info: () => {}, warn: () => {} } });
  assert.equal(engine.enabled, false);
  await assert.rejects(engine.screenshot(), /当前系统不支持电脑操作/);
});

test('screenshot：按上限缩小到 640×360，说明含尺寸/前台/坐标约定', async () => {
  const { engine, driver } = makeEngine();
  const r = await engine.screenshot();
  assert.equal(r.ok, true);
  assert.equal(r.screenshot.width, 640);
  assert.equal(r.screenshot.height, 360);
  assert.ok(Math.abs(r.screenshot.scale - 3) < 0.001);
  assert.match(r.text, /屏幕截图：640×360/);
  assert.match(r.text, /code\.exe/);
  assert.match(r.text, /坐标约定/);
  assert.equal(driver.captures, 1);
  assert.ok(r.screenshot.jpeg.length > 0);
});

test('坐标换算：截图坐标 ×scale 映射到物理像素；未截图与越界报错', async () => {
  const { engine, driver } = makeEngine();
  await assert.rejects(engine.click({ x: 10, y: 10 }), /还没有截图/);

  await engine.screenshot();
  const r = await engine.click({ x: 300, y: 150 });
  assert.equal(r.ok, true);
  assert.deepEqual(driver.clicks[0], { x: 900, y: 450, button: 'left', count: 1 });

  await assert.rejects(engine.click({ x: 700, y: 10 }), /坐标超出截图范围/);
  await assert.rejects(engine.click({ x: -1, y: 0 }), /坐标超出截图范围/);
});

test('ask-once：看屏幕不问、输入只问一次、授权过期后再问', async () => {
  let nowMs = 1_000_000;
  const { engine, asks } = makeEngine({
    over: { permission: 'ask-once', grantMinutes: 1 },
    now: () => nowMs,
  });
  await engine.screenshot();
  assert.equal(asks.length, 0);

  await engine.click({ x: 1, y: 1 });
  assert.equal(asks.length, 1);
  assert.equal(asks[0]?.kind, 'act');

  await engine.click({ x: 2, y: 2 });
  assert.equal(asks.length, 1);

  nowMs += 61_000;
  await engine.click({ x: 3, y: 3 });
  assert.equal(asks.length, 2);
});

test('ask-each-turn：每轮看屏幕问一次，输入每次都问；轮末重置', async () => {
  const { engine, asks } = makeEngine({ over: { permission: 'ask-each-turn' } });
  await engine.screenshot();
  await engine.screenshot();
  assert.equal(asks.length, 1);
  assert.equal(asks[0]?.kind, 'see');

  await engine.click({ x: 1, y: 1 });
  assert.equal(asks.length, 2);
  await engine.click({ x: 2, y: 2 });
  assert.equal(asks.length, 3);

  engine.onTurnEnded();
  await engine.screenshot();
  assert.equal(asks.length, 4);
});

test('授权被拒 / 超时：不产生任何输入', async () => {
  const denied = makeEngine({ over: { permission: 'ask-once' }, ask: async () => false });
  await denied.engine.screenshot();
  await assert.rejects(denied.engine.click({ x: 1, y: 1 }), /用户拒绝了这次操作/);
  assert.equal(denied.driver.clicks.length, 0);

  const timeout = makeEngine({ over: { permission: 'ask-once' }, ask: async () => null });
  await timeout.engine.screenshot();
  await assert.rejects(timeout.engine.click({ x: 1, y: 1 }), /等待授权超时/);
  assert.equal(timeout.driver.clicks.length, 0);
});

test('暂停与只读：分别拒绝感知和输入', async () => {
  const gate = new PauseGate({ now: () => 1 });
  const paused = makeEngine({ pauseGate: gate });
  await paused.engine.screenshot();
  gate.pause('测试暂停');
  assert.equal(paused.engine.status().paused, true);
  await assert.rejects(paused.engine.screenshot(), /已暂停运行/);
  gate.resume();

  const readOnly = makeEngine({ over: { control: false } });
  await readOnly.engine.screenshot();
  await assert.rejects(readOnly.engine.click({ x: 1, y: 1 }), /只读模式/);
});

test('让位：用户一直在用电脑时输入不执行', async () => {
  const { engine, driver } = makeEngine({ over: { userIdleMs: 2000, maxYieldWaitMs: 50 } });
  driver.idleMs = 300;
  await engine.screenshot();
  const r = await engine.click({ x: 1, y: 1 });
  assert.equal(r.ok, false);
  assert.match(r.text, /用户正在用电脑/);
  assert.equal(driver.clicks.length, 0);
});

test('终端保护：前台是终端时额外问一次；拒绝则不输入', async () => {
  const accept = makeEngine({ over: { permission: 'never-ask' } });
  accept.driver.foregroundApp = 'powershell.exe';
  await accept.engine.screenshot();
  const r = await accept.engine.type({ text: 'echo hi' });
  assert.equal(r.ok, true);
  assert.equal(accept.asks.length, 1);
  assert.match(accept.asks[0]?.question ?? '', /终端/);
  assert.equal(accept.driver.typed, 'echo hi');

  const deny = makeEngine({ over: { permission: 'never-ask' }, ask: async () => false });
  deny.driver.foregroundApp = 'powershell.exe';
  await deny.engine.screenshot();
  await assert.rejects(deny.engine.type({ text: 'dir' }), /用户没有允许在终端里操作/);
  assert.equal(deny.driver.typed, '');
});

test('输入：文本分块打全、组合键、拖拽松开、轮末释放', async () => {
  const { engine, driver } = makeEngine();
  await engine.screenshot();

  const typed = await engine.type({ text: 'hello' });
  assert.equal(driver.typed, 'hello');
  assert.match(typed.text, /5 个字符/);

  const key = await engine.key({ keys: 'ctrl+s' });
  assert.equal(key.ok, true);
  assert.deepEqual(driver.chords[0], [0x11, 0x53]);

  const drag = await engine.drag({ from: { x: 10, y: 20 }, to: { x: 50, y: 60 } });
  assert.equal(drag.ok, true);
  assert.equal(driver.moves.length, 8);

  engine.onTurnEnded();
  assert.equal(driver.releases, 1);
});

test('自我保护：前台是自己的窗口时额外确认；拒绝就不执行', async () => {
  const accept = makeEngine({ over: { permission: 'never-ask' } });
  accept.driver.foregroundTitle = '大肥鱼 - pet-ui';
  await accept.engine.screenshot();
  const r = await accept.engine.click({ x: 5, y: 5 });
  assert.equal(r.ok, true);
  assert.equal(accept.asks.length, 1);
  assert.match(accept.asks[0]?.question ?? '', /自我保护/);
  assert.match(accept.asks[0]?.question ?? '', /大肥鱼/);
  assert.equal(accept.driver.clicks.length, 1);

  const deny = makeEngine({ over: { permission: 'never-ask' }, ask: async () => false });
  deny.driver.foregroundTitle = '大肥鱼 - pet-ui';
  await deny.engine.screenshot();
  await assert.rejects(deny.engine.click({ x: 5, y: 5 }), /用户没有允许操作我自己的窗口/);
  assert.equal(deny.driver.clicks.length, 0);

  // 自我保护不缓存：两次点击要问两次
  const twice = makeEngine({ over: { permission: 'never-ask' } });
  twice.driver.foregroundTitle = '大肥鱼 - pet-ui';
  await twice.engine.screenshot();
  await twice.engine.click({ x: 1, y: 1 });
  await twice.engine.click({ x: 2, y: 2 });
  assert.equal(twice.asks.length, 2);
});

test('自我保护：要输入的文字含配置/密钥/自我迭代文件名时警告', async () => {
  const { engine, asks, driver } = makeEngine({ over: { permission: 'never-ask' } });
  await engine.screenshot();
  const r = await engine.type({ text: 'type secrets.json' });
  assert.equal(r.ok, true);
  assert.equal(asks.length, 1);
  assert.match(asks[0]?.question ?? '', /secrets\.json/);
  assert.equal(driver.typed, 'type secrets.json');

  const dangerous = makeEngine({ over: { permission: 'never-ask' }, ask: async () => false });
  await dangerous.engine.screenshot();
  await assert.rejects(dangerous.engine.type({ text: 'echo hi > SOUL.md' }), /用户没有允许操作我自己的窗口/);
  assert.equal(dangerous.driver.typed, '');
});

test('自我保护：普通窗口不额外打扰；可配置关闭', async () => {
  const plain = makeEngine({ over: { permission: 'never-ask' } });
  plain.driver.foregroundTitle = '无标题 - 记事本';
  plain.driver.foregroundApp = 'notepad.exe';
  await plain.engine.screenshot();
  await plain.engine.type({ text: 'hello' });
  assert.equal(plain.asks.length, 0);

  const off = makeEngine({
    over: { permission: 'never-ask', selfProtect: { ...DEFAULT_CONFIG.cua.selfProtect, enabled: false } },
  });
  off.driver.foregroundTitle = '大肥鱼 - pet-ui';
  await off.engine.screenshot();
  await off.engine.type({ text: 'hi' });
  assert.equal(off.asks.length, 0);
});

test('scroll 全零 / zoom 区域 / 窗口切换参数校验', async () => {
  const { engine, driver } = makeEngine();
  await engine.screenshot();
  await assert.rejects(engine.scroll({ x: 1, y: 1 }), /不能都是 0/);
  await assert.rejects(engine.zoom({ x: -1, y: 0, width: 10, height: 10 }), /区域超出截图范围/);
  await assert.rejects(engine.zoom({ x: 0, y: 0, width: 4, height: 4 }), /区域超出截图范围/);

  driver.windowsList = [
    {
      handle: '0x1',
      hwnd: 1,
      title: '记事本',
      app: 'notepad.exe',
      foreground: true,
      displayIndex: 0,
      minimized: false,
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
    },
  ];
  const w = await engine.windows();
  assert.match(w.text, /窗口（1 个）/);
  assert.match(w.text, /记事本/);
  const f = await engine.focus({ window: '记事本' });
  assert.equal(f.ok, true);
  const missing = await engine.focus({ window: '不存在' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /没有找到/);
});
