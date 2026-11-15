/**
 * 插件管理：列出/查看/启用/停用声明式插件（home/plugins/<id>/plugin.json）。
 *
 * - 插件不执行任意 JS；启停只影响它贡献的「技能」与「prompt.md 提示词」是否生效。
 * - 启用状态存 home/state/plugins.json，重启后保留。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { PluginInfo, PluginStore } from '../../plugins/store.js';
import type { MethodRegistry } from '../registry.js';

export interface PluginMethodDeps {
  store: PluginStore;
  enabled: () => boolean;
}

const PluginSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  version: Type.String(),
  description: Type.String(),
  author: Type.Optional(Type.String()),
  dir: Type.String(),
  enabled: Type.Boolean(),
  skillCount: Type.Integer(),
  hasPrompt: Type.Boolean(),
});

function pluginOf(info: PluginInfo): unknown {
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    description: info.description,
    ...(info.author === undefined ? {} : { author: info.author }),
    dir: info.dir,
    enabled: info.enabled,
    skillCount: info.skillCount,
    hasPrompt: info.hasPrompt,
  };
}

function ensureEnabled(deps: PluginMethodDeps): void {
  if (!deps.enabled()) throw new PetdError('E_UNAVAILABLE', '插件功能已关闭（config.plugins.enabled=false）');
}

export function registerPluginMethods(reg: MethodRegistry, deps: PluginMethodDeps): void {
  reg.register(
    {
      name: 'plugin.list',
      scope: 'read',
      description: '列出已安装的插件（含是否启用、贡献几个技能、有无额外提示词）',
      result: Type.Object({ plugins: Type.Array(PluginSchema) }),
    },
    () => ({ plugins: deps.store.list().map(pluginOf) })
  );

  reg.register(
    {
      name: 'plugin.get',
      scope: 'read',
      description: '查看一个插件的清单与启用状态',
      params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
      result: PluginSchema,
    },
    (params) => {
      const p = params as { id: string };
      return pluginOf(deps.store.get(p.id));
    }
  );

  reg.register(
    {
      name: 'plugin.enable',
      scope: 'write',
      description: '启用插件（它的技能与提示词立即生效），状态持久化',
      params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
      result: PluginSchema,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return pluginOf(deps.store.enable(p.id));
    }
  );

  reg.register(
    {
      name: 'plugin.disable',
      scope: 'write',
      description: '停用插件（技能与提示词立即失效，文件保留），状态持久化',
      params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
      result: PluginSchema,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { id: string };
      return pluginOf(deps.store.disable(p.id));
    }
  );
}
