/**
 * game.* 方法：游戏助手（petd → 预习助手）的门面。
 *
 * 看屏：game.look（抓帧 + OCR，可顺带找字/模板）；game.find 找一段文字；game.template 模板匹配。
 * 点击：game.click —— 默认只返回计划（dry-run），真点要 config.game.allowClick=true 且 real:true。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { GameAssistant } from '../../game/assistant.js';

const JsonResult = Type.Record(Type.String(), Type.Unknown());

const StatusSchema = Type.Object({
  enabled: Type.Boolean(),
  assistantDir: Type.String(),
  bridgePath: Type.String(),
  nodePath: Type.String(),
  allowClick: Type.Boolean(),
  gameHint: Type.String(),
  counters: Type.Object({
    calls: Type.Integer(),
    ok: Type.Integer(),
    errors: Type.Integer(),
  }),
  lastError: Type.Union([Type.String(), Type.Null()]),
  lastCallAt: Type.Union([Type.Integer(), Type.Null()]),
});

export interface GameMethodDeps {
  game: GameAssistant;
}

export function registerGameMethods(reg: MethodRegistry, deps: GameMethodDeps): void {
  reg.register(
    {
      name: 'game.status',
      scope: 'read',
      description: '游戏助手状态：开关/预习助手目录/是否允许真点/调用计数',
      result: StatusSchema,
    },
    () => deps.game.status()
  );

  reg.register(
    {
      name: 'game.look',
      scope: 'read',
      description: '看当前游戏画面（MAA 抓帧 + OCR），可顺带找文字/模板；游戏必须在前台可见',
      params: Type.Object({
        find: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 })),
        template: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 })),
        ocrEngine: Type.Optional(Type.Union([Type.Literal('paddle'), Type.Literal('windows')])),
        textMax: Type.Optional(Type.Integer({ minimum: 200, maximum: 20_000 })),
      }),
      result: JsonResult,
      timeoutMs: 90_000,
      idempotent: false,
    },
    async (params) => {
      const p = (params ?? {}) as {
        find?: unknown;
        template?: unknown;
        ocrEngine?: unknown;
        textMax?: unknown;
      };
      return deps.game.look({
        find: Array.isArray(p.find) ? p.find.filter((x): x is string => typeof x === 'string') : undefined,
        template: Array.isArray(p.template) ? p.template.filter((x): x is string => typeof x === 'string') : undefined,
        ocrEngine: p.ocrEngine === 'windows' ? 'windows' : p.ocrEngine === 'paddle' ? 'paddle' : undefined,
        textMax: typeof p.textMax === 'number' ? p.textMax : undefined,
      });
    }
  );

  reg.register(
    {
      name: 'game.find',
      scope: 'read',
      description: '在游戏画面上找一段文字（模糊匹配），返回覆盖率和坐标，用于点按钮/干员前定位',
      params: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 200 }),
        minCoverage: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      }),
      result: JsonResult,
      timeoutMs: 90_000,
      idempotent: false,
    },
    async (params) => {
      const p = (params ?? {}) as { text?: unknown; minCoverage?: unknown };
      if (typeof p.text !== 'string') throw new PetdError('E_BAD_PARAMS', '缺少参数 text');
      return deps.game.find(p.text, typeof p.minCoverage === 'number' ? p.minCoverage : undefined);
    }
  );

  reg.register(
    {
      name: 'game.template',
      scope: 'read',
      description: '用 MAA 模板匹配画面元素（如 Return.png / PRTS1.png），返回分数与坐标',
      params: Type.Object({
        names: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20 }),
      }),
      result: JsonResult,
      timeoutMs: 90_000,
      idempotent: false,
    },
    async (params) => {
      const p = (params ?? {}) as { names?: unknown };
      if (!Array.isArray(p.names) || p.names.length === 0) throw new PetdError('E_BAD_PARAMS', '缺少参数 names');
      return deps.game.template(p.names.filter((x): x is string => typeof x === 'string'));
    }
  );

  reg.register(
    {
      name: 'game.click',
      scope: 'write',
      description:
        '点游戏里的坐标：默认只返回计划（dry-run）；真点需要主人打开 config.game.allowClick 且传 real:true',
      params: Type.Object({
        x: Type.Integer({ minimum: 0, maximum: 20_000 }),
        y: Type.Integer({ minimum: 0, maximum: 20_000 }),
        real: Type.Optional(Type.Boolean()),
      }),
      result: JsonResult,
      timeoutMs: 90_000,
      idempotent: false,
      dangerous: true,
    },
    async (params) => {
      const p = (params ?? {}) as { x?: unknown; y?: unknown; real?: unknown };
      if (typeof p.x !== 'number' || typeof p.y !== 'number') throw new PetdError('E_BAD_PARAMS', '缺少参数 x/y');
      return deps.game.click(p.x, p.y, { real: p.real === true });
    }
  );
}
