/**
 * 聊天服务：会话 + 历史 + 人格 + LLM 调用。
 *
 * 职责边界：
 *   - 这一层不懂 WebSocket/HTTP，方法层（gateway/methods/chat.ts）只做参数校验与转发；
 *   - 历史裁剪在这里做（maxHistoryMessages/maxHistoryChars），不把压力丢给模型；
 *   - 事件通过注入的 publish 广播（petd 里接 Gateway.publish，测试里接 EventBus.emit），UI 订阅 chat.* 即可，不需要轮询。
 */
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import type { CompleteOptions, LlmMessage, LlmReply } from '../llm/client.js';
import { clampTitle, DEFAULT_TITLE } from './store.js';
import type { ChatStore, Session, SessionMeta, StoredMessage } from './store.js';

export interface ChatServiceOptions {
  store: ChatStore;
  llm: { complete(opts: CompleteOptions): Promise<LlmReply> };
  chat: PetdConfig['chat'];
  /** 事件出口（petd 接 Gateway.publish → WS 广播；测试接 EventBus.emit） */
  publish: (event: string, data?: unknown) => void;
  /** 每次调用时读当前 SOUL.md（用户手改了也能立刻生效，不重启） */
  systemPrompt: () => string;
  logger?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
  now?: () => string;
}

export interface ChatSendInput {
  sessionId?: string;
  text: string;
  signal?: AbortSignal;
  /** 测试/内部调用可覆盖 */
  maxTokens?: number;
  temperature?: number;
}

export interface ChatSendResult {
  session: SessionMeta;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  reply: LlmReply;
}

export class ChatService {
  private readonly store: ChatStore;
  private readonly llm: ChatServiceOptions['llm'];
  private readonly chat: PetdConfig['chat'];
  private readonly publish: (event: string, data?: unknown) => void;
  private readonly systemPrompt: () => string;
  private readonly logger?: ChatServiceOptions['logger'];
  private readonly now: () => string;

  constructor(opts: ChatServiceOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.chat = opts.chat;
    this.publish = opts.publish;
    this.systemPrompt = opts.systemPrompt;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  listSessions(): SessionMeta[] {
    return this.store.list();
  }

  createSession(title?: string): SessionMeta {
    const meta = this.store.create(title);
    this.publish('session.updated', { sessionId: meta.id, title: meta.title, messageCount: 0, updatedAt: meta.updatedAt });
    return meta;
  }

  getSession(id: string): Session {
    const session = this.store.get(id);
    if (!session) throw new PetdError('E_NOT_FOUND', `会话不存在：${id}`);
    return session;
  }

  renameSession(id: string, title: string): SessionMeta {
    const meta = this.store.rename(id, title);
    if (!meta) throw new PetdError('E_NOT_FOUND', `会话不存在：${id}`);
    this.publish('session.updated', { sessionId: meta.id, title: meta.title, messageCount: meta.messageCount, updatedAt: meta.updatedAt });
    return meta;
  }

  deleteSession(id: string): void {
    if (!this.store.remove(id)) throw new PetdError('E_NOT_FOUND', `会话不存在：${id}`);
    this.publish('session.deleted', { sessionId: id });
  }

  async send(input: ChatSendInput): Promise<ChatSendResult> {
    const text = (input.text ?? '').trim();
    if (!text) throw new PetdError('E_BAD_PARAMS', '消息内容不能为空');
    if (text.length > 8000) throw new PetdError('E_BAD_PARAMS', '消息太长（上限 8000 字）');

    let meta: SessionMeta;
    if (input.sessionId) {
      const session = this.store.get(input.sessionId);
      if (!session) throw new PetdError('E_NOT_FOUND', `会话不存在：${input.sessionId}`);
      meta = session;
    } else {
      meta = this.createSession(clampTitle(text));
    }

    const history = this.store.get(meta.id)?.messages ?? [];
    const userMessage: StoredMessage = { role: 'user', content: text, ts: this.now() };
    this.publish('chat.user_message', { sessionId: meta.id, message: userMessage });

    const messages: LlmMessage[] = [{ role: 'system', content: this.systemPrompt() }];
    for (const m of this.pickHistory(history)) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: text });

    let reply: LlmReply;
    try {
      reply = await this.llm.complete({
        messages,
        signal: input.signal,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      });
    } catch (e) {
      this.publish('chat.failed', { sessionId: meta.id, code: (e as { code?: string }).code ?? 'E_INTERNAL', message: (e as Error).message });
      throw e;
    }

    const assistantMessage: StoredMessage = { role: 'assistant', content: reply.text, ts: this.now() };
    const updated = this.store.append(meta.id, [userMessage, assistantMessage]);
    if (!updated) throw new PetdError('E_NOT_FOUND', `会话不存在：${meta.id}`);

    // 首轮自动标题：用第一条用户消息
    let finalMeta = updated;
    if (history.length === 0 && (updated.title === DEFAULT_TITLE || updated.title === clampTitle(text))) {
      const renamed = this.store.rename(meta.id, clampTitle(text));
      if (renamed) finalMeta = renamed;
    }

    this.publish('chat.assistant_message', { sessionId: meta.id, message: assistantMessage, usage: reply.usage, model: reply.model });
    this.publish('session.updated', {
      sessionId: finalMeta.id,
      title: finalMeta.title,
      messageCount: finalMeta.messageCount,
      updatedAt: finalMeta.updatedAt,
    });
    this.logger?.info('聊天一轮完成', {
      sessionId: meta.id,
      promptTokens: reply.usage.promptTokens,
      completionTokens: reply.usage.completionTokens,
      replyChars: reply.text.length,
    });
    return { session: finalMeta, userMessage, assistantMessage, reply };
  }

  /** 从旧到新取，满足条数且总字符不超预算；开头若是 assistant 丢掉（让历史以 user 开头更稳） */
  private pickHistory(history: StoredMessage[]): StoredMessage[] {
    const picked: StoredMessage[] = [];
    let chars = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i];
      if (!m) continue;
      if (picked.length >= this.chat.maxHistoryMessages) break;
      if (chars + m.content.length > this.chat.maxHistoryChars && picked.length > 0) break;
      picked.unshift(m);
      chars += m.content.length;
    }
    while (picked.length && picked[0]?.role === 'assistant') picked.shift();
    return picked;
  }
}
