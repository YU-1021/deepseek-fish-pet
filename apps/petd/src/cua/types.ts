/** CUA（电脑操作）公共类型：感知与输入共用。 */
import { PetdError, type PetdErrorCode } from '@petd/protocol';

export type CuaPermission = 'ask-each-turn' | 'ask-before-acting' | 'ask-once' | 'never-ask';
export type MouseButton = 'left' | 'right' | 'middle';

export interface DisplayInfo {
  index: number;
  primary: boolean;
  /** 物理像素宽高 */
  width: number;
  height: number;
  /** 虚拟屏坐标 */
  x: number;
  y: number;
  dpi: number;
}

export interface CursorPoint {
  x: number;
  y: number;
}

export interface ForegroundInfo {
  hwnd: number;
  title: string;
  /** 进程可执行文件名（小写，不含路径） */
  app: string;
  displayIndex: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WindowEntry {
  handle: string;
  hwnd: number;
  title: string;
  app: string;
  foreground: boolean;
  displayIndex: number;
  minimized: boolean;
  rect: Rect;
}

export interface ScreenshotInfo {
  width: number;
  height: number;
  displayIndex: number;
  /** 截图像素 → 显示器物理像素的倍率（物理 = 截图 × scale） */
  scale: number;
  displays: DisplayInfo[];
  cursor: CursorPoint;
  cursorText: string;
  foreground: ForegroundInfo;
  jpeg: Buffer;
}

export interface YieldResult {
  yielded: boolean;
  waitedMs: number;
}

export interface CuaStatus {
  enabled: boolean;
  control: boolean;
  permission: CuaPermission;
  grantedUntil: number;
  terminalGrantedUntil: number;
  paused: boolean;
  engine: 'win32' | 'unsupported';
  idleMs: number;
  foreground: ForegroundInfo | null;
  displays: DisplayInfo[];
}

/** 询问用户：返回 true=允许，false=拒绝，null=超时/无人回答 */
export type AskPermission = (kind: 'see' | 'act', question: string) => Promise<boolean | null>;

/**
 * CUA 错误：继承 PetdError，这样网关 dispatch 能原样把 code/文案发给前端
 * （否则会被统一包成 E_INTERNAL「内部错误」）。
 */
export class CuaError extends PetdError {
  constructor(code: Extract<PetdErrorCode, 'E_UNAVAILABLE' | 'E_FORBIDDEN' | 'E_BAD_PARAMS' | 'E_INTERNAL'>, message: string) {
    super(code, message);
    this.name = 'CuaError';
  }
}
