/**
 * 情绪与状态：查看、手动调整、被戳、以及让模型评估最近一段对话带来的情绪变化。
 *
 * - `mood.adjust` 是确定性入口（用户/UI 用），`mood.evaluate` 会真调一次模型（花 token）。
 * - 所有变化都广播 `mood.changed`，UI 可以据此刷新心情指示。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { ChatStore } from '../../chat/store.js';
import type { LlmClient } from '../../llm/client.js';
import type { MoodEntry, MoodStore, MoodKey } from '../../state/mood.js';
import type { MethodRegistry } from '../registry.js';

export interface MoodMethodDeps {
  store: MoodStore;
  llm: LlmClient;
  chats: ChatStore;
  publish: (event: string, data: unknown) => void;
  enabled: () => boolean;
}

const ValuesSchema = Type.Object({
  mood: Type.Number({ minimum: 0, maximum: 100 }),
  affection: Type.Number({ minimum: 0, maximum: 100 }),
  energy: Type.Number({ minimum: 0, maximum: 100 }),
});

const SnapshotSchema = Type.Object({
  ...ValuesSchema.properties,
  pokes: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer(),
  tiers: Type.Object({ mood: Type.String(), affection: Type.String(), energy: Type.String() }),
});

const EntrySchema = Type.Object({
  ts: Type.Integer(),
  key: Type.Union([Type.Literal('mood'), Type.Literal('affection'), Type.Literal('energy')]),
  from: Type.Number(),
  to: Type.Number(),
  delta: Type.Number(),
  reason: Type.String(),
  source: Type.String(),
});

const AdjustResult = Type.Object({
  state: ValuesSchema,
  applied: Type.Array(EntrySchema),
});

function entryOf(e: MoodEntry): unknown {
  return { ts: e.ts, key: e.key, from: e.from, to: e.to, delta: e.delta, reason: e.reason, source: e.source };
}

/** 解析模型给的 JSON（容忍代码围栏与前后废话） */
export function parseMoodJudge(raw: string): { deltas: Partial<Record<MoodKey, number>>; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-2, Math.min(2, Math.round(n * 10) / 10));
  };
  return {
    deltas: { mood: num(o['mood']), affection: num(o['affection']), energy: num(o['energy']) },
    reason: typeof o['reason'] === 'string' ? o['reason'].slice(0, 120) : '',
  };
}

export function registerMoodMethods(reg: MethodRegistry, deps: MoodMethodDeps): void {
  reg.register(
    {
      name: 'mood.status',
      scope: 'read',
      description: '当前情绪与状态：心情/好感/精力（0–100）+ 档位名',
      result: Type.Object({ enabled: Type.Boolean(), state: SnapshotSchema }),
    },
    () => ({ enabled: deps.enabled(), state: deps.store.current() })
  );

  reg.register(
    {
      name: 'mood.history',
      scope: 'read',
      description: '情绪变化历史（最近的在前，默认 20 条）',
      params: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      result: Type.Object({ entries: Type.Array(EntrySchema) }),
    },
    (params) => {
      const p = params as { limit?: number };
      const entries = deps.store.history(p?.limit ?? 20).reverse();
      return { entries };
    }
  );

  reg.register(
    {
      name: 'mood.adjust',
      scope: 'write',
      description: '手动增减情绪数值（可以为负；reason 可选，会记进历史）',
      params: Type.Object({
        mood: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
        affection: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
        energy: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
        reason: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      result: AdjustResult,
    },
    (params) => {
      const p = params as { mood?: number; affection?: number; energy?: number; reason?: string };
      const { state, applied } = deps.store.adjust(
        { mood: p?.mood, affection: p?.affection, energy: p?.energy },
        { reason: p?.reason ?? '手动调整', source: 'user' }
      );
      if (applied.length > 0) {
        const snap = deps.store.current();
        deps.publish('mood.changed', { state: snap, applied: applied.map(entryOf), source: 'user', reason: p?.reason ?? '手动调整' });
      }
      return { state: { mood: state.mood, affection: state.affection, energy: state.energy }, applied: applied.map(entryOf) };
    }
  );

  reg.register(
    {
      name: 'mood.poke',
      scope: 'write',
      description: '被戳/摸一下：心情 +1、好感 +0.5，返回最新状态',
      result: SnapshotSchema,
    },
    () => {
      const snap = deps.store.poke();
      deps.publish('mood.changed', { state: snap, applied: [], source: 'poke', reason: '被戳了一下' });
      return snap;
    }
  );

  reg.register(
    {
      name: 'mood.evaluate',
      scope: 'write',
      description: '让模型看最近一段对话，评估情绪/好感/精力的变化（-2~+2 各一项；会真调一次模型）',
      params: Type.Object({ sessionId: Type.Optional(Type.String({ maxLength: 100 })) }),
      result: AdjustResult,
      timeoutMs: 90_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { sessionId?: string };
      const sessions = deps.chats.list();
      const target = p?.sessionId ? sessions.find((s) => s.id === p.sessionId) : sessions[0];
      if (!target) throw new PetdError('E_NOT_FOUND', '没有可评估的会话（先聊两句再来）');
      const session = deps.chats.get(target.id);
      const messages = (session?.messages ?? []).slice(-12);
      const transcript = messages.map((m) => `${m.role === 'user' ? '主人' : '我'}：${m.content.slice(0, 300)}`).join('\n');
      let reply;
      try {
        reply = await deps.llm.complete({
          messages: [
            {
              role: 'system',
              content:
                '你是情绪评估员。根据一段主人和桌宠的对话，判断这段互动让桌宠的心情/对主人的好感/精力如何变化。' +
                '只输出一个 JSON 对象：{"mood":-2到2,"affection":-2到2,"energy":-2到2,"reason":"一句话"}。' +
                '没有明显变化就都给 0；不要输出 JSON 以外的内容。',
            },
            { role: 'user', content: `对话：\n${transcript || '（空）'}` },
          ],
          temperature: 0.2,
          maxTokens: 200,
        });
      } catch (e) {
        throw new PetdError('E_INTERNAL', `情绪评估失败：${e instanceof Error ? e.message : String(e)}`);
      }
      const verdict = parseMoodJudge(reply.text);
      if (!verdict) throw new PetdError('E_INTERNAL', '模型没有给出可解析的情绪评估，稍后再试');
      const { state, applied } = deps.store.adjust(verdict.deltas, { reason: verdict.reason || '模型评估', source: 'llm' });
      if (applied.length > 0) {
        const snap = deps.store.current();
        deps.publish('mood.changed', { state: snap, applied: applied.map(entryOf), source: 'llm', reason: verdict.reason });
      }
      return { state: { mood: state.mood, affection: state.affection, energy: state.energy }, applied: applied.map(entryOf) };
    }
  );
}
