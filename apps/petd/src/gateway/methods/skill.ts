/**
 * 技能管理：列出/查看/新建/修改/删除工作区技能。
 *
 * - 技能就是 home/skills/<name>/SKILL.md（frontmatter + 正文），插件贡献的技能只读。
 * - 系统提示词里只有「清单 + 常驻技能正文」，模型要用哪个技能会先 load_skill 读正文。
 * - 关闭 skills.enabled 时读方法仍可用（方便 UI 展示），写方法返回 E_UNAVAILABLE。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { SkillInfo, SkillStore } from '../../skills/store.js';
import type { MethodRegistry } from '../registry.js';

export interface SkillMethodDeps {
  store: SkillStore;
  enabled: () => boolean;
}

const SkillSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  description: Type.String(),
  keywords: Type.Array(Type.String()),
  always: Type.Boolean(),
  source: Type.Union([Type.Literal('workspace'), Type.Literal('plugin')]),
  pluginId: Type.Optional(Type.String()),
  bodyChars: Type.Integer(),
  updatedAt: Type.String(),
});

const SkillContentSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  description: Type.String(),
  keywords: Type.Array(Type.String()),
  always: Type.Boolean(),
  source: Type.Union([Type.Literal('workspace'), Type.Literal('plugin')]),
  pluginId: Type.Optional(Type.String()),
  bodyChars: Type.Integer(),
  body: Type.String(),
  updatedAt: Type.String(),
});

function infoOf(info: SkillInfo): unknown {
  return {
    key: info.key,
    name: info.name,
    description: info.description,
    keywords: [...info.keywords],
    always: info.always,
    source: info.source,
    ...(info.pluginId === undefined ? {} : { pluginId: info.pluginId }),
    bodyChars: info.bodyChars,
    updatedAt: info.updatedAt,
  };
}

function ensureEnabled(deps: SkillMethodDeps): void {
  if (!deps.enabled()) throw new PetdError('E_UNAVAILABLE', '技能功能已关闭（config.skills.enabled=false）');
}

export function registerSkillMethods(reg: MethodRegistry, deps: SkillMethodDeps): void {
  reg.register(
    {
      name: 'skill.list',
      scope: 'read',
      description: '列出所有可用技能（工作区 + 启用插件贡献的）',
      result: Type.Object({ skills: Type.Array(SkillSchema) }),
    },
    () => ({ skills: deps.store.list().map(infoOf) })
  );

  reg.register(
    {
      name: 'skill.get',
      scope: 'read',
      description: '读取一个技能的完整正文（含 frontmatter 解析后的元信息）',
      params: Type.Object({ key: Type.String({ minLength: 1, maxLength: 80 }) }),
      result: SkillContentSchema,
    },
    (params) => {
      const p = params as { key: string };
      const skill = deps.store.get(p.key);
      return { ...(infoOf(skill) as Record<string, unknown>), body: skill.body };
    }
  );

  reg.register(
    {
      name: 'skill.create',
      scope: 'write',
      description: '新建工作区技能：name（字母数字-_）+ 正文，可选 description/keywords/always',
      params: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 64 }),
        description: Type.Optional(Type.String({ maxLength: 200 })),
        body: Type.String({ minLength: 1, maxLength: 20_000 }),
        keywords: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 8 })),
        always: Type.Optional(Type.Boolean()),
      }),
      result: SkillSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { name: string; description?: string; body: string; keywords?: string[]; always?: boolean };
      return infoOf(deps.store.create(p));
    }
  );

  reg.register(
    {
      name: 'skill.update',
      scope: 'write',
      description: '修改工作区技能（插件技能只读）：description/body/keywords/always 任选',
      params: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 64 }),
        description: Type.Optional(Type.String({ maxLength: 200 })),
        body: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        keywords: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 8 })),
        always: Type.Optional(Type.Boolean()),
      }),
      result: SkillSchema,
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as {
        name: string;
        description?: string;
        body?: string;
        keywords?: string[];
        always?: boolean;
      };
      return infoOf(deps.store.update(p.name, p));
    }
  );

  reg.register(
    {
      name: 'skill.delete',
      scope: 'write',
      description: '删除工作区技能（整个技能目录）；插件技能不能删',
      params: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }),
      result: Type.Object({ deleted: Type.Boolean(), key: Type.String() }),
      idempotent: false,
    },
    (params) => {
      ensureEnabled(deps);
      const p = params as { name: string };
      deps.store.remove(p.name);
      return { deleted: true, key: p.name };
    }
  );
}
