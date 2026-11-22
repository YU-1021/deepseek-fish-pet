/**
 * 记忆相关方法：memory.*。
 *
 * 参数校验由 registry（dispatch 前）统一做；这里只做业务转发。
 * 写路径约定：写/追加/删除/移动成功后都会产生一次 Git 提交（见 MemoryService）。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { MemoryService } from '../../memory/service.js';
import type { DistilledContext } from '../../memory/distill.js';
import type { MemoryDistiller } from '../../memory/distill-runner.js';

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

/** 完整 SHA-256（小写 hex，64 位）；pet-ui 编辑器保存时传当前基线正文的 hash。 */
const ExpectedHash = Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' }));

/** 用户在冲突提示里确认「覆盖」时为 true。 */
const Force = Type.Optional(Type.Boolean());

export interface MemoryMethodDeps {
  memory: MemoryService;
  /** 蒸馏记忆注入预览（pet-ui 调试/设置页用）；未接时 memory.inject 返回 E_UNAVAILABLE */
  inject?: () => DistilledContext;
  /** 自动蒸馏（把会话整理成摘要/日记/事实/经验）；未接时 memory.distill 返回 E_UNAVAILABLE */
  distill?: MemoryDistiller;
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
        /** 工作区绝对路径（pet-ui 主进程用它定位 blobs/ 下的附件真实文件） */
        workspace: Type.String(),
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
      description: '写工作区文件（整份覆盖，自动建目录并提交一次 Git）；带 baseRevision/expectedContentHash 时做乐观并发冲突检测，force=true 才允许覆盖',
      params: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 400 }),
        content: Type.String({ maxLength: 200_000 }),
        baseRevision: BaseRevision,
        expectedContentHash: ExpectedHash,
        force: Force,
      }),
      result: WriteResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string; content: string; baseRevision?: string; expectedContentHash?: string; force?: boolean };
      return deps.memory.write(p.path, p.content, {
        ...(p.baseRevision === undefined ? {} : { baseRevision: p.baseRevision }),
        ...(p.expectedContentHash === undefined ? {} : { expectedContentHash: p.expectedContentHash }),
        ...(p.force === undefined ? {} : { force: p.force }),
      });
    }
  );

  reg.register(
    {
      name: 'memory.append',
      scope: 'write',
      description: '追加到工作区文件末尾（文件不存在则创建；自动提交一次 Git）；带 baseRevision/expectedContentHash 时做乐观并发冲突检测',
      params: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 400 }),
        content: Type.String({ maxLength: 200_000 }),
        baseRevision: BaseRevision,
        expectedContentHash: ExpectedHash,
        force: Force,
      }),
      result: WriteResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string; content: string; baseRevision?: string; expectedContentHash?: string; force?: boolean };
      return deps.memory.append(p.path, p.content, {
        ...(p.baseRevision === undefined ? {} : { baseRevision: p.baseRevision }),
        ...(p.expectedContentHash === undefined ? {} : { expectedContentHash: p.expectedContentHash }),
        ...(p.force === undefined ? {} : { force: p.force }),
      });
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
      name: 'memory.restore',
      scope: 'write',
      description: '把某次提交里的文件内容恢复到工作区（生成一次新提交，不改写历史）；常驻文件只允许恢复正文',
      params: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 400 }),
        hash: Type.String({ minLength: 4, maxLength: 200 }),
        expectedContentHash: ExpectedHash,
        force: Force,
      }),
      result: WriteResult,
      idempotent: false,
    },
    (params) => {
      const p = params as { path: string; hash: string; expectedContentHash?: string; force?: boolean };
      return deps.memory.restore(p.path, p.hash, {
        ...(p.expectedContentHash === undefined ? {} : { expectedContentHash: p.expectedContentHash }),
        ...(p.force === undefined ? {} : { force: p.force }),
      });
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

  reg.register(
    {
      name: 'memory.inject',
      scope: 'read',
      description: '预览下一轮聊天会注入的蒸馏记忆（永久事实/日记/会话摘要），调试与设置页用',
      params: Type.Object({}),
      result: Type.Object({
        enabled: Type.Boolean(),
        text: Type.String(),
        used: Type.Object({ facts: Type.Integer(), diary: Type.Integer(), medium: Type.Integer() }),
        dropped: Type.Object({ facts: Type.Integer(), diary: Type.Integer(), medium: Type.Integer() }),
      }),
    },
    () => {
      if (deps.inject === undefined) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有接蒸馏记忆注入');
      return deps.inject();
    }
  );

  reg.register(
    {
      name: 'memory.distill',
      scope: 'write',
      description: '把一次会话蒸馏成摘要/日记/事实/经验（会花一次模型调用；默认取最近一次有消息的会话）',
      params: Type.Object({
        sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        reason: Type.Optional(Type.String({ maxLength: 80 })),
      }),
      result: Type.Object({
        ok: Type.Boolean(),
        reason: Type.String(),
        sessionId: Type.Optional(Type.String()),
        turns: Type.Integer(),
        skipped: Type.Optional(Type.Union([Type.Literal('too-short'), Type.Literal('empty')])),
        files: Type.Object({
          medium: Type.Optional(Type.Object({ path: Type.String(), commit: Type.Union([Type.String(), Type.Null()]) })),
          diary: Type.Optional(Type.Object({ path: Type.String(), commit: Type.Union([Type.String(), Type.Null()]) })),
          facts: Type.Optional(
            Type.Object({
              path: Type.String(),
              commit: Type.Union([Type.String(), Type.Null()]),
              added: Type.Integer(),
              merged: Type.Integer(),
            })
          ),
          experiences: Type.Optional(
            Type.Object({
              path: Type.String(),
              commit: Type.Union([Type.String(), Type.Null()]),
              added: Type.Integer(),
              merged: Type.Integer(),
            })
          ),
        }),
        usage: Type.Optional(
          Type.Object({ promptTokens: Type.Optional(Type.Integer()), completionTokens: Type.Optional(Type.Integer()) })
        ),
      }),
      timeoutMs: 120_000,
      idempotent: false,
    },
    async (params) => {
      if (deps.distill === undefined) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有接自动蒸馏');
      const p = (params ?? {}) as { sessionId?: string; reason?: string };
      return deps.distill.run({
        ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
        ...(p.reason === undefined ? {} : { reason: p.reason }),
      });
    }
  );
}
