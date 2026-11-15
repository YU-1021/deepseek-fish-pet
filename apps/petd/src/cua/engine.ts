/**
 * CUA 引擎：感知（截图/窗口/前台）+ 输入（鼠标键盘）+ 授权/让位/打断/暂停门。
 *
 * 设计对齐 Coo 的 computer use（工具语义与安全模型），但 Win32 实现是自写的，
 * 不复制 Coo（AGPL）源码；v1 在 petd 进程内运行，后续可拆 engine 子进程做崩溃隔离。
 */
import type { PetdConfig } from '../kernel/config.js';
import { PauseGate } from '../kernel/pause.js';
import { PermissionBroker } from './permission.js';
import { downscale, drawCursor, encodeJpeg } from './image.js';
import { parseChords, parseHoldChord, KEY_HELP } from './keys.js';
import { CuaError } from './types.js';
import type {
  AskPermission,
  CuaPermission,
  CuaStatus,
  CursorPoint,
  DisplayInfo,
  ForegroundInfo,
  MouseButton,
  ScreenshotInfo,
  WindowEntry,
  YieldResult,
} from './types.js';
import * as win from './win32.js';

export interface CuaLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  debug?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface CuaDriver {
  platform: 'win32' | 'unsupported';
  listDisplays(): DisplayInfo[];
  cursorPos(): CursorPoint;
  foreground(displays: DisplayInfo[]): ForegroundInfo;
  capture(display: DisplayInfo): { bgra: Buffer; width: number; height: number };
  windows(): WindowEntry[];
  focus(hwnd: number): boolean;
  moveMouse(x: number, y: number): void;
  clickAt(x: number, y: number, button: MouseButton, count: number): void;
  mouseDown(x: number, y: number, button: MouseButton): void;
  mouseUp(button: MouseButton): void;
  scrollAt(x: number, y: number, down: number, right: number): void;
  keyChord(vks: number[]): void;
  keyDown(vk: number): void;
  keyUp(vk: number): void;
  sendUnicodeText(text: string, from: number): number;
  releaseAll(): void;
  sampleActivity(): { idleMs: number; cursor: CursorPoint };
}

export function win32Driver(): CuaDriver {
  return {
    platform: win.IS_WIN ? 'win32' : 'unsupported',
    listDisplays: () => win.listDisplays(),
    cursorPos: () => win.cursorPos(),
    foreground: (displays) => win.foregroundInfo(displays),
    capture: (display) => win.captureDisplay(display),
    windows: () => win.listWindows(),
    focus: (hwnd) => win.focusWindow(hwnd),
    moveMouse: (x, y) => win.moveMouse(x, y),
    clickAt: (x, y, button, count) => win.clickAt(x, y, button, count),
    mouseDown: (x, y, button) => win.mouseDown(x, y, button),
    mouseUp: (button) => win.mouseUp(button),
    scrollAt: (x, y, down, right) => win.scrollAt(x, y, down, right),
    keyChord: (vks) => win.keyChord(vks),
    keyDown: (vk) => win.keyDown(vk),
    keyUp: (vk) => win.keyUp(vk),
    sendUnicodeText: (text, from) => win.sendUnicodeText(text, from),
    releaseAll: () => win.releaseAll(),
    sampleActivity: () => win.sampleActivity(),
  };
}

const TERMINAL_APPS = new Set([
  'cmd.exe',
  'conhost.exe',
  'powershell.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'wt.exe',
  'bash.exe',
  'wsl.exe',
  'mintty.exe',
  'iterm2',
  'terminal',
  'gnome-terminal',
  'konsole',
]);

const TERMINAL_HINT = '当前前台是终端（命令窗口），在终端里执行操作风险更高。';

export interface CuaInputResult {
  ok: boolean;
  text: string;
  screenshot?: ScreenshotInfo;
}

export interface CuaShotResult {
  ok: boolean;
  text: string;
  screenshot: ScreenshotInfo;
}

interface View extends ScreenshotInfo {
  display: DisplayInfo;
}

export interface CuaEngineOptions {
  config: PetdConfig['cua'];
  driver?: CuaDriver;
  logger?: CuaLogger;
  ask?: AskPermission;
  pauseGate?: PauseGate;
  now?: () => number;
}

export class CuaEngine {
  private readonly driver: CuaDriver;
  private readonly now: () => number;
  private readonly pauseGate: PauseGate;
  private lastView: View | null = null;
  private grantedUntil = 0;
  private terminalGrantedUntil = 0;
  private seeAllowedThisTurn = false;
  private pausedFlag = false;

  constructor(private readonly options: CuaEngineOptions) {
    this.driver = options.driver ?? win32Driver();
    this.now = options.now ?? (() => Date.now());
    this.pauseGate = options.pauseGate ?? new PauseGate({ now: this.now });
    this.seeAllowedThisTurn = this.options.config.permission !== 'ask-each-turn';
    if (this.driver.platform !== 'win32') {
      this.options.logger?.warn('电脑操作不可用：当前系统不是 Windows');
    }
  }

  get enabled(): boolean {
    return this.options.config.enabled && this.driver.platform === 'win32';
  }

  get control(): boolean {
    return this.options.config.control;
  }

  get pause(): PauseGate {
    return this.pauseGate;
  }

  /** 本轮结束：松开所有按住的东西，清掉本轮授权缓存（授权时效仍保留）。 */
  onTurnEnded(): void {
    try {
      this.driver.releaseAll();
    } catch {
      /* 忽略 */
    }
    this.seeAllowedThisTurn = this.options.config.permission !== 'ask-each-turn';
  }

  status(): CuaStatus {
    let displays: DisplayInfo[] = [];
    let foreground: ForegroundInfo | null = null;
    let idleMs = -1;
    try {
      displays = this.driver.listDisplays();
      foreground = this.driver.foreground(displays);
      idleMs = this.driver.sampleActivity().idleMs;
    } catch {
      /* 引擎不可用 */
    }
    return {
      enabled: this.enabled,
      control: this.control,
      permission: this.options.config.permission,
      grantedUntil: this.grantedUntil,
      terminalGrantedUntil: this.terminalGrantedUntil,
      paused: this.pauseGate.paused,
      engine: this.driver.platform === 'win32' ? 'win32' : 'unsupported',
      idleMs,
      foreground,
      displays,
    };
  }

  // ------------------------------------------------------------ 感知

  async screenshot(opts: { display?: number; signal?: AbortSignal } = {}): Promise<CuaShotResult> {
    this.assertEnabled();
    this.assertActive();
    await this.permit('see', '看一下你的屏幕', opts.signal);
    const info = this.capture(opts.display);
    this.lastView = { ...info, display: info.displays[info.displayIndex]! };
    return { ok: true, text: this.describeShot(info), screenshot: info };
  }

  async zoom(opts: { x: number; y: number; width: number; height: number; signal?: AbortSignal }): Promise<CuaShotResult> {
    this.assertEnabled();
    this.assertActive();
    await this.permit('see', '放大看屏幕的一块区域', opts.signal);
    const view = this.requireView();
    const { x, y, width, height } = opts;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new CuaError('E_BAD_PARAMS', '区域坐标必须是数字');
    }
    if (x < 0 || y < 0 || width < 8 || height < 8 || x + width > view.width || y + height > view.height) {
      throw new CuaError('E_BAD_PARAMS', `区域超出截图范围（截图 ${view.width}×${view.height}）`);
    }
    const disp = view.display;
    const physX = Math.round(disp.x + x * view.scale);
    const physY = Math.round(disp.y + y * view.scale);
    const physW = Math.max(1, Math.round(width * view.scale));
    const physH = Math.max(1, Math.round(height * view.scale));
    const raw = this.driver.capture(disp);
    const cx0 = Math.max(0, Math.min(raw.width - 1, physX - disp.x));
    const cy0 = Math.max(0, Math.min(raw.height - 1, physY - disp.y));
    const cw = Math.max(1, Math.min(raw.width - cx0, physW));
    const chh = Math.max(1, Math.min(raw.height - cy0, physH));
    const cropped = Buffer.alloc(cw * chh * 4);
    for (let row = 0; row < chh; row++) {
      raw.bgra.copy(cropped, row * cw * 4, ((cy0 + row) * raw.width + cx0) * 4, ((cy0 + row) * raw.width + cx0 + cw) * 4);
    }
    const ds = downscale(cropped, cw, chh, this.options.config.screenshot.maxWidth, this.options.config.screenshot.maxHeight);
    const cursor = this.driver.cursorPos();
    const inside = cursor.x >= physX && cursor.x < physX + physW && cursor.y >= physY && cursor.y < physY + physH;
    if (inside) {
      drawCursor(ds.rgba, ds.width, ds.height, Math.round((cursor.x - physX) / ds.scale), Math.round((cursor.y - physY) / ds.scale));
    }
    const jpeg = encodeJpeg(ds.rgba, ds.width, ds.height, this.options.config.screenshot.quality);
    const info: ScreenshotInfo = {
      width: ds.width,
      height: ds.height,
      displayIndex: disp.index,
      scale: view.scale,
      displays: view.displays,
      cursor,
      cursorText: inside ? '在放大区域里' : '不在放大区域里',
      foreground: this.driver.foreground(view.displays),
      jpeg,
    };
    return { ok: true, text: `放大了截图区域 (${x}, ${y}) ${width}×${height} → 输出 ${ds.width}×${ds.height}。`, screenshot: info };
  }

  async windows(opts: { signal?: AbortSignal } = {}): Promise<{ ok: boolean; text: string; entries: WindowEntry[] }> {
    this.assertEnabled();
    this.assertActive();
    await this.permit('see', '看一下你开了哪些窗口', opts.signal);
    const entries = this.driver.windows();
    return { ok: true, text: this.describeWindows(entries), entries };
  }

  // ------------------------------------------------------------ 输入

  async move(opts: { x: number; y: number; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    await this.permit('act', `把鼠标移到 (${opts.x}, ${opts.y})`, opts.signal);
    const at = this.toScreen(opts.x, opts.y);
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    this.driver.moveMouse(at.x, at.y);
    this.markAction();
    return this.after(`鼠标已移到截图坐标 (${opts.x}, ${opts.y})`, {}, opts.signal);
  }

  async click(opts: { x: number; y: number; button?: MouseButton; clicks?: number; screenshot?: boolean; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const button = opts.button ?? 'left';
    const clicks = Math.max(1, Math.min(3, Math.round(opts.clicks ?? 1)));
    await this.permit('act', `点击屏幕 (${opts.x}, ${opts.y})（${button} 键）`, opts.signal);
    const at = this.toScreen(opts.x, opts.y);
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    this.driver.clickAt(at.x, at.y, button, clicks);
    this.markAction();
    return this.after(`已在 (${opts.x}, ${opts.y}) ${button === 'left' ? '左键' : button === 'right' ? '右键' : '中键'}点击${clicks > 1 ? ` ${clicks} 次` : ''}`, { screenshot: opts.screenshot }, opts.signal);
  }

  async drag(opts: { from: { x: number; y: number }; to: { x: number; y: number }; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    await this.permit('act', `把东西从 (${opts.from.x}, ${opts.from.y}) 拖到 (${opts.to.x}, ${opts.to.y})`, opts.signal);
    const a = this.toScreen(opts.from.x, opts.from.y);
    const b = this.toScreen(opts.to.x, opts.to.y);
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    this.driver.mouseDown(a.x, a.y, 'left');
    try {
      for (let i = 1; i <= 8; i++) {
        this.throwIfAborted(opts.signal);
        this.driver.moveMouse(a.x + Math.round(((b.x - a.x) * i) / 8), a.y + Math.round(((b.y - a.y) * i) / 8));
        await this.sleep(20, opts.signal);
      }
    } finally {
      this.driver.mouseUp('left');
    }
    this.markAction();
    return this.after(`已从 (${opts.from.x}, ${opts.from.y}) 拖到 (${opts.to.x}, ${opts.to.y})`, {}, opts.signal);
  }

  async mouseDown(opts: { x?: number; y?: number; button?: MouseButton; signal?: AbortSignal } = {}): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const button = opts.button ?? 'left';
    await this.permit('act', `按住的鼠标${button === 'left' ? '左' : button === 'right' ? '右' : '中'}键`, opts.signal);
    let x: number;
    let y: number;
    if (opts.x !== undefined && opts.y !== undefined) {
      const at = this.toScreen(opts.x, opts.y);
      x = at.x;
      y = at.y;
    } else {
      const c = this.driver.cursorPos();
      x = c.x;
      y = c.y;
    }
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    this.driver.mouseDown(x, y, button);
    this.markAction();
    return this.after(`已按住鼠标${button === 'left' ? '左' : button === 'right' ? '右' : '中'}键`, {}, opts.signal);
  }

  async mouseUp(opts: { button?: MouseButton; signal?: AbortSignal } = {}): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const button = opts.button ?? 'left';
    await this.permit('act', `松开鼠标${button === 'left' ? '左' : button === 'right' ? '右' : '中'}键`, opts.signal);
    this.driver.mouseUp(button);
    this.markAction();
    return this.after(`已松开鼠标${button === 'left' ? '左' : button === 'right' ? '右' : '中'}键`, {}, opts.signal);
  }

  async scroll(opts: { x: number; y: number; down?: number; right?: number; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const down = Math.max(-30, Math.min(30, Math.round(opts.down ?? 0)));
    const right = Math.max(-30, Math.min(30, Math.round(opts.right ?? 0)));
    if (down === 0 && right === 0) throw new CuaError('E_BAD_PARAMS', 'down 和 right 不能都是 0');
    await this.permit('act', `在 (${opts.x}, ${opts.y}) 滚动`, opts.signal);
    const at = this.toScreen(opts.x, opts.y);
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    this.driver.scrollAt(at.x, at.y, down, right);
    this.markAction();
    return this.after(`已在 (${opts.x}, ${opts.y}) 滚动${down ? ` ${down > 0 ? '向下' : '向上'} ${Math.abs(down)} 格` : ''}${right ? `，向右 ${right} 格` : ''}`, {}, opts.signal);
  }

  async type(opts: { text: string; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const text = String(opts.text ?? '');
    if (!text) throw new CuaError('E_BAD_PARAMS', 'text 不能为空');
    await this.permit('act', '在光标处输入文字', opts.signal);
    await this.guardTerminal(opts.signal, { text });
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    let typed = 0;
    let stopped = '';
    while (typed < text.length) {
      if (opts.signal?.aborted) {
        stopped = '（被中断，只输入了一部分）';
        break;
      }
      typed = this.driver.sendUnicodeText(text, typed);
      this.markAction();
      if (typed < text.length) await this.sleep(this.options.config.typeChunkDelayMs, opts.signal);
    }
    return this.after(`已在光标处输入 ${typed} 个字符${stopped}`, {}, opts.signal);
  }

  async key(opts: { keys: string; hold?: boolean; holdMs?: number; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    const keys = String(opts.keys ?? '').trim();
    if (!keys) throw new CuaError('E_BAD_PARAMS', 'keys 不能为空');
    let holdVk: number | null = null;
    let chordList: number[][] = [];
    if (opts.hold) {
      holdVk = parseHoldChord(keys);
    } else {
      chordList = parseChords(keys).chords;
    }
    await this.permit('act', `按 ${keys}`, opts.signal);
    await this.guardTerminal(opts.signal, { chords: holdVk ? [[holdVk]] : chordList });
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    if (holdVk !== null) {
      const holdMs = Math.max(50, Math.min(30_000, Math.round(opts.holdMs ?? 800)));
      this.driver.keyDown(holdVk);
      this.markAction();
      try {
        await this.sleep(holdMs, opts.signal);
      } finally {
        this.driver.keyUp(holdVk);
      }
      return this.after(`已按住 ${keys} ${holdMs}ms 再松开`, {}, opts.signal);
    }
    for (const chord of chordList) {
      this.throwIfAborted(opts.signal);
      this.driver.keyChord(chord);
      this.markAction();
      await this.sleep(60, opts.signal);
    }
    return this.after(`已按下 ${keys}`, {}, opts.signal);
  }

  async wait(opts: { seconds: number; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    const seconds = Math.max(0, Math.min(30, Number(opts.seconds ?? 1)));
    await this.sleep(seconds * 1000, opts.signal);
    if (this.mayLook()) {
      const shot = this.capture();
      this.lastView = { ...shot, display: shot.displays[shot.displayIndex]! };
      return { ok: true, text: `等了 ${seconds} 秒。\n${this.describeShot(shot)}`, screenshot: shot };
    }
    return { ok: true, text: `等了 ${seconds} 秒。` };
  }

  async focus(opts: { window: string; signal?: AbortSignal }): Promise<CuaInputResult> {
    this.assertEnabled();
    this.assertActive();
    this.assertControl();
    await this.permit('act', `把窗口切到前台：${opts.window}`, opts.signal);
    const wanted = String(opts.window ?? '').trim().toLowerCase();
    if (!wanted) throw new CuaError('E_BAD_PARAMS', 'window 不能为空');
    const entries = this.driver.windows();
    const target =
      entries.find((e) => e.handle.toLowerCase() === wanted) ??
      entries.find((e) => e.title.toLowerCase().includes(wanted)) ??
      entries.find((e) => e.handle.toLowerCase().includes(wanted));
    if (!target) return { ok: false, text: `没有找到标题/句柄包含「${opts.window}」的窗口。` };
    const yieldResult = await this.waitForIdle(opts.signal);
    if (yieldResult.yielded) return this.yieldedResult(yieldResult);
    const ok = this.driver.focus(target.hwnd);
    this.markAction();
    if (!ok) return { ok: false, text: `尝试切换窗口「${target.title}」但没有成功（可能被系统拦了）。` };
    return this.after(`已切到窗口「${target.title}」(${target.app})`, {}, opts.signal);
  }

  // ------------------------------------------------------------ 授权

  private async permit(kind: 'see' | 'act', question: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const permission = this.options.config.permission;
    const nowMs = this.now();
    if (kind === 'see') {
      if (permission !== 'ask-each-turn') return;
      if (this.seeAllowedThisTurn) return;
    } else {
      if (permission === 'never-ask') return;
      if (permission === 'ask-once' && this.grantedUntil > nowMs) return;
    }
    const ask = this.options.ask;
    if (!ask) throw new CuaError('E_FORBIDDEN', '没有可用的界面来询问权限，已拒绝（可把 cua.permission 设为 never-ask）');
    const accepted = await ask(kind, question);
    this.throwIfAborted(signal);
    if (accepted === null) throw new CuaError('E_FORBIDDEN', '等待授权超时或无人回答，这次没有操作');
    if (!accepted) throw new CuaError('E_FORBIDDEN', '用户拒绝了这次操作');
    if (kind === 'see') {
      this.seeAllowedThisTurn = true;
    } else if (permission === 'ask-once') {
      this.grantedUntil = nowMs + this.options.config.grantMinutes * 60_000;
    }
  }

  /** 终端保护：终端窗口/运行框里的输入，按档位单独问一次。 */
  private async guardTerminal(signal: AbortSignal | undefined, ctx: { text?: string; chords?: number[][] }): Promise<void> {
    if (this.options.config.skipTerminalAsk) return;
    const displays = this.driver.listDisplays();
    const fg = this.driver.foreground(displays);
    const terminal = TERMINAL_APPS.has(fg.app);
    const runBox = Boolean(ctx.chords?.some((chord) => chord.length === 2 && chord.includes(0x5b) && chord.includes(0x52)));
    if (!terminal && !runBox) return;
    if (this.terminalGrantedUntil > this.now()) return;
    const ask = this.options.ask;
    if (!ask) throw new CuaError('E_FORBIDDEN', '当前在终端里操作，需要授权但没有可用的界面');
    const detail = ctx.text !== undefined ? `要输入的文字：「${ctx.text.slice(0, 120)}」` : '要按的键';
    const accepted = await ask('act', `${TERMINAL_HINT}\n前台窗口：「${fg.title}」(${fg.app})\n${detail}\n允许吗？`);
    this.throwIfAborted(signal);
    if (accepted !== true) throw new CuaError('E_FORBIDDEN', '用户没有允许在终端里操作');
    this.terminalGrantedUntil = this.now() + this.options.config.grantMinutes * 60_000;
  }

  // ------------------------------------------------------------ 内部

  private assertEnabled(): void {
    if (!this.options.config.enabled) throw new CuaError('E_UNAVAILABLE', '电脑操作未开启（config.cua.enabled=false）');
    if (this.driver.platform !== 'win32') throw new CuaError('E_UNAVAILABLE', '当前系统不支持电脑操作（只支持 Windows）');
  }

  private assertActive(): void {
    if (this.pauseGate.paused) throw new CuaError('E_UNAVAILABLE', '已暂停运行（点继续后再操作）');
  }

  private assertControl(): void {
    if (!this.options.config.control) throw new CuaError('E_FORBIDDEN', '现在是只读模式（cua.control=false），只能看不能操作');
  }

  private requireView(): View {
    if (!this.lastView) throw new CuaError('E_BAD_PARAMS', '还没有截图，先调 cua.screenshot 拿坐标');
    return this.lastView;
  }

  private toScreen(x: unknown, y: unknown): { x: number; y: number } {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new CuaError('E_BAD_PARAMS', '坐标必须是数字');
    }
    const view = this.requireView();
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
      throw new CuaError('E_BAD_PARAMS', `坐标超出截图范围（0–${view.width - 1}, 0–${view.height - 1}），先用 cua.screenshot 重新截图`);
    }
    const disp = view.display;
    return {
      x: Math.max(disp.x, Math.min(disp.x + disp.width - 1, Math.round(disp.x + x * view.scale))),
      y: Math.max(disp.y, Math.min(disp.y + disp.height - 1, Math.round(disp.y + y * view.scale))),
    };
  }

  private capture(displayIndex?: number): ScreenshotInfo {
    const displays = this.driver.listDisplays();
    const fg = this.driver.foreground(displays);
    const index = typeof displayIndex === 'number' && displays[displayIndex] ? displayIndex : fg.displayIndex >= 0 ? fg.displayIndex : 0;
    const disp = displays[index] ?? displays[0]!;
    const cfg = this.options.config.screenshot;
    const raw = this.driver.capture(disp);
    const ds = downscale(raw.bgra, raw.width, raw.height, cfg.maxWidth, cfg.maxHeight);
    const cursor = this.driver.cursorPos();
    const inside = cursor.x >= disp.x && cursor.y >= disp.y && cursor.x < disp.x + disp.width && cursor.y < disp.y + disp.height;
    if (inside) {
      drawCursor(ds.rgba, ds.width, ds.height, Math.round((cursor.x - disp.x) / ds.scale), Math.round((cursor.y - disp.y) / ds.scale));
    }
    const jpeg = encodeJpeg(ds.rgba, ds.width, ds.height, cfg.quality);
    return {
      width: ds.width,
      height: ds.height,
      displayIndex: disp.index,
      scale: ds.scale,
      displays,
      cursor,
      cursorText: inside ? `截图坐标 (${Math.round((cursor.x - disp.x) / ds.scale)}, ${Math.round((cursor.y - disp.y) / ds.scale)})` : '不在当前截图的显示器上',
      foreground: fg,
      jpeg,
    };
  }

  private describeShot(info: ScreenshotInfo): string {
    const disp = info.displays[info.displayIndex] ?? info.displays[0]!;
    const list = info.displays.map((d) => `${d.index + 1}. ${d.width}×${d.height} @(${d.x}, ${d.y})${d.primary ? ' 主屏' : ''} dpi ${d.dpi}`).join('；');
    return [
      `屏幕截图：${info.width}×${info.height}（显示器 ${info.displayIndex + 1}，物理 ${disp.width}×${disp.height}，截图坐标 ×${info.scale.toFixed(2)} = 物理像素）`,
      `显示器：${list}`,
      `光标：${info.cursorText}`,
      `前台窗口：「${info.foreground.title || '(无标题)'}」(${info.foreground.app || '未知进程'})`,
      `坐标约定：所有工具坐标都用这张截图的像素，左上角 (0, 0)。`,
    ].join('\n');
  }

  private describeWindows(entries: WindowEntry[]): string {
    if (entries.length === 0) return '没有找到可见窗口。';
    const view = this.lastView;
    const lines = entries.map((e) => {
      const parts = [`[${e.handle}] 「${e.title}」(${e.app || '未知进程'})`];
      if (e.foreground) parts.push('前台');
      if (e.minimized) parts.push('最小化');
      if (e.displayIndex !== 0) parts.push(`在显示器 ${e.displayIndex + 1}`);
      if (view && view.display.index === e.displayIndex) {
        parts.push(
          `截图范围 (${Math.round((e.rect.left - view.display.x) / view.scale)}, ${Math.round((e.rect.top - view.display.y) / view.scale)})–(${Math.round((e.rect.right - view.display.x) / view.scale)}, ${Math.round((e.rect.bottom - view.display.y) / view.scale)})`,
        );
      }
      return `- ${parts.join(' ')}`;
    });
    return [`窗口（${entries.length} 个）：`, ...lines].join('\n');
  }

  private async after(receipt: string, args: { screenshot?: boolean }, signal?: AbortSignal): Promise<CuaInputResult> {
    await this.sleep(this.options.config.screenshot.settleMs, signal);
    this.throwIfAborted(signal);
    const want = args.screenshot ?? this.options.config.screenshot.afterAction;
    const displays = this.driver.listDisplays();
    const fg = this.driver.foreground(displays);
    if (!want) {
      return { ok: true, text: `${receipt}\n现在的窗口：「${fg.title || '(无标题)'}」(${fg.app || '?'})` };
    }
    const shot = this.capture(fg.displayIndex >= 0 ? fg.displayIndex : undefined);
    this.lastView = { ...shot, display: shot.displays[shot.displayIndex]! };
    return { ok: true, text: `${receipt}\n${this.describeShot(shot)}`, screenshot: shot };
  }

  private yieldedResult(y: YieldResult): CuaInputResult {
    return {
      ok: false,
      text: `用户正在用电脑（已经等了 ${Math.round(y.waitedMs / 1000)} 秒），这次没有操作。等用户停手后再试。`,
    };
  }

  private async waitForIdle(signal?: AbortSignal): Promise<YieldResult> {
    const started = this.now();
    const idleNeeded = this.options.config.userIdleMs;
    if (idleNeeded <= 0) return { yielded: false, waitedMs: 0 };
    for (;;) {
      this.throwIfAborted(signal);
      const { idleMs } = this.driver.sampleActivity();
      if (idleMs >= idleNeeded) return { yielded: false, waitedMs: this.now() - started };
      if (this.now() - started >= this.options.config.maxYieldWaitMs) return { yielded: true, waitedMs: this.now() - started };
      await this.sleep(100, signal);
    }
  }

  private mayLook(): boolean {
    return this.options.config.permission !== 'ask-each-turn' || this.seeAllowedThisTurn;
  }

  private markAction(): void {
    if (this.driver.platform === 'win32') {
      try {
        win.markInjection();
      } catch {
        /* 忽略 */
      }
    }
    this.options.logger?.debug?.('cua.action');
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new CuaError('E_INTERNAL', '操作被中断');
      err.name = 'AbortError';
      throw err;
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        const err = new CuaError('E_INTERNAL', '操作被中断');
        err.name = 'AbortError';
        reject(err);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export { PermissionBroker, KEY_HELP };
export type { CuaPermission };
