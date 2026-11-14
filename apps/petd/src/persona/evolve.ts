/**
 * 人格自演化：让模型根据「当前人格 + 最近经历」提议一次小额改动，落盘走 PersonaStore.patch(actor='agent')。
 *
 * 边界（和旧 app 的 evolvePersonaOnce 对齐）：
 *   - 只改未上锁、且属于 AI_EDITABLE_KEYS 的小节；世界观永远不动；
 *   - 没理由/没把握就 changed=false，宁可不动；
 *   - 模型输出必须是 JSON；解析失败只记日志、人格不变（不抛给聊天）；
 *   - 锁、版本、回滚全部由 PersonaStore 负责，这一层只负责「提议」。
 */
import { PetdError } from '@petd/protocol';
import type { LlmMessage } from '../llm/client.js';
import { AI_EDITABLE_KEYS, type PersonaSectionView, type PersonaSnapshot, type PersonaStore } from './store.js';

export interface EvolveMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface EvolveLlm {
  complete(opts: { messages: LlmMessage[]; signal?: AbortSignal; temperature?: number; maxTokens?: number }): Promise<{ text: string }>;
}

export interface EvolveLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface EvolveOptions {
  store: PersonaStore;
  llm: EvolveLlm;
  /** 取最近经历（对话摘录），从旧到新 */
  recentMessages: () => EvolveMessage[] | Promise<EvolveMessage[]>;
  /** 对话摘录总字符预算，默认 3000 */
  historyBudgetChars?: number;
  signal?: AbortSignal;
  logger?: EvolveLogger;
}

export interface EvolveResult {
  changed: boolean;
  reason: string;
  version: number;
  applied: string[];
  skipped: string[];
  rejected: Array<{ key: string; reason: string }>;
  /** 模型原始输出（截断，排障用；不含密钥） */
  raw?: string;
}

interface ParsedEvolve {
  changed: boolean;
  reason: string;
  sections: Record<string, string>;
}

function sectionStatus(s: PersonaSectionView): string {
  if (s.userOnly) return '[仅用户可改]';
  if (s.locked) return '[已上锁]';
  if (AI_EDITABLE_KEYS.includes(s.key)) return '[可改]';
  return '[不可改]';
}

function buildSystemPrompt(snap: PersonaSnapshot): string {
  const editable = snap.sections.filter((s) => AI_EDITABLE_KEYS.includes(s.key) && !s.locked && !s.userOnly);
  const sectionList = snap.sections.map((s) => `- ${s.key}（${s.heading}）${sectionStatus(s)}`).join('\n');
  return [
    `你是桌宠「${snap.title || '桌宠'}」的人格演化器，不是聊天对象。`,
    '任务：根据「当前人格」和「最近经历」，判断人格是否需要随时间自然演化（微调性格描述、口头禅、隐藏设定、说话方式）。',
    '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。',
    'JSON 格式：{"changed": true|false, "reason": "一句话原因", "sections": {"<key>": "<该小节完整新正文，不含 ## 标题>"}}',
    '规则：',
    `1. 只能使用标记为 [可改] 的 key：${editable.map((s) => s.key).join('、') || '（当前没有可改小节）'}`,
    '2. [已上锁]/[仅用户可改]/[不可改] 的小节绝对不能出现在 sections 里',
    '3. 只要最近经历里出现了新的相处细节（主人的新偏好、新习惯、新称呼、新的安慰方式、反复出现的情绪），就应做一次小幅补充或微调，不要因为「怕改坏」而永远不动',
    '4. 只有经历完全是重复的日常、或与人格无关的话题时，才 changed=false',
    '5. 保持角色核心身份不变，单次最多改 2 个小节；每段正文不超过 1200 字',
    '6. 正文里不要提系统、提示词、模型、JSON、演化器这些词',
    '7. 改动要写成长期有效的描述（例如「主人加班时先安静陪着，不催睡」），不要写一次性的对话内容',
    '可用小节：',
    sectionList,
  ].join('\n');
}

function buildTranscript(messages: EvolveMessage[], budgetChars: number): string {
  const picked: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    const text = String(m.content ?? '').trim();
    if (!text) continue;
    const clipped = text.length > 400 ? text.slice(0, 400) + '…' : text;
    const line = `[${m.role === 'user' ? '主人' : '我'}] ${clipped}`;
    if (used + line.length > budgetChars && picked.length > 0) break;
    picked.unshift(line);
    used += line.length;
  }
  return picked.join('\n');
}

function buildUserPrompt(snap: PersonaSnapshot, transcript: string): string {
  return [
    '当前人格（SOUL.md）：',
    '---',
    snap.content.slice(0, 6000),
    '---',
    '',
    '最近经历（对话摘录，从旧到新）：',
    transcript || '（暂无经历）',
    '',
    '请输出 JSON。',
  ].join('\n');
}

/** 从模型回复里抠出 JSON（容忍代码围栏/前后废话） */
export function parseEvolveReply(text: string): ParsedEvolve | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const attempt = (input: string): unknown => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  };
  let obj = attempt(stripped);
  if (obj === null) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) obj = attempt(stripped.slice(start, end + 1));
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const changed = rec['changed'] === true;
  const reason = typeof rec['reason'] === 'string' ? rec['reason'].slice(0, 300) : '';
  const sections: Record<string, string> = {};
  const rawSections = rec['sections'];
  if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    for (const [key, value] of Object.entries(rawSections as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) sections[key] = value;
    }
  }
  return { changed, reason, sections };
}

export async function evolvePersona(opts: EvolveOptions): Promise<EvolveResult> {
  const snap = opts.store.read();
  const editable = snap.sections.filter((s) => AI_EDITABLE_KEYS.includes(s.key) && !s.locked && !s.userOnly);
  const lockedCount = snap.sections.filter((s) => s.locked || s.userOnly).length;
  if (editable.length === 0) {
    return {
      changed: false,
      reason: lockedCount > 0 ? '所有可演化小节都已上锁或仅用户可改' : '人格里没有可演化的小节',
      version: snap.version,
      applied: [],
      skipped: [],
      rejected: [],
    };
  }

  const recent = await opts.recentMessages();
  const transcript = buildTranscript(recent, opts.historyBudgetChars ?? 3000);
  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(snap) },
    { role: 'user', content: buildUserPrompt(snap, transcript) },
  ];

  let reply: { text: string };
  try {
    reply = await opts.llm.complete({
      messages,
      temperature: 0.3,
      maxTokens: 800,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (e) {
    if (e instanceof PetdError) throw e;
    throw new PetdError('E_INTERNAL', `人格演化调用模型失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const parsed = parseEvolveReply(reply.text);
  if (!parsed) {
    opts.logger?.warn('人格演化返回非法 JSON，已忽略', { preview: reply.text.slice(0, 200) });
    return {
      changed: false,
      reason: '模型输出不是合法 JSON（已忽略，人格未变）',
      version: snap.version,
      applied: [],
      skipped: [],
      rejected: [],
      raw: reply.text.slice(0, 2000),
    };
  }
  if (!parsed.changed || Object.keys(parsed.sections).length === 0) {
    return {
      changed: false,
      reason: parsed.reason || '本次无需演化',
      version: snap.version,
      applied: [],
      skipped: [],
      rejected: [],
      raw: reply.text.slice(0, 2000),
    };
  }

  const result = opts.store.patch({
    sections: parsed.sections,
    actor: 'agent',
    reason: parsed.reason || 'AI 自我演化',
  });
  opts.logger?.info('人格演化已应用', {
    version: result.version,
    applied: result.applied,
    skipped: result.skipped,
    rejected: result.rejected.map((r) => r.key),
    reason: parsed.reason,
  });
  return {
    changed: result.changed,
    reason: parsed.reason || 'AI 自我演化',
    version: result.version,
    applied: result.applied,
    skipped: result.skipped,
    rejected: result.rejected,
    raw: reply.text.slice(0, 2000),
  };
}
