/**
 * 聊天相关方法：session.* + chat.send。
 *
 * 参数校验由 registry（server dispatch 前）统一做，这里只做业务转发；
 * 结果 schema 声明出来主要给前端/工具自描述用。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { ChatService } from '../../chat/service.js';

const Message = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  content: Type.String(),
  ts: Type.String(),
});

const SessionMeta = Type.Object({
  id: Type.String(),
  title: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  messageCount: Type.Integer(),
  contextStart: Type.Optional(Type.Integer()),
  lastPromptTokens: Type.Optional(Type.Integer()),
  handoffFiles: Type.Optional(Type.Array(Type.String())),
});

const HandoffActivity = Type.Object({
  file: Type.String(),
  compressed: Type.Integer(),
  kept: Type.Integer(),
  tokensBefore: Type.Integer(),
  tokensAfter: Type.Integer(),
});

const Usage = Type.Object({
  promptTokens: Type.Optional(Type.Integer()),
  completionTokens: Type.Optional(Type.Integer()),
  totalTokens: Type.Optional(Type.Integer()),
});

const ToolActivity = Type.Object({
  round: Type.Integer(),
  name: Type.String(),
  args: Type.String(),
  ok: Type.Boolean(),
  text: Type.String(),
});

const Attachment = Type.Object({
  handle: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer(),
});

export interface ChatMethodDeps {
  chat: ChatService;
}

export function registerChatMethods(reg: MethodRegistry, deps: ChatMethodDeps): void {
  reg.register(
    {
      name: 'session.create',
      scope: 'write',
      description: '新建会话（可选标题），返回会话元数据',
      params: Type.Object({ title: Type.Optional(Type.String({ maxLength: 200 })) }),
      result: SessionMeta,
      idempotent: false,
    },
    (params) => {
      const p = params as { title?: string } | undefined;
      return deps.chat.createSession(p?.title);
    }
  );

  reg.register(
    {
      name: 'session.list',
      scope: 'read',
      description: '列出全部会话（按最近更新倒序）',
      params: Type.Object({}),
      result: Type.Object({ sessions: Type.Array(SessionMeta) }),
    },
    () => ({ sessions: deps.chat.listSessions() })
  );

  reg.register(
    {
      name: 'session.get',
      scope: 'read',
      description: '读取单个会话及全部消息',
      params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      result: Type.Object({ session: Type.Intersect([SessionMeta, Type.Object({ messages: Type.Array(Message) })]) }),
    },
    (params) => {
      const p = params as { sessionId: string };
      return { session: deps.chat.getSession(p.sessionId) };
    }
  );

  reg.register(
    {
      name: 'session.rename',
      scope: 'write',
      description: '重命名会话',
      params: Type.Object({ sessionId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1, maxLength: 200 }) }),
      result: SessionMeta,
      idempotent: false,
    },
    (params) => {
      const p = params as { sessionId: string; title: string };
      return deps.chat.renameSession(p.sessionId, p.title);
    }
  );

  reg.register(
    {
      name: 'session.delete',
      scope: 'write',
      description: '删除会话（消息文件一并删除）',
      params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      result: Type.Object({ deleted: Type.Boolean() }),
      idempotent: false,
    },
    (params) => {
      const p = params as { sessionId: string };
      try {
        deps.chat.deleteSession(p.sessionId);
        return { deleted: true };
      } catch (e) {
        if (e instanceof PetdError && e.code === 'E_NOT_FOUND') return { deleted: false };
        throw e;
      }
    }
  );

  reg.register(
    {
      name: 'chat.send',
      scope: 'write',
      description: '发一条消息：自动建会话、带人格与历史调模型、持久化用户与回复、广播 chat.* 事件',
      params: Type.Object({
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
        text: Type.String({ minLength: 1, maxLength: 8000 }),
        attachments: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 10 })),
      }),
      result: Type.Object({
        session: SessionMeta,
        userMessage: Message,
        assistantMessage: Message,
        reply: Type.Object({ text: Type.String(), model: Type.String(), usage: Usage, finishReason: Type.Optional(Type.String()) }),
        tools: Type.Array(ToolActivity),
        attachments: Type.Array(Attachment),
        handoff: Type.Union([HandoffActivity, Type.Null()]),
      }),
      timeoutMs: 120_000,
      idempotent: false,
    },
    async (params, ctx) => {
      const p = params as { sessionId?: string; text: string; attachments?: string[] };
      const result = await deps.chat.send({
        sessionId: p.sessionId,
        text: p.text,
        ...(p.attachments === undefined ? {} : { attachments: p.attachments }),
        signal: ctx.signal,
      });
      return {
        session: result.session,
        userMessage: result.userMessage,
        assistantMessage: result.assistantMessage,
        reply: {
          text: result.reply.text,
          model: result.reply.model,
          usage: result.reply.usage,
          ...(result.reply.finishReason === undefined ? {} : { finishReason: result.reply.finishReason }),
        },
        tools: result.tools,
        attachments: result.attachments,
        handoff: result.handoff,
      };
    }
  );

  reg.register(
    {
      name: 'chat.handoff',
      scope: 'write',
      description: '手动整理上下文：把更早的对话机械压缩成工作区 handoffs/ 里的交接笔记（保留最近 2 条）',
      params: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      result: HandoffActivity,
      timeoutMs: 30_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { sessionId: string };
      return deps.chat.handoff(p.sessionId);
    }
  );
}
