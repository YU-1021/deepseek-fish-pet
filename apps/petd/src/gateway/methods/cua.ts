/** 电脑操作方法：cua.*（感知 + 输入 + 权限回答）。 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { CuaEngine } from '../../cua/engine.js';

const DisplaySchema = Type.Object({
  index: Type.Integer(),
  primary: Type.Boolean(),
  width: Type.Integer(),
  height: Type.Integer(),
  x: Type.Integer(),
  y: Type.Integer(),
  dpi: Type.Integer(),
});

const ForegroundSchema = Type.Object({
  hwnd: Type.Integer(),
  title: Type.String(),
  app: Type.String(),
  displayIndex: Type.Integer(),
});

const WindowSchema = Type.Object({
  handle: Type.String(),
  hwnd: Type.Integer(),
  title: Type.String(),
  app: Type.String(),
  foreground: Type.Boolean(),
  displayIndex: Type.Integer(),
  minimized: Type.Boolean(),
  rect: Type.Object({ left: Type.Integer(), top: Type.Integer(), right: Type.Integer(), bottom: Type.Integer() }),
});

const ScreenshotResultSchema = Type.Object({
  text: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  displayIndex: Type.Integer(),
  scale: Type.Number(),
  cursor: Type.Object({ x: Type.Integer(), y: Type.Integer() }),
  cursorText: Type.String(),
  foreground: ForegroundSchema,
  /** 是否附了 JPEG base64（cua.screenshot 的 includeImage=true 时） */
  imageBase64: Type.Optional(Type.String()),
});

const ActionResultSchema = Type.Object({
  ok: Type.Boolean(),
  text: Type.String(),
  screenshot: Type.Optional(ScreenshotResultSchema),
});

export interface CuaMethodDeps {
  cua: CuaEngine;
  /** 回答一次权限请求；返回是否找到对应请求 */
  answerPermission: (id: string, accepted: boolean) => boolean;
}

export function registerCuaMethods(reg: MethodRegistry, deps: CuaMethodDeps): void {
  reg.register(
    {
      name: 'cua.status',
      scope: 'read',
      description: '电脑操作状态：开关/只读/权限档位/授权到期/暂停/显示器/前台窗口/用户闲置',
      params: Type.Object({}),
      result: Type.Object({
        enabled: Type.Boolean(),
        control: Type.Boolean(),
        permission: Type.String(),
        grantedUntil: Type.Integer(),
        terminalGrantedUntil: Type.Integer(),
        paused: Type.Boolean(),
        engine: Type.String(),
        idleMs: Type.Integer(),
        foreground: Type.Union([ForegroundSchema, Type.Null()]),
        displays: Type.Array(DisplaySchema),
      }),
    },
    () => deps.cua.status()
  );

  const shotResult = async (r: { text: string; screenshot: { jpeg: Buffer; width: number; height: number; displayIndex: number; scale: number; cursor: { x: number; y: number }; cursorText: string; foreground: { hwnd: number } } }, includeImage: boolean) => ({
    text: r.text,
    width: r.screenshot.width,
    height: r.screenshot.height,
    displayIndex: r.screenshot.displayIndex,
    scale: r.screenshot.scale,
    cursor: r.screenshot.cursor,
    cursorText: r.screenshot.cursorText,
    foreground: (r.screenshot.foreground as unknown) as { hwnd: number; title: string; app: string; displayIndex: number },
    ...(includeImage ? { imageBase64: r.screenshot.jpeg.toString('base64') } : {}),
  });

  reg.register(
    {
      name: 'cua.screenshot',
      scope: 'write',
      description: '截屏（单显示器、缩放后 JPEG）：拿最新坐标；includeImage=true 时返回 base64 图片',
      params: Type.Object({
        display: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
        includeImage: Type.Optional(Type.Boolean()),
      }),
      result: ScreenshotResultSchema,
      timeoutMs: 30_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { display?: number; includeImage?: boolean };
      const r = await deps.cua.screenshot({ ...(p.display === undefined ? {} : { display: p.display }) });
      return shotResult(r, p.includeImage === true);
    }
  );

  reg.register(
    {
      name: 'cua.zoom',
      scope: 'write',
      description: '放大看最新截图中的一块区域（坐标与尺寸都用截图像素）',
      params: Type.Object({
        x: Type.Integer(),
        y: Type.Integer(),
        width: Type.Integer({ minimum: 8 }),
        height: Type.Integer({ minimum: 8 }),
        includeImage: Type.Optional(Type.Boolean()),
      }),
      result: ScreenshotResultSchema,
      timeoutMs: 30_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { x: number; y: number; width: number; height: number; includeImage?: boolean };
      const r = await deps.cua.zoom(p);
      return shotResult(r, p.includeImage === true);
    }
  );

  reg.register(
    {
      name: 'cua.windows',
      scope: 'read',
      description: '列出可见窗口（句柄/标题/进程/是否前台/是否最小化/位置）',
      params: Type.Object({}),
      result: Type.Object({ text: Type.String(), windows: Type.Array(WindowSchema) }),
      timeoutMs: 30_000,
    },
    async () => {
      const r = await deps.cua.windows();
      return { text: r.text, windows: r.entries };
    }
  );

  reg.register(
    {
      name: 'cua.focus',
      scope: 'write',
      description: '把某个窗口切到前台（按句柄或标题片段）',
      params: Type.Object({ window: Type.String({ minLength: 1, maxLength: 300 }) }),
      result: ActionResultSchema,
      timeoutMs: 30_000,
      idempotent: false,
    },
    async (params) => deps.cua.focus({ window: (params as { window: string }).window })
  );

  const pointParams = {
    x: Type.Integer(),
    y: Type.Integer(),
  };

  reg.register(
    {
      name: 'cua.click',
      scope: 'write',
      description: '点击截图坐标 (x, y)；button=left/right/middle，clicks 1–3',
      params: Type.Object({
        ...pointParams,
        button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
        clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
        screenshot: Type.Optional(Type.Boolean()),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number; screenshot?: boolean };
      return deps.cua.click({
        x: p.x,
        y: p.y,
        ...(p.button === undefined ? {} : { button: p.button }),
        ...(p.clicks === undefined ? {} : { clicks: p.clicks }),
        ...(p.screenshot === undefined ? {} : { screenshot: p.screenshot }),
      });
    }
  );

  reg.register(
    {
      name: 'cua.move',
      scope: 'write',
      description: '把鼠标移到截图坐标 (x, y)',
      params: Type.Object(pointParams),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => deps.cua.move(params as { x: number; y: number })
  );

  reg.register(
    {
      name: 'cua.drag',
      scope: 'write',
      description: '按住左键从 (fromX, fromY) 拖到 (toX, toY)（都是截图像素）',
      params: Type.Object({
        fromX: Type.Integer(),
        fromY: Type.Integer(),
        toX: Type.Integer(),
        toY: Type.Integer(),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { fromX: number; fromY: number; toX: number; toY: number };
      return deps.cua.drag({ from: { x: p.fromX, y: p.fromY }, to: { x: p.toX, y: p.toY } });
    }
  );

  reg.register(
    {
      name: 'cua.mouse_down',
      scope: 'write',
      description: '按住鼠标键（不给坐标就按在当前位置）',
      params: Type.Object({
        x: Type.Optional(Type.Integer()),
        y: Type.Optional(Type.Integer()),
        button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { x?: number; y?: number; button?: 'left' | 'right' | 'middle' };
      return deps.cua.mouseDown({
        ...(p.x === undefined ? {} : { x: p.x }),
        ...(p.y === undefined ? {} : { y: p.y }),
        ...(p.button === undefined ? {} : { button: p.button }),
      });
    }
  );

  reg.register(
    {
      name: 'cua.mouse_up',
      scope: 'write',
      description: '松开鼠标键',
      params: Type.Object({
        button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { button?: 'left' | 'right' | 'middle' };
      return deps.cua.mouseUp(p.button === undefined ? {} : { button: p.button });
    }
  );

  reg.register(
    {
      name: 'cua.scroll',
      scope: 'write',
      description: '在截图坐标处滚动：down 正数向下、right 正数向右（单位是"格"）',
      params: Type.Object({
        x: Type.Integer(),
        y: Type.Integer(),
        down: Type.Optional(Type.Integer({ minimum: -30, maximum: 30 })),
        right: Type.Optional(Type.Integer({ minimum: -30, maximum: 30 })),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { x: number; y: number; down?: number; right?: number };
      return deps.cua.scroll({
        x: p.x,
        y: p.y,
        ...(p.down === undefined ? {} : { down: p.down }),
        ...(p.right === undefined ? {} : { right: p.right }),
      });
    }
  );

  reg.register(
    {
      name: 'cua.type',
      scope: 'write',
      description: '在当前焦点处输入文字（中文/英文都行；\\n 表示回车）',
      params: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }),
      result: ActionResultSchema,
      timeoutMs: 120_000,
      idempotent: false,
    },
    async (params) => deps.cua.type({ text: (params as { text: string }).text })
  );

  reg.register(
    {
      name: 'cua.key',
      scope: 'write',
      description: '按键/组合键：如 "ctrl+s"、"win+r"、"esc"；hold=true 表示按住单键一段时间',
      params: Type.Object({
        keys: Type.String({ minLength: 1, maxLength: 200 }),
        hold: Type.Optional(Type.Boolean()),
        holdMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 30_000 })),
      }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { keys: string; hold?: boolean; holdMs?: number };
      return deps.cua.key({
        keys: p.keys,
        ...(p.hold === undefined ? {} : { hold: p.hold }),
        ...(p.holdMs === undefined ? {} : { holdMs: p.holdMs }),
      });
    }
  );

  reg.register(
    {
      name: 'cua.wait',
      scope: 'read',
      description: '等界面变化（0–30 秒），随后按权限截一张图',
      params: Type.Object({ seconds: Type.Number({ minimum: 0, maximum: 30 }) }),
      result: ActionResultSchema,
      timeoutMs: 60_000,
      idempotent: true,
    },
    async (params) => deps.cua.wait({ seconds: (params as { seconds: number }).seconds })
  );

  reg.register(
    {
      name: 'cua.answer',
      scope: 'write',
      description: '回答一次权限询问（UI 用）：accepted=true 允许 / false 拒绝',
      params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), accepted: Type.Boolean() }),
      result: Type.Object({ found: Type.Boolean() }),
      idempotent: true,
    },
    async (params) => {
      const p = params as { id: string; accepted: boolean };
      return { found: deps.answerPermission(p.id, p.accepted) };
    }
  );
}
