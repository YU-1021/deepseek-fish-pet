/** 聊天里的电脑操作工具（CUA）：截图/看窗口/动鼠标键盘。 */
import type { LlmToolDefinition } from '../llm/client.js';
import type { CuaEngine } from '../cua/engine.js';

export interface CuaToolResult {
  ok: boolean;
  text: string;
  /** 需要作为图片发给模型的截图（base64，JPEG） */
  images?: Array<{ mime: string; data: string }>;
}

const BUTTON_SCHEMA = {
  type: 'string',
  enum: ['left', 'right', 'middle'],
  description: '鼠标键：left（默认）/right/middle',
} as const;

export const CUA_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'cua_screenshot',
      description:
        '截屏（只拍一个显示器并缩放）。所有鼠标/键盘工具用的 x/y 都是这张截图的像素坐标；先截图再动手。',
      parameters: {
        type: 'object',
        properties: {
          display: { type: 'integer', minimum: 0, maximum: 15, description: '显示器编号（从 0 开始，默认前台窗口所在屏）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_zoom',
      description: '放大看最新截图中的一块区域，用来读小字或确认按钮位置。坐标和宽高都用截图像素。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: '区域左上角 x（截图像素）' },
          y: { type: 'integer', description: '区域左上角 y（截图像素）' },
          width: { type: 'integer', minimum: 8, description: '区域宽（截图像素）' },
          height: { type: 'integer', minimum: 8, description: '区域高（截图像素）' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_windows',
      description: '列出当前可见窗口（句柄、标题、程序名、是否前台、是否最小化、位置）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_focus',
      description: '把某个窗口切到前台。按句柄或标题片段找窗口。',
      parameters: {
        type: 'object',
        properties: { window: { type: 'string', minLength: 1, maxLength: 300, description: '窗口句柄或标题片段' } },
        required: ['window'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_click',
      description: '在截图坐标 (x, y) 点击。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          button: BUTTON_SCHEMA,
          clicks: { type: 'integer', minimum: 1, maximum: 3, description: '连击次数（默认 1）' },
          screenshot: { type: 'boolean', description: '动作后是否再截一张图（默认跟随配置）' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_move',
      description: '把鼠标移到截图坐标 (x, y)。',
      parameters: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_drag',
      description: '按住左键从一点拖到另一点（坐标都是截图像素）。',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'integer' },
          from_y: { type: 'integer' },
          to_x: { type: 'integer' },
          to_y: { type: 'integer' },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_mouse_down',
      description: '按住鼠标键（不给坐标就按在当前位置）。',
      parameters: {
        type: 'object',
        properties: { x: { type: 'integer' }, y: { type: 'integer' }, button: BUTTON_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_mouse_up',
      description: '松开鼠标键。',
      parameters: { type: 'object', properties: { button: BUTTON_SCHEMA } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_scroll',
      description: '在截图坐标处滚动：down 正数向下、right 正数向右（单位是格）。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          down: { type: 'integer', minimum: -30, maximum: 30 },
          right: { type: 'integer', minimum: -30, maximum: 30 },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_type',
      description: '在当前焦点处输入文字（中文/英文都行；\\n 表示回车）。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_key',
      description: '按键/组合键：如 "ctrl+s"、"win+r"、"esc"。hold=true 表示按住单键一段时间。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string', minLength: 1, maxLength: 200 },
          hold: { type: 'boolean', description: '是否按住不放（只有单键能用）' },
          hold_ms: { type: 'integer', minimum: 50, maximum: 30000 },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cua_wait',
      description: '等界面变化（0–30 秒），然后按权限截一张图。',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', minimum: 0, maximum: 30 } },
        required: ['seconds'],
      },
    },
  },
];

function imagesOf(shot: { jpeg?: Buffer } | undefined): Array<{ mime: string; data: string }> | undefined {
  if (!shot?.jpeg) return undefined;
  return [{ mime: 'image/jpeg', data: shot.jpeg.toString('base64') }];
}

function numArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`);
  return v;
}

function optNumArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`);
  return v;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

function buttonArg(args: Record<string, unknown>): 'left' | 'right' | 'middle' | undefined {
  const v = args['button'];
  if (v === undefined) return undefined;
  if (v === 'left' || v === 'right' || v === 'middle') return v;
  throw new Error('参数 button 只能是 left/right/middle');
}

export async function executeCuaTool(
  cua: CuaEngine,
  name: string,
  args: Record<string, unknown>,
  opts: { includeImages: boolean; signal?: AbortSignal }
): Promise<CuaToolResult> {
  const signal = opts.signal;
  switch (name) {
    case 'cua_screenshot': {
      const display = optNumArg(args, 'display');
      const res = await cua.screenshot({ ...(display === undefined ? {} : { display }), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_zoom': {
      const res = await cua.zoom({
        x: numArg(args, 'x'),
        y: numArg(args, 'y'),
        width: numArg(args, 'width'),
        height: numArg(args, 'height'),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_windows': {
      const res = await cua.windows({ ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text };
    }
    case 'cua_focus': {
      const res = await cua.focus({ window: strArg(args, 'window'), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_click': {
      const button = buttonArg(args);
      const clicks = optNumArg(args, 'clicks');
      const shot = args['screenshot'];
      const res = await cua.click({
        x: numArg(args, 'x'),
        y: numArg(args, 'y'),
        ...(button === undefined ? {} : { button }),
        ...(clicks === undefined ? {} : { clicks }),
        ...(typeof shot === 'boolean' ? { screenshot: shot } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_move': {
      const res = await cua.move({ x: numArg(args, 'x'), y: numArg(args, 'y'), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_drag': {
      const res = await cua.drag({
        from: { x: numArg(args, 'from_x'), y: numArg(args, 'from_y') },
        to: { x: numArg(args, 'to_x'), y: numArg(args, 'to_y') },
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_mouse_down': {
      const x = optNumArg(args, 'x');
      const y = optNumArg(args, 'y');
      const button = buttonArg(args);
      const res = await cua.mouseDown({
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        ...(button === undefined ? {} : { button }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_mouse_up': {
      const button = buttonArg(args);
      const res = await cua.mouseUp({ ...(button === undefined ? {} : { button }), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_scroll': {
      const down = optNumArg(args, 'down');
      const right = optNumArg(args, 'right');
      const res = await cua.scroll({
        x: numArg(args, 'x'),
        y: numArg(args, 'y'),
        ...(down === undefined ? {} : { down }),
        ...(right === undefined ? {} : { right }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_type': {
      const res = await cua.type({ text: strArg(args, 'text'), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_key': {
      const hold = args['hold'];
      const holdMs = optNumArg(args, 'hold_ms');
      const res = await cua.key({
        keys: strArg(args, 'keys'),
        ...(typeof hold === 'boolean' ? { hold } : {}),
        ...(holdMs === undefined ? {} : { holdMs }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    case 'cua_wait': {
      const res = await cua.wait({ seconds: numArg(args, 'seconds'), ...(signal === undefined ? {} : { signal }) });
      return { ok: res.ok, text: res.text, ...(opts.includeImages ? { images: imagesOf(res.screenshot) } : {}) };
    }
    default:
      throw new Error(`没有这个电脑操作工具（${name}）`);
  }
}

export const CUA_TOOL_NAMES: ReadonlySet<string> = new Set(CUA_TOOLS.map((t) => t.function.name));
