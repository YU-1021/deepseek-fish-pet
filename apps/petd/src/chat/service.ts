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
import type { CompleteOptions, LlmContentPart, LlmMessage, LlmReply } from '../llm/client.js';
import type { PauseGate } from '../kernel/pause.js';
import type { BlobMeta, BlobStore } from '../memory/blob.js';
import {
  buildHandoffSummaryPrompt,
  cleanHandoffSummary,
  estimateMessagesTokens,
  estimateTokens,
  handoffPath,
  renderHandoffNote,
  renderSummaryHandoffNote,
} from './handoff.js';
import { clampTitle, DEFAULT_TITLE } from './store.js';
import type { ChatStore, Session, SessionMeta, StoredMessage } from './store.js';
import type { MemoryToolbox } from './tools.js';
import type { SpeechResult, VoiceService } from '../voice/service.js';

/** 交接笔记的读写通道（petd 接工作区记忆；测试接内存 fake） */
export interface HandoffIo {
  readFile(relPath: string): string;
  writeFile(relPath: string, content: string): Promise<unknown>;
}

export interface ChatServiceOptions {
  store: ChatStore;
  llm: { complete(opts: CompleteOptions): Promise<LlmReply> };
  chat: PetdConfig['chat'];
  /** 事件出口（petd 接 Gateway.publish → WS 广播；测试接 EventBus.emit） */
  publish: (event: string, data?: unknown) => void;
  /** 每次调用时读当前 SOUL.md（用户手改了也能立刻生效，不重启） */
  systemPrompt: () => string;
  /** 每轮拼接的情绪状态文本（返回空串 = 不注入） */
  moodPrompt?: () => string;
  /** 每轮拼接的技能清单/常驻技能/插件提示词段（返回空串 = 不注入） */
  skillsPrompt?: () => string;
  /** 每轮拼接的电脑操作提示词段（返回空串 = 不注入） */
  cuaPrompt?: () => string;
  /** 运行暂停门：暂停时聊天直接拒绝，不再花 token */
  pauseGate?: PauseGate;
  /** 电脑操作引擎（本轮结束负责松开按住的键鼠） */
  cua?: { enabled: boolean; onTurnEnded(): void };
  /** 截图是否作为图片一并发给模型（config.cua.includeImages） */
  cuaIncludeImages?: boolean;
  /** 一轮聊天成功后的钩子（例如按互动微调情绪）；失败只记日志，不影响回复 */
  onTurnComplete?: (info: { sessionId: string; userText: string; assistantText: string }) => void | Promise<void>;
  /** 记忆工具工厂（每轮新建，写次数配额按轮重置）；不传 = 不启用工具 */
  toolbox?: () => MemoryToolbox;
  /** 交接笔记读写；不传 = 不做上下文交接 */
  handoffIo?: HandoffIo;
  /** 附件存储；不传 = 聊天不能带附件 */
  blobs?: BlobStore;
  /** 语音服务；不传 = 聊天不能朗读 */
  voice?: VoiceService;
  /** 是否默认朗读每条回复（config.voice.autoSpeak） */
  autoSpeak?: boolean;
  logger?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
  now?: () => string;
}

/** 一次上下文交接的结果（回给 UI 显示「它把更早的对话压缩了」） */
export interface HandoffActivity {
  /** 笔记在工作区的相对路径 */
  file: string;
  /** 被压进笔记的消息条数 */
  compressed: number;
  /** 仍保留在上下文里的最近消息条数 */
  kept: number;
  /** 交接前的上下文 token 估算 */
  tokensBefore: number;
  /** 交接后的上下文 token 估算 */
  tokensAfter: number;
  /** 笔记怎么来的：llm = 模型整理摘要；mechanical = 机械摘录（模型失败/关闭时兜底） */
  mode: 'llm' | 'mechanical';
}

export interface ChatSendInput {
  sessionId?: string;
  text: string;
  /** 附件引用（句柄 `blob:x.png` 或 `blobs/x.png`），最多 10 个 */
  attachments?: string[];
  signal?: AbortSignal;
  /** 本次是否把回复读出来（不传 = 取 config.voice.autoSpeak） */
  speak?: boolean;
  /** 测试/内部调用可覆盖 */
  maxTokens?: number;
  temperature?: number;
}

/** 本轮带的附件（回给 UI 显示;也用于拼进模型输入） */
export type ChatAttachment = Pick<BlobMeta, 'handle' | 'name' | 'mime' | 'kind' | 'size'>;

/** 一次工具调用（回给 UI 显示「它刚才翻了记忆」） */
export interface ChatToolActivity {
  round: number;
  name: string;
  args: string;
  ok: boolean;
  text: string;
}

export interface ChatSendResult {
  session: SessionMeta;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  reply: LlmReply;
  /** 本轮模型用过的记忆工具（可能为空） */
  tools: ChatToolActivity[];
  /** 本轮是否带了附件 */
  attachments: ChatAttachment[];
  /** 本轮是否触发了上下文交接（没触发为 null） */
  handoff: HandoffActivity | null;
  /** 本轮语音（没朗读为 null；合成失败也只记日志，不影响聊天） */
  speech: SpeechResult | null;
}

export class ChatService {
  private readonly store: ChatStore;
  private readonly llm: ChatServiceOptions['llm'];
  private readonly chat: PetdConfig['chat'];
  private readonly publish: (event: string, data?: unknown) => void;
  private readonly systemPrompt: () => string;
  private readonly moodPrompt?: () => string;
  private readonly skillsPrompt?: () => string;
  private readonly cuaPrompt?: () => string;
  private readonly pauseGate?: PauseGate;
  private readonly cua?: { enabled: boolean; onTurnEnded(): void };
  private readonly cuaIncludeImages: boolean;
  private readonly onTurnComplete?: ChatServiceOptions['onTurnComplete'];
  private readonly toolbox?: () => MemoryToolbox;
  private readonly handoffIo?: HandoffIo;
  private readonly blobs?: BlobStore;
  private readonly voice?: VoiceService;
  private readonly autoSpeak: boolean;
  private readonly logger?: ChatServiceOptions['logger'];
  private readonly now: () => string;

  constructor(opts: ChatServiceOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.chat = opts.chat;
    this.publish = opts.publish;
    this.systemPrompt = opts.systemPrompt;
    this.moodPrompt = opts.moodPrompt;
    this.skillsPrompt = opts.skillsPrompt;
    this.cuaPrompt = opts.cuaPrompt;
    this.pauseGate = opts.pauseGate;
    this.cua = opts.cua;
    this.cuaIncludeImages = opts.cuaIncludeImages === true;
    this.onTurnComplete = opts.onTurnComplete;
    this.toolbox = opts.toolbox;
    this.handoffIo = opts.handoffIo;
    this.blobs = opts.blobs;
    this.voice = opts.voice;
    this.autoSpeak = opts.autoSpeak ?? false;
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

    // 用户点了「暂停」：不再花 token、不再动电脑
    if (this.pauseGate?.paused) {
      const status = this.pauseGate.status();
      throw new PetdError('E_UNAVAILABLE', `运行已暂停：${status.reason ?? '用户暂停了运行'}（先继续再聊）`);
    }

    // 附件：只校验存在性并取元数据；正文不变，附件句柄作为额外提示拼进这一轮的用户消息
    const attachments = this.resolveAttachments(input.attachments ?? []);
    const attachmentBlock = this.buildAttachmentBlock(attachments);

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
    this.publish('chat.user_message', { sessionId: meta.id, message: userMessage, attachments });

    const promptText = text + attachmentBlock;
    const systemPrompt = this.composeSystemPrompt();
    let handoff: HandoffActivity | null = null;
    let note = '';
    try {
      const created = await this.maybeHandoff(meta, history, promptText, systemPrompt, input.signal);
      if (created) {
        handoff = created.activity;
        note = created.note;
      } else {
        note = this.readLatestNote(meta);
      }
    } catch (e) {
      this.logger?.warn('上下文交接失败，继续用原历史', { sessionId: meta.id, error: (e as Error).message });
    }

    const fresh = this.store.get(meta.id) ?? meta;
    const active = history.slice(fresh.contextStart ?? 0);
    const messages: LlmMessage[] = [{ role: 'system', content: note ? systemPrompt + '\n\n' + note : systemPrompt }];
    for (const m of this.pickHistory(active)) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: promptText });

    const toolbox = this.chat.maxToolRounds > 0 && this.toolbox ? this.toolbox() : null;
    const toolDefs = toolbox ? toolbox.definitions() : undefined;
    const tools: ChatToolActivity[] = [];
    let reply: LlmReply | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    try {
      for (let round = 0; round <= this.chat.maxToolRounds; round += 1) {
        if (this.pauseGate?.paused) {
          const status = this.pauseGate.status();
          throw new PetdError('E_UNAVAILABLE', `运行已暂停：${status.reason ?? '用户暂停了运行'}`);
        }
        const r = await this.llm.complete({
          messages,
          ...(toolDefs === undefined ? {} : { tools: toolDefs }),
          signal: input.signal,
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        });
        promptTokens += r.usage.promptTokens ?? 0;
        completionTokens += r.usage.completionTokens ?? 0;
        totalTokens += r.usage.totalTokens ?? 0;

        if (!r.toolCalls || r.toolCalls.length === 0) {
          reply = r;
          break;
        }
        if (round >= this.chat.maxToolRounds) break; // 轮数用完了，不再继续调工具
        messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls });
        for (const call of r.toolCalls) {
          const res = await toolbox!.execute(call, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
          const activity: ChatToolActivity = { round: round + 1, name: call.name, args: call.arguments, ok: res.ok, text: res.text };
          tools.push(activity);
          this.publish('chat.tool', {
            sessionId: meta.id,
            round: activity.round,
            name: activity.name,
            ok: activity.ok,
            args: call.arguments.slice(0, 300),
            preview: res.text.slice(0, 800),
          });
          messages.push({ role: 'tool', content: res.text, toolCallId: call.id });
          if (res.images !== undefined && res.images.length > 0 && this.cuaIncludeImages) {
            const parts: LlmContentPart[] = [{ type: 'text', text: `[${call.name} 的截图]` }];
            for (const img of res.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
            messages.push({ role: 'user', content: parts });
          }
        }
      }
    } catch (e) {
      this.cua?.onTurnEnded();
      this.publish('chat.failed', { sessionId: meta.id, code: (e as { code?: string }).code ?? 'E_INTERNAL', message: (e as Error).message });
      throw e;
    }

    if (!reply) {
      this.publish('chat.failed', { sessionId: meta.id, code: 'E_LLM_EMPTY', message: '模型只调用了记忆工具，没有给出回复' });
      throw new PetdError('E_LLM_EMPTY', '模型只调用了记忆工具但没有给出回复（工具轮数已用完），再说一次试试');
    }
    const usage = reply.usage;
    const mergedReply: LlmReply = {
      ...reply,
      usage: {
        ...(usage.promptTokens === undefined && promptTokens === 0 ? {} : { promptTokens: promptTokens || usage.promptTokens }),
        ...(usage.completionTokens === undefined && completionTokens === 0 ? {} : { completionTokens: completionTokens || usage.completionTokens }),
        ...(usage.totalTokens === undefined && totalTokens === 0 ? {} : { totalTokens: totalTokens || usage.totalTokens }),
      },
    };

    const assistantMessage: StoredMessage = { role: 'assistant', content: mergedReply.text, ts: this.now() };
    const updated = this.store.append(meta.id, [userMessage, assistantMessage]);
    if (!updated) throw new PetdError('E_NOT_FOUND', `会话不存在：${meta.id}`);

    // 首轮自动标题：用第一条用户消息
    let finalMeta = updated;
    if (history.length === 0 && (updated.title === DEFAULT_TITLE || updated.title === clampTitle(text))) {
      const renamed = this.store.rename(meta.id, clampTitle(text));
      if (renamed) finalMeta = renamed;
    }

    // 记录本轮 prompt token 估算（只做观测；交接判断用 estimate，不依赖模型返回）
    const withTokens = this.store.update(meta.id, { lastPromptTokens: mergedReply.usage.promptTokens ?? this.estimatePromptTokens(messages) });
    if (withTokens) finalMeta = withTokens;

    this.publish('chat.assistant_message', { sessionId: meta.id, message: assistantMessage, usage: mergedReply.usage, model: mergedReply.model });
    this.publish('session.updated', {
      sessionId: finalMeta.id,
      title: finalMeta.title,
      messageCount: finalMeta.messageCount,
      updatedAt: finalMeta.updatedAt,
    });

    // 一轮完成后的钩子（按互动微调情绪）；失败只记日志，不影响本轮回复
    if (this.onTurnComplete) {
      try {
        await this.onTurnComplete({ sessionId: meta.id, userText: text, assistantText: assistantMessage.content });
      } catch (e) {
        this.logger?.warn('聊天完成钩子失败（不影响本轮回复）', { sessionId: meta.id, error: (e as Error).message });
      }
    }

    // 朗读：默认取 config.voice.autoSpeak；合成失败只记日志，不影响这轮聊天
    let speech: SpeechResult | null = null;
    const shouldSpeak = input.speak ?? this.autoSpeak;
    if (shouldSpeak && this.voice) {
      try {
        speech = await this.voice.speak(assistantMessage.content);
      } catch (e) {
        this.logger?.warn('语音合成失败（不影响本轮回复）', { sessionId: meta.id, error: (e as Error).message });
      }
    }

    this.cua?.onTurnEnded();

    this.logger?.info('聊天一轮完成', {
      sessionId: meta.id,
      promptTokens: mergedReply.usage.promptTokens,
      completionTokens: mergedReply.usage.completionTokens,
      replyChars: mergedReply.text.length,
      toolCalls: tools.length,
      speech: speech === null ? 'none' : speech.engine,
    });
    return { session: finalMeta, userMessage, assistantMessage, reply: mergedReply, tools, attachments, handoff, speech };
  }

  /** 系统提示词 = 人格 + 记忆前缀（调用方拼好） + 当前情绪行为指导 + 技能/插件段 */
  private composeSystemPrompt(): string {
    const base = this.systemPrompt();
    const extras: string[] = [];
    for (const provider of [this.moodPrompt, this.skillsPrompt, this.cuaPrompt]) {
      if (!provider) continue;
      try {
        const text = provider();
        if (text.trim().length > 0) extras.push(text.trim());
      } catch {
        /* 提示词拼接失败不影响聊天 */
      }
    }
    return extras.length > 0 ? `${base}\n\n${extras.join('\n\n')}` : base;
  }

  /** 校验附件引用并取元数据：不存在的直接报错，不让模型瞎猜 */
  private resolveAttachments(refs: string[]): ChatAttachment[] {
    if (refs.length === 0) return [];
    if (refs.length > 10) throw new PetdError('E_BAD_PARAMS', '一次最多带 10 个附件');
    if (!this.blobs) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用附件存储');
    return refs.map((ref) => {
      const meta = this.blobs!.resolve(ref);
      return { handle: meta.handle, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size };
    });
  }

  /** 附件信息拼进用户消息（只在这一轮生效，不写进会话正文） */
  private buildAttachmentBlock(attachments: ChatAttachment[]): string {
    if (attachments.length === 0) return '';
    const lines = attachments.map((a) => `- 句柄 ${a.handle}（${a.name}，${a.mime}，${a.size} 字节）`);
    return `\n\n[用户发来的附件]\n${lines.join('\n')}\n提示：文本附件可用 read_blob 读；图片/音频等二进制只能看到元数据。`;
  }

  /**
   * 手动交接：立刻把更早的对话压成笔记（保留最近 2 条），不管是否超阈值。
   * 用于 UI 的「整理上下文」按钮，或对话超长前的主动整理。
   */
  async handoff(sessionId: string): Promise<HandoffActivity> {
    const session = this.getSession(sessionId);
    const contextStart = session.contextStart ?? 0;
    const active = session.messages.slice(contextStart);
    if (active.length < 3) throw new PetdError('E_BAD_PARAMS', '消息太少，不需要交接');
    const keep = Math.max(1, Math.min(2, active.length - 1));
    const olderCount = active.length - keep;
    const result = await this.performHandoff(session, active, olderCount, '', this.composeSystemPrompt(), true);
    if (!result) throw new PetdError('E_INTERNAL', '交接失败');
    return result.activity;
  }

  /** 超过软阈值时自动交接；返回 null = 没触发 */
  private async maybeHandoff(
    meta: SessionMeta,
    history: StoredMessage[],
    incomingText: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<{ activity: HandoffActivity; note: string } | null> {
    const io = this.handoffIo;
    if (!io || this.chat.contextMaxTokens <= 0) return null;
    const contextStart = meta.contextStart ?? 0;
    const active = history.slice(contextStart);
    if (active.length < 6) return null;
    const projected =
      estimateTokens(systemPrompt) + estimateMessagesTokens(active) + estimateTokens(incomingText) + 8;
    const soft = this.chat.contextMaxTokens * this.chat.softRatio;
    if (projected <= soft) return null;
    // 从最新往前累计，保留 keepRatio 预算内的最近消息（至少 2 条，且至少压掉 2 条）
    const keepBudget = Math.floor(this.chat.contextMaxTokens * this.chat.keepRatio);
    let keepFrom = active.length;
    let acc = 0;
    for (let i = active.length - 1; i >= 0; i -= 1) {
      acc += estimateTokens(active[i]!.content) + 8;
      keepFrom = i;
      if (acc > keepBudget) break;
    }
    keepFrom = Math.max(keepFrom, 2);
    keepFrom = Math.min(keepFrom, active.length - 2);
    if (keepFrom <= 0) return null;
    return this.performHandoff(meta, active, keepFrom, incomingText, systemPrompt, false, signal);
  }

  private async performHandoff(
    meta: SessionMeta,
    active: StoredMessage[],
    olderCount: number,
    incomingText: string,
    systemPrompt: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<{ activity: HandoffActivity; note: string } | null> {
    const io = this.handoffIo;
    if (!io) throw new PetdError('E_UNAVAILABLE', '没有配置交接笔记存储');
    const older = active.slice(0, olderCount);
    if (older.length === 0) throw new PetdError('E_BAD_PARAMS', '没有可压缩的消息');
    let rendered = renderHandoffNote({
      messages: older,
      maxChars: this.chat.handoffNoteMaxChars,
      sessionTitle: meta.title,
    });
    let mode: HandoffActivity['mode'] = 'mechanical';
    if (this.chat.handoffUseLlm) {
      try {
        const prompt = buildHandoffSummaryPrompt({
          messages: older,
          sessionTitle: meta.title,
          maxChars: Math.min(this.chat.handoffNoteMaxChars, this.chat.handoffSummaryTokens * 3),
        });
        const summarized = await this.llm.complete({
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0.2,
          maxTokens: this.chat.handoffSummaryTokens,
          ...(signal ? { signal } : {}),
        });
        const summary = cleanHandoffSummary(summarized.text);
        if (summary) {
          rendered = renderSummaryHandoffNote({
            summary,
            messages: older,
            sessionTitle: meta.title,
            compressed: older.length,
            kept: active.length - older.length,
          });
          mode = 'llm';
        } else {
          this.logger?.warn('交接摘要太短，回退机械摘录', { sessionId: meta.id, rawChars: summarized.text.length });
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        this.logger?.warn('交接摘要生成失败，回退机械摘录', { sessionId: meta.id, error: (e as Error).message });
      }
    }
    const file = handoffPath(this.chat.handoffDir, new Date(this.now()));
    const kept = active.slice(older.length);
    const note = '## 上下文交接笔记（更早的对话已压缩到工作区 `' + file + '`）\n\n' + rendered.content;
    const tokensBefore =
      estimateTokens(systemPrompt) + estimateMessagesTokens(active) + estimateTokens(incomingText) + 8;
    const tokensAfter =
      estimateTokens(systemPrompt) + estimateTokens(note) + estimateMessagesTokens(kept) + estimateTokens(incomingText) + 8;
    // 收益检查：笔记本身有头部开销，消息太少/太短时可能反而更长——自动交接就跳过（手动的照做）
    if (!force && tokensAfter >= tokensBefore) {
      this.logger?.warn('交接没有减少上下文，跳过', { sessionId: meta.id, tokensBefore, tokensAfter, compressed: older.length });
      return null;
    }
    await io.writeFile(file, rendered.content);
    const contextStart = (meta.contextStart ?? 0) + older.length;
    const handoffFiles = [file, ...(meta.handoffFiles ?? [])].slice(0, 3);
    this.store.update(meta.id, { contextStart, handoffFiles });
    const activity: HandoffActivity = { file, compressed: older.length, kept: kept.length, tokensBefore, tokensAfter, mode };
    this.publish('chat.handoff', { sessionId: meta.id, ...activity });
    this.logger?.info('上下文交接完成', { sessionId: meta.id, file, mode, compressed: older.length, kept: kept.length, tokensBefore, tokensAfter });
    return { activity, note };
  }

  /** 后续轮次：从工作区读回最近一篇交接笔记，拼进 system 段 */
  private readLatestNote(meta: SessionMeta): string {
    const io = this.handoffIo;
    const file = meta.handoffFiles?.[0];
    if (!io || !file) return '';
    try {
      const text = io.readFile(file);
      return '## 上下文交接笔记（更早的对话已压缩到工作区 `' + file + '`）\n\n' + text.slice(0, this.chat.handoffNoteMaxChars);
    } catch {
      return '';
    }
  }

  private estimatePromptTokens(messages: Array<{ content: string | LlmContentPart[] }>): number {
    return estimateMessagesTokens(messages);
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
