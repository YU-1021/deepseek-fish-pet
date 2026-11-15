/**
 * 记忆相关方法：memory.*。
 *
 * 参数校验由 registry（dispatch 前）统一做；这里只做业务转发。
 * 写路径约定：写/追加/删除/移动成功后都会产生一次 Git 提交（见 MemoryService）。
 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { MemoryService } from '../../memory/service.js';

const Entry = Type.Object({
  name: Type.String(),
  path: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('dir')]),
  size: Type.Integer(),
  mtimeMs: Type.Number(),
});

const Commit = Type.Object({
  hash: Type.String(),
  fullHash: Type.String(),
  author: Type.String(),
  email: Type.String(),
  date: Type.String(),
  message: Type.String(),
});

const WriteResult = Type.Object({
  path: Type.String(),
  bytes: Type.Integer(),
  /** 写完后内容的版本号（下次保存时作为 baseRevision 传回） */
  revision: Type.String(),
  commit: Type.Union([Type.String(), Type.Null()]),
});

const BaseRevision = Type.Optional(Type.String({ maxLength: 100 }));

export interface MemoryMethodDeps {
  memory: MemoryService;
}

export function registerMemoryMethods(reg: MethodRegistry, deps: MemoryMethodDeps): void {
  reg.register(
    {
      name: 'memory.status',
      scope: 'read',
      description: '工作区位置、文件数、Git 状态（可用/是否建仓/是否脏/最新提交/tags）',
      params: Type.Object({}),
      result: Type.Object({
        dir: Type.String(),
        fileCount: Type.Integer(),
        git: Type.Object({
          available: Type.Boolean(),
          repo: Type.Boolean(),
          dirty: Type.Boolean(),
          head: Type.Union([Type.String(), Type.Null()]),
          lastCommit: Type.Union([Commit, Type.Null()]),
          tags: Type.Array(Type.String()),
          initError: Type.Union([Type.String(), Type.Null()]),
          commitError: Type.Union([Type.String(), Type.Null()]),
        }),
      }),
    },
    () => deps.memory.status()
  );

  reg.register(
    {
      name: 'memory.tree',
      scope: 'read',
      description: '工作区目录树',
      params: Type.Object({}),
      result: Type.Object({ tree: Type.String() }),
    },
    () => ({ tree: deps.memory.tree() })
  );

  reg.register(
    {
      name: 'memory.list',
      scope: 'read',
      description: '列出工作区某目录（dir 为空表示根目录）',
      params: Type.Object({ dir: Type.Optional(Type.String({ maxLength: 400 })) }),
      result: Type.Object({ dir: Type.String(), entries: Type.Array(Entry) }),
    },
    (params) => {
      const p = params as { dir?: string } | undefined;
      const dir = p?.dir ?? '';
      return { dir, entries: deps.memory.list(dir) };
    }
  );

  reg.register(
    {
      name: 'memory.read',
      scope: 'read',
      description: '读工作区里的一个文本文件（相对路径），返回内容与 revision 版本号',
      params: Type.Object({ path: Type.String({ minLength: 1, maxLength: 400 }) }),
      result: Type.Object({ path: Type.String(), content: Type.String(), revision: Type.String() }),
    },
    (params) => {
      const p = params as { path: string };
      return deps.memory.read(p.path);
    }
  );

  reg.register(
    {
      name: 'memory.write',
      scope: 'write',
      description: '写工作区文件（整份覆盖，自动建目录并提交一次 Git）；带 baseRevision 时做乐观并发冲突检测',
      params: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 400 }),
        content: Type.String({ maxLength: 200_000 }),
        baseRevision: BaseRevision,
      }),
      result: WriteResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string; content: string; baseRevision?: string };
      return deps.memory.write(p.path, p.content, p.baseRevision === undefined ? {} : { baseRevision: p.baseRevision });
    }
  );

  reg.register(
    {
      name: 'memory.append',
      scope: 'write',
      description: '追加到工作区文件末尾（文件不存在则创建；自动提交一次 Git）；带 baseRevision 时做乐观并发冲突检测',
      params: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 400 }),
        content: Type.String({ maxLength: 200_000 }),
        baseRevision: BaseRevision,
      }),
      result: WriteResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string; content: string; baseRevision?: string };
      return deps.memory.append(p.path, p.content, p.baseRevision === undefined ? {} : { baseRevision: p.baseRevision });
    }
  );

  reg.register(
    {
      name: 'memory.delete',
      scope: 'write',
      description: '删除工作区文件（常驻文件如 PARTNER.md 不允许删除）',
      params: Type.Object({ path: Type.String({ minLength: 1, maxLength: 400 }) }),
      result: Type.Object({ path: Type.String(), commit: Type.Union([Type.String(), Type.Null()]) }),
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string };
      return deps.memory.remove(p.path);
    }
  );

  reg.register(
    {
      name: 'memory.move',
      scope: 'write',
      description: '移动/改名工作区文件（目标已存在会报冲突；自动提交一次 Git）',
      params: Type.Object({ from: Type.String({ minLength: 1, maxLength: 400 }), to: Type.String({ minLength: 1, maxLength: 400 }) }),
      result: Type.Object({ from: Type.String(), to: Type.String(), commit: Type.Union([Type.String(), Type.Null()]) }),
      idempotent: false,
    },
    (params) => {
      const p = params as { from: string; to: string };
      return deps.memory.move(p.from, p.to);
    }
  );

  reg.register(
    {
      name: 'memory.glob',
      scope: 'read',
      description: '按 glob 模式找文件（如 *.md、partner/**/*.md），最近改过的在前',
      params: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 200 }), dir: Type.Optional(Type.String({ maxLength: 400 })) }),
      result: Type.Object({ files: Type.Array(Type.String()) }),
    },
    (params) => {
      const p = params as { pattern: string; dir?: string };
      return { files: deps.memory.glob(p.pattern, p.dir ?? '') };
    }
  );

  reg.register(
    {
      name: 'memory.grep',
      scope: 'read',
      description: '在工作区里按子串（或 regex=true 时按正则）检索文本，按行返回',
      params: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        path: Type.Optional(Type.String({ maxLength: 400 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        regex: Type.Optional(Type.Boolean()),
      }),
      result: Type.Object({ hits: Type.Array(Type.Object({ path: Type.String(), line: Type.Integer(), text: Type.String() })) }),
    },
    (params) => {
      const p = params as { query: string; path?: string; limit?: number; regex?: boolean };
      return {
        hits: deps.memory.grep(p.query, {
          ...(p.path === undefined ? {} : { path: p.path }),
          ...(p.limit === undefined ? {} : { limit: p.limit }),
          ...(p.regex === undefined ? {} : { regex: p.regex }),
        }),
      };
    }
  );

  reg.register(
    {
      name: 'memory.history',
      scope: 'read',
      description: '工作区的 Git 提交历史（可按文件路径过滤）',
      params: Type.Object({
        path: Type.Optional(Type.String({ maxLength: 400 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      result: Type.Object({ commits: Type.Array(Commit) }),
    },
    (params) => {
      const p = params as { path?: string; limit?: number } | undefined;
      return {
        commits: deps.memory.history({
          ...(p?.path === undefined ? {} : { path: p.path }),
          ...(p?.limit === undefined ? {} : { limit: p.limit }),
        }),
      };
    }
  );

  reg.register(
    {
      name: 'memory.diff',
      scope: 'read',
      description: '看某次提交的 diff（可只看某个文件）',
      params: Type.Object({ hash: Type.String({ minLength: 4, maxLength: 200 }), path: Type.Optional(Type.String({ maxLength: 400 })) }),
      result: Type.Object({ diff: Type.String() }),
    },
    (params) => {
      const p = params as { hash: string; path?: string };
      return { diff: deps.memory.diff(p.hash, { ...(p.path === undefined ? {} : { path: p.path }) }) };
    }
  );
}
