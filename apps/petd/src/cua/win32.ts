/**
 * Win32 底层：显示器枚举、截图（GDI BitBlt + CAPTUREBLT）、鼠标键盘注入（SendInput）、
 * 用户活动检测（GetLastInputInfo + 光标采样）、窗口枚举与聚焦。
 *
 * 设计参考 Coo 的 CUA 引擎（AGPL 的 Coo 源码未复制，这里按公开 Win32 API 重写）。
 * v1 跑在 petd 进程内（koffi 直接调 DLL），崩溃隔离（engine 子进程）留到后续版本。
 */
import { createRequire } from 'node:module';
import { CuaError } from './types.js';
import type { CursorPoint, DisplayInfo, ForegroundInfo, Rect, WindowEntry } from './types.js';

const require = createRequire(import.meta.url);
const koffi: any = require('koffi');

export const IS_WIN = process.platform === 'win32';

const MOUSEEVENTF = {
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
  ABSOLUTE: 0x8000,
  VIRTUALDESK: 0x4000,
};

const KEYEVENTF = { KEYUP: 0x0002, UNICODE: 0x0004 };

const DWM_CLOAKED = 14;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

interface Libs {
  user32: any;
  kernel32: any;
  gdi32: any;
  dwmapi: any;
  shcore: any | null;
  fns: Record<string, any>;
  INPUT: any;
}

let libs: Libs | null = null;

function load(): Libs {
  if (!IS_WIN) throw new CuaError('E_UNAVAILABLE', '当前系统不支持电脑操作（只支持 Windows）');
  if (libs) return libs;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    let shcore: any | null = null;
    try {
      shcore = koffi.load('shcore.dll');
    } catch {
      shcore = null;
    }
    const MOUSEINPUT = koffi.struct('PETD_MOUSEINPUT', {
      dx: 'long',
      dy: 'long',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const KEYBDINPUT = koffi.struct('PETD_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const HARDWAREINPUT = koffi.struct('PETD_HARDWAREINPUT', {
      uMsg: 'uint32',
      wParamL: 'uint16',
      wParamH: 'uint16',
    });
    const INPUT_U = koffi.union('PETD_INPUT_U', {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
      hi: HARDWAREINPUT,
    });
    const INPUT = koffi.struct('PETD_INPUT', { type: 'uint32', u: INPUT_U });
    libs = { user32, kernel32, gdi32, dwmapi, shcore, fns: {}, INPUT };
    const f = libs.fns;
    f.GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ void *pt)');
    f.SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    f.SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)');
    f.GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
    f.GetForegroundWindow = user32.func('size_t __stdcall GetForegroundWindow()');
    f.GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(size_t hwnd)');
    f.GetWindowTextW = user32.func('int __stdcall GetWindowTextW(size_t hwnd, void *buf, int len)');
    f.GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(size_t hwnd, _Out_ uint32 *pid)');
    f.IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(size_t hwnd)');
    f.IsIconic = user32.func('bool __stdcall IsIconic(size_t hwnd)');
    f.GetWindowRect = user32.func('bool __stdcall GetWindowRect(size_t hwnd, _Out_ void *rect)');
    f.EnumWindows = user32.func('bool __stdcall EnumWindows(void *cb, intptr_t lParam)');
    f.EnumDisplayMonitors = user32.func('bool __stdcall EnumDisplayMonitors(void *hdc, void *clip, void *cb, intptr_t lParam)');
    f.GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(size_t hmon, _Inout_ void *mi)');
    f.ShowWindow = user32.func('bool __stdcall ShowWindow(size_t hwnd, int cmd)');
    f.SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(size_t hwnd)');
    f.GetDC = user32.func('size_t __stdcall GetDC(size_t hwnd)');
    f.ReleaseDC = user32.func('int __stdcall ReleaseDC(size_t hwnd, size_t hdc)');
    f.SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
    f.EnumWindowsProto = koffi.proto('int __stdcall PETD_ENUMWINDOWSPROC(size_t hwnd, intptr_t lParam)');
    f.EnumMonitorsProto = koffi.proto('int __stdcall PETD_ENUMMONITORSPROC(size_t hmon, size_t hdc, void *rect, intptr_t lParam)');
    f.CreateCompatibleDC = gdi32.func('size_t __stdcall CreateCompatibleDC(size_t hdc)');
    f.CreateCompatibleBitmap = gdi32.func('size_t __stdcall CreateCompatibleBitmap(size_t hdc, int w, int h)');
    f.SelectObject = gdi32.func('size_t __stdcall SelectObject(size_t hdc, size_t obj)');
    f.BitBlt = gdi32.func('bool __stdcall BitBlt(size_t dst, int x, int y, int w, int h, size_t src, int sx, int sy, uint32 rop)');
    f.GetDIBits = gdi32.func('int __stdcall GetDIBits(size_t hdc, size_t hbmp, uint32 start, uint32 lines, void *bits, void *bmi, uint32 usage)');
    f.DeleteObject = gdi32.func('bool __stdcall DeleteObject(size_t obj)');
    f.DeleteDC = gdi32.func('bool __stdcall DeleteDC(size_t hdc)');
    f.CloseHandle = kernel32.func('bool __stdcall CloseHandle(size_t h)');
    f.OpenProcess = kernel32.func('size_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
    f.QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(size_t h, uint32 flags, void *buf, _Inout_ uint32 *size)');
    f.GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
    f.GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ void *lii)');
    f.DwmGetWindowAttribute = dwmapi.func('int __stdcall DwmGetWindowAttribute(size_t hwnd, uint32 attr, void *value, uint32 size)');
    if (shcore) {
      f.GetDpiForMonitor = shcore.func('int __stdcall GetDpiForMonitor(size_t hmon, int dpiType, _Out_ uint32 *x, _Out_ uint32 *y)');
    }
    try {
      f.SetProcessDpiAwarenessContext(-4);
    } catch {
      /* 忽略：拿不到 DPI 感知就按系统缩放走 */
    }
    return libs;
  } catch (e) {
    throw new CuaError('E_INTERNAL', `加载 Win32 API 失败：${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- 显示器

function readMonitorInfo(buf: Buffer) {
  // MONITORINFO: cbSize(4), rcMonitor(16), rcWork(16), dwFlags(4)
  return {
    cbSize: buf.readUInt32LE(0),
    left: buf.readInt32LE(4),
    top: buf.readInt32LE(8),
    right: buf.readInt32LE(12),
    bottom: buf.readInt32LE(16),
    flags: buf.readUInt32LE(36),
  };
}

export function listDisplays(): DisplayInfo[] {
  const l = load();
  const out: DisplayInfo[] = [];
  const cb = koffi.register((hmon: unknown, _hdc: unknown, _rect: unknown, _l: unknown) => {
    try {
      const mi = Buffer.alloc(40);
      mi.writeUInt32LE(40, 0);
      if (!l.fns.GetMonitorInfoW(hmon, mi)) return 1;
      const info = readMonitorInfo(mi);
      let dpi = 96;
      if (l.fns.GetDpiForMonitor) {
        try {
          const dxBuf = Buffer.alloc(4);
          const dyBuf = Buffer.alloc(4);
          if (l.fns.GetDpiForMonitor(hmon, 0, dxBuf, dyBuf) === 0) dpi = dxBuf.readUInt32LE(0) || 96;
        } catch {
          /* ignore */
        }
      }
      out.push({
        index: out.length,
        primary: (info.flags & 1) !== 0,
        width: info.right - info.left,
        height: info.bottom - info.top,
        x: info.left,
        y: info.top,
        dpi,
      });
    } catch {
      /* 单个显示器失败不影响其它 */
    }
    return 1;
  }, koffi.pointer(l.fns.EnumMonitorsProto));
  try {
    l.fns.EnumDisplayMonitors(null, null, cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  out.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  out.forEach((d, i) => {
    d.index = i;
  });
  if (out.length === 0) {
    const w = l.fns.GetSystemMetrics(0);
    const h = l.fns.GetSystemMetrics(1);
    out.push({ index: 0, primary: true, width: w, height: h, x: 0, y: 0, dpi: 96 });
  }
  return out;
}

export function primaryDisplay(displays: DisplayInfo[]): DisplayInfo {
  return displays.find((d) => d.primary) ?? displays[0]!;
}

export function displayOfPoint(displays: DisplayInfo[], x: number, y: number): DisplayInfo {
  for (const d of displays) {
    if (x >= d.x && y >= d.y && x < d.x + d.width && y < d.y + d.height) return d;
  }
  return primaryDisplay(displays);
}

export function virtualScreen(): { left: number; top: number; width: number; height: number } {
  const l = load();
  return {
    left: l.fns.GetSystemMetrics(76),
    top: l.fns.GetSystemMetrics(77),
    width: l.fns.GetSystemMetrics(78),
    height: l.fns.GetSystemMetrics(79),
  };
}

export function cursorPos(): CursorPoint {
  const l = load();
  const pt = Buffer.alloc(8);
  l.fns.GetCursorPos(pt);
  return { x: pt.readInt32LE(0), y: pt.readInt32LE(4) };
}

// ---------------------------------------------------------------- 窗口/前台

export function windowTitle(hwnd: number): string {
  const l = load();
  const len = l.fns.GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  l.fns.GetWindowTextW(hwnd, buf, len + 1);
  return buf.toString('utf16le', 0, len * 2).replace(/\0+$/, '');
}

export function processName(hwnd: number): string {
  const l = load();
  try {
    const pidBuf = Buffer.alloc(4);
    l.fns.GetWindowThreadProcessId(hwnd, pidBuf);
    const pidv = pidBuf.readUInt32LE(0);
    if (!pidv) return '';
    const hProc = l.fns.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pidv);
    if (!hProc) return '';
    try {
      const buf = Buffer.alloc(2048);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(1024, 0);
      if (!l.fns.QueryFullProcessImageNameW(hProc, 0, buf, sizeBuf)) return '';
      const full = buf.toString('utf16le', 0, sizeBuf.readUInt32LE(0) * 2).replace(/\0+$/, '');
      const base = full.split('\\').pop() ?? full;
      return base.toLowerCase();
    } finally {
      l.fns.CloseHandle(hProc);
    }
  } catch {
    return '';
  }
}

export function windowRect(hwnd: number): Rect {
  const l = load();
  const buf = Buffer.alloc(16);
  try {
    if (l.fns.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) !== 0) {
      throw new Error('dwm failed');
    }
  } catch {
    const r = Buffer.alloc(16);
    l.fns.GetWindowRect(hwnd, r);
    buf.set(r);
  }
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

export function foregroundWindow(): number {
  const l = load();
  const hwnd = Number(l.fns.GetForegroundWindow());
  return Number.isFinite(hwnd) ? hwnd : 0;
}

export function foregroundInfo(displays: DisplayInfo[]): ForegroundInfo {
  const hwnd = foregroundWindow();
  const c = cursorPos();
  const display = displayOfPoint(displays, c.x, c.y);
  return { hwnd, title: windowTitle(hwnd), app: processName(hwnd), displayIndex: display.index };
}

export function listWindows(): WindowEntry[] {
  const l = load();
  const displays = listDisplays();
  const fg = foregroundWindow();
  const out: WindowEntry[] = [];
  const debug = process.env.PETD_WIN32_DEBUG === '1';
  let calls = 0;
  const cb = koffi.register((hwnd: unknown) => {
    calls += 1;
    try {
      const h = Number(hwnd);
      if (debug) console.error('[win32] enum hwnd=', h, 'visible=', l.fns.IsWindowVisible(h));
      if (!h) return 1;
      if (!l.fns.IsWindowVisible(h)) return 1;
      const title = windowTitle(h);
      if (debug) console.error('[win32] title="' + title + '"');
      if (!title.trim()) return 1;
      const cloaked = Buffer.alloc(4);
      if (l.fns.DwmGetWindowAttribute(h, DWM_CLOAKED, cloaked, 4) === 0) {
        if (cloaked.readUInt32LE(0) !== 0) return 1;
      }
      const rect = windowRect(h);
      const minimized = Boolean(l.fns.IsIconic(h));
      const cx = Math.round((rect.left + rect.right) / 2);
      const cy = Math.round((rect.top + rect.bottom) / 2);
      const display = displayOfPoint(displays, cx, cy);
      out.push({
        handle: h.toString(16).toUpperCase(),
        hwnd: h,
        title,
        app: processName(h),
        foreground: h === fg,
        displayIndex: display.index,
        minimized,
        rect,
      });
      if (debug) console.error('[win32] kept hwnd=', h, 'title="' + title + '"');
    } catch (err) {
      if (debug) console.error('[win32] skip hwnd=', hwnd, String(err));
      /* 跳过坏窗口 */
    }
    return 1;
  }, koffi.pointer(l.fns.EnumWindowsProto));
  try {
    l.fns.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  if (debug) console.error('[win32] enum calls=', calls, 'kept=', out.length);
  // 前台窗口排最前，其余按标题排序稳定
  out.sort((a, b) => {
    if (a.foreground !== b.foreground) return a.foreground ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

export function focusWindow(hwnd: number): boolean {
  const l = load();
  try {
    if (l.fns.IsIconic(hwnd)) {
      l.fns.ShowWindow(hwnd, 9); // SW_RESTORE
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        if (!l.fns.IsIconic(hwnd)) break;
        sleepSync(30);
      }
    }
    l.fns.SetForegroundWindow(hwnd);
    return foregroundWindow() === hwnd;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 截图

/** 截某个显示器（物理像素），返回 BGRA 缓冲区（top-down）。 */
export function captureDisplay(display: DisplayInfo): { bgra: Buffer; width: number; height: number } {
  const l = load();
  const { width, height } = display;
  const hdcScreen = l.fns.GetDC(0);
  if (!hdcScreen) throw new CuaError('E_INTERNAL', '截图失败：拿不到屏幕 DC');
  let hdcMem = 0;
  let hbmp = 0;
  let old = 0;
  try {
    hdcMem = l.fns.CreateCompatibleDC(hdcScreen);
    hbmp = l.fns.CreateCompatibleBitmap(hdcScreen, width, height);
    if (!hdcMem || !hbmp) throw new CuaError('E_INTERNAL', '截图失败：创建位图失败');
    old = l.fns.SelectObject(hdcMem, hbmp);
    const SRCCOPY = 0x00cc0020;
    const CAPTUREBLT = 0x40000000;
    const ok = l.fns.BitBlt(hdcMem, 0, 0, width, height, hdcScreen, display.x, display.y, SRCCOPY | CAPTUREBLT);
    if (!ok) throw new CuaError('E_INTERNAL', '截图失败：BitBlt 返回 0');
    const buf = Buffer.alloc(width * height * 4);
    const bmi = Buffer.alloc(44);
    bmi.writeUInt32LE(40, 0); // biSize
    bmi.writeInt32LE(width, 4); // biWidth
    bmi.writeInt32LE(-height, 8); // 负高度 = top-down
    bmi.writeUInt16LE(1, 12); // biPlanes
    bmi.writeUInt16LE(32, 14); // biBitCount
    bmi.writeUInt32LE(0, 16); // BI_RGB
    l.fns.GetDIBits(hdcMem, hbmp, 0, height, buf, bmi, 0);
    return { bgra: buf, width, height };
  } finally {
    if (old) l.fns.SelectObject(hdcMem, old);
    if (hbmp) l.fns.DeleteObject(hbmp);
    if (hdcMem) l.fns.DeleteDC(hdcMem);
    l.fns.ReleaseDC(0, hdcScreen);
  }
}

// ---------------------------------------------------------------- 输入

interface InputEvent {
  type: number;
  u: Record<string, unknown>;
}

let lastInjectAt = 0;
let lastInjectedCursor: CursorPoint = { x: -100000, y: -100000 };
let lastUserInputAt = 0;
const heldKeys = new Set<number>();
const heldButtons = new Set<'left' | 'right' | 'middle'>();

function sendInputs(events: InputEvent[]): void {
  if (events.length === 0) return;
  const l = load();
  const size = 40;
  const sent = l.fns.SendInput(events.length, events, size);
  if (sent !== events.length) throw new CuaError('E_INTERNAL', `SendInput 只发出 ${sent}/${events.length} 个事件`);
  lastInjectAt = Date.now();
}

function mouseEvent(dx: number, dy: number, data: number, flags: number): InputEvent {
  return { type: 0, u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function keyEvent(vk: number, flags: number): InputEvent {
  return { type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function unicodeEvent(unit: number, flags: number): InputEvent {
  return { type: 1, u: { ki: { wVk: 0, wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

export function moveMouse(x: number, y: number): void {
  const vs = virtualScreen();
  const nx = Math.round(((x - vs.left) * 65535) / Math.max(1, vs.width - 1));
  const ny = Math.round(((y - vs.top) * 65535) / Math.max(1, vs.height - 1));
  sendInputs([mouseEvent(nx, ny, 0, MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK)]);
  try {
    load().fns.SetCursorPos(Math.round(x), Math.round(y));
  } catch {
    /* 忽略 */
  }
  lastInjectedCursor = { x, y };
}

const BUTTON_FLAGS: Record<'left' | 'right' | 'middle', { down: number; up: number }> = {
  left: { down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP },
  right: { down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP },
  middle: { down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP },
};

export function mouseDown(x: number, y: number, button: 'left' | 'right' | 'middle'): void {
  moveMouse(x, y);
  sendInputs([mouseEvent(0, 0, 0, BUTTON_FLAGS[button].down)]);
  heldButtons.add(button);
}

export function mouseUp(button: 'left' | 'right' | 'middle'): void {
  const c = cursorPos();
  sendInputs([mouseEvent(0, 0, 0, BUTTON_FLAGS[button].up)]);
  heldButtons.delete(button);
  lastInjectedCursor = c;
}

export function clickAt(x: number, y: number, button: 'left' | 'right' | 'middle', count: number): void {
  moveMouse(x, y);
  const evs: InputEvent[] = [];
  for (let i = 0; i < count; i++) {
    evs.push(mouseEvent(0, 0, 0, BUTTON_FLAGS[button].down));
    evs.push(mouseEvent(0, 0, 0, BUTTON_FLAGS[button].up));
  }
  sendInputs(evs);
}

export function scrollAt(x: number, y: number, down: number, right: number): void {
  moveMouse(x, y);
  const evs: InputEvent[] = [];
  if (down !== 0) evs.push(mouseEvent(0, 0, (down * 120) >>> 0, MOUSEEVENTF.WHEEL));
  if (right !== 0) evs.push(mouseEvent(0, 0, (right * 120) >>> 0, MOUSEEVENTF.HWHEEL));
  sendInputs(evs);
}

export function keyChord(vks: number[]): void {
  const evs: InputEvent[] = [];
  for (const vk of vks) evs.push(keyEvent(vk, 0));
  for (let i = vks.length - 1; i >= 0; i--) evs.push(keyEvent(vks[i]!, KEYEVENTF.KEYUP));
  sendInputs(evs);
}

export function keyDown(vk: number): void {
  sendInputs([keyEvent(vk, 0)]);
  heldKeys.add(vk);
}

export function keyUp(vk: number): void {
  sendInputs([keyEvent(vk, KEYEVENTF.KEYUP)]);
  heldKeys.delete(vk);
}

/** 把一段文本按 UTF-16 code unit 用 KEYEVENTF_UNICODE 发出去（一次最多 400 个单位）。 */
export function sendUnicodeText(text: string, from: number): number {
  const evs: InputEvent[] = [];
  let i = from;
  let count = 0;
  while (i < text.length && count < 400) {
    const unit = text.charCodeAt(i);
    evs.push(unicodeEvent(unit, KEYEVENTF.UNICODE));
    evs.push(unicodeEvent(unit, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
    i += 1;
    count += 1;
  }
  sendInputs(evs);
  return i;
}

export function releaseAll(): void {
  const evs: InputEvent[] = [];
  for (const vk of heldKeys) evs.push(keyEvent(vk, KEYEVENTF.KEYUP));
  for (const b of heldButtons) evs.push(mouseEvent(0, 0, 0, BUTTON_FLAGS[b].up));
  heldKeys.clear();
  heldButtons.clear();
  try {
    sendInputs(evs);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 用户活动

export interface ActivitySample {
  /** 用户离开鼠标键盘的毫秒数（扣掉我们自己的注入） */
  idleMs: number;
  cursor: CursorPoint;
}

export function sampleActivity(): ActivitySample {
  const l = load();
  const now = Date.now();
  const cursor = cursorPos();
  let apiIdle = 0;
  try {
    const lii = Buffer.alloc(8);
    lii.writeUInt32LE(8, 0);
    if (l.fns.GetLastInputInfo(lii)) {
      const tick = l.fns.GetTickCount() >>> 0;
      const last = lii.readUInt32LE(4) >>> 0;
      apiIdle = (tick - last) >>> 0;
      if (apiIdle > 0x7fffffff) apiIdle = 0;
    }
  } catch {
    apiIdle = 0;
  }
  if (lastUserInputAt === 0) lastUserInputAt = now - apiIdle;
  const sinceInject = lastInjectAt === 0 ? Number.MAX_SAFE_INTEGER : now - lastInjectAt;
  const moved = Math.abs(cursor.x - lastInjectedCursor.x) > 2 || Math.abs(cursor.y - lastInjectedCursor.y) > 2;
  const apiSaysUserRecent = apiIdle < sinceInject - 80;
  if (moved || apiSaysUserRecent) lastUserInputAt = now;
  const idleMs = Math.max(0, now - lastUserInputAt);
  return { idleMs, cursor };
}

export function lastInjectionAt(): number {
  return lastInjectAt;
}

export function markInjection(): void {
  lastInjectAt = Date.now();
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
