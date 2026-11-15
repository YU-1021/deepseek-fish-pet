/**
 * 情绪与状态（mood / affection / energy）
 *
 * 设计参考旧桌宠 app/src/mood.js（同项目 MIT）但做了扩展：
 * - 三个连续数值：心情（快变）、好感（慢变）、精力（离线恢复）
 * - 离线衰减/恢复：心情按小时回落（最多 -30），精力按小时回升
 * - 每次修改都记一条历史（谁改的、改了多少、为什么），便于 UI 展示与排查
 * - 给聊天提示词用的不是数字，而是「行为指导」文本（让语气自然变化，而不是报数值）
 */
import fs from 'node:fs';
import path from 'node:path';

export type MoodKey = 'mood' | 'affection' | 'energy';
export type MoodSource = 'system' | 'user' | 'chat' | 'llm' | 'poke';

export interface MoodValues {
  /** 心情 0–100（快变量） */
  mood: number;
  /** 对主人的好感 0–100（慢变量） */
  affection: number;
  /** 精力 0–100（离线恢复） */
  energy: number;
}

export interface MoodState extends MoodValues {
  version: 1;
  pokes: number;
  updatedAt: number;
}

export interface MoodEntry {
  ts: number;
  key: MoodKey;
  from: number;
  to: number;
  delta: number;
  reason: string;
  source: MoodSource;
}

export interface MoodTiers {
  mood: string;
  affection: string;
  energy: string;
}

export interface MoodSnapshot extends MoodValues {
  pokes: number;
  updatedAt: number;
  tiers: MoodTiers;
}

interface MoodFile {
  version: 1;
  state: MoodState;
  history: MoodEntry[];
}

export interface MoodStoreOptions {
  /** 状态文件绝对路径（通常是 home/state/mood.json） */
  file: string;
  now?: () => number;
  log?: { warn(msg: string, data?: unknown): void };
  /** 离线每小时心情回落（默认 2，最多累计 -30） */
  moodDecayPerHour?: number;
  /** 离线每小时精力恢复（默认 8） */
  energyRecoverPerHour?: number;
}

const DEFAULTS: MoodValues = { mood: 70, affection: 30, energy: 80 };
const MAX_HISTORY = 100;

export function clampValue(v: number): number {
  const n = Number.isFinite(v) ? v : 0;
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}

export function tierOf(key: MoodKey, value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  if (key === 'mood') {
    if (v < 20) return '很低落';
    if (v < 40) return '有点闷';
    if (v < 60) return '平静';
    if (v < 80) return '心情不错';
    return '很开心';
  }
  if (key === 'affection') {
    if (v < 25) return '还生疏';
    if (v < 50) return '逐渐熟悉';
    if (v < 70) return '比较亲近';
    return '很黏你';
  }
  if (v < 30) return '很累';
  if (v < 60) return '有点乏';
  if (v < 85) return '正常';
  return '很有精神';
}

/** 把数值翻译成给模型的「行为指导」（不报数字） */
export function buildMoodPrompt(values: MoodValues): string {
  const mood = tierOf('mood', values.mood);
  const affection = tierOf('affection', values.affection);
  const energy = tierOf('energy', values.energy);
  const lines = [
    '## 你现在的状态',
    `- 心情：${mood}；对主人的好感：${affection}；精力：${energy}。`,
    '- 这些只体现在语气、话多话少、愿不愿意主动帮忙上，不要在回复里报数值，也别刻意说明「我心情 X 分」。',
  ];
  if (values.mood < 35) lines.push('- 心情偏低：话可以短一点、别硬装开心，被关心时嘴上不承认也行。');
  else if (values.mood >= 80) lines.push('- 心情很好：可以更主动、更活泼，愿意多聊两句。');
  if (values.affection >= 70) lines.push('- 关系很亲近：可以更自然地撒娇/关心，不用太客气。');
  else if (values.affection < 25) lines.push('- 关系还生疏：保持礼貌，别太自来熟。');
  if (values.energy < 35) lines.push('- 精力不足：容易累、会犯困，可以直说想歇一会儿。');
  else if (values.energy >= 85) lines.push('- 精力充沛：做事积极，愿意多干一点。');
  return lines.join('\n');
}

export function parseMoodFile(text: string): { state: MoodState; history: MoodEntry[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const s = (obj['state'] && typeof obj['state'] === 'object' ? obj['state'] : obj) as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const state: MoodState = {
    version: 1,
    mood: clampValue(num(s['mood'], DEFAULTS.mood)),
    affection: clampValue(num(s['affection'], DEFAULTS.affection)),
    energy: clampValue(num(s['energy'], DEFAULTS.energy)),
    pokes: Math.max(0, Math.round(num(s['pokes'], 0))),
    updatedAt: Math.max(0, Math.round(num(s['updatedAt'], Date.now()))),
  };
  const historyRaw = Array.isArray(obj['history']) ? obj['history'] : [];
  const history: MoodEntry[] = [];
  for (const item of historyRaw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const key = e['key'];
    if (key !== 'mood' && key !== 'affection' && key !== 'energy') continue;
    history.push({
      ts: Math.max(0, Math.round(num(e['ts'], 0))),
      key,
      from: clampValue(num(e['from'], 0)),
      to: clampValue(num(e['to'], 0)),
      delta: Math.round(num(e['delta'], 0) * 10) / 10,
      reason: typeof e['reason'] === 'string' ? e['reason'].slice(0, 200) : '',
      source: typeof e['source'] === 'string' ? (e['source'] as MoodSource) : 'system',
    });
  }
  return { state, history: history.slice(-MAX_HISTORY) };
}

function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, data, 'utf8');
  }
}

export class MoodStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log?: MoodStoreOptions['log'];
  private readonly moodDecayPerHour: number;
  private readonly energyRecoverPerHour: number;

  constructor(opts: MoodStoreOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.moodDecayPerHour = opts.moodDecayPerHour ?? 2;
    this.energyRecoverPerHour = opts.energyRecoverPerHour ?? 8;
  }

  ensure(): MoodState {
    const loaded = this.read();
    if (loaded) return this.applyDecay(loaded.state, loaded.history);
    const fresh: MoodState = {
      version: 1,
      ...DEFAULTS,
      pokes: 0,
      updatedAt: this.now(),
    };
    this.write(fresh, []);
    return fresh;
  }

  private read(): MoodFile | null {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = parseMoodFile(text);
      if (!parsed) return null;
      return { version: 1, state: parsed.state, history: parsed.history };
    } catch {
      return null;
    }
  }

  private write(state: MoodState, history: MoodEntry[]): void {
    const data: MoodFile = { version: 1, state, history: history.slice(-MAX_HISTORY) };
    try {
      writeFileAtomic(this.file, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log?.warn('情绪状态写入失败', { error: (e as Error).message });
    }
  }

  /** 按离线时长回落心情、恢复精力（每次读都会先应用一次） */
  private applyDecay(state: MoodState, history: MoodEntry[]): MoodState {
    const now = this.now();
    const hours = Math.max(0, (now - state.updatedAt) / 3_600_000);
    if (hours < 0.02) return state;
    const next: MoodState = { ...state, updatedAt: now };
    const moodDrop = Math.min(30, hours * this.moodDecayPerHour);
    if (moodDrop > 0.05) {
      next.mood = clampValue(state.mood - moodDrop);
      if (next.mood !== state.mood) {
        history.push({ ts: now, key: 'mood', from: state.mood, to: next.mood, delta: Math.round((next.mood - state.mood) * 10) / 10, reason: `离线 ${hours.toFixed(1)} 小时自然回落`, source: 'system' });
      }
    }
    const energyGain = Math.min(100 - state.energy, hours * this.energyRecoverPerHour);
    if (energyGain > 0.05) {
      next.energy = clampValue(state.energy + energyGain);
      if (next.energy !== state.energy) {
        history.push({ ts: now, key: 'energy', from: state.energy, to: next.energy, delta: Math.round((next.energy - state.energy) * 10) / 10, reason: `离线 ${hours.toFixed(1)} 小时恢复精力`, source: 'system' });
      }
    }
    this.write(next, history);
    return next;
  }

  current(): MoodSnapshot {
    const loaded = this.read();
    const state = loaded ? this.applyDecay(loaded.state, loaded.history) : this.ensure();
    return {
      mood: state.mood,
      affection: state.affection,
      energy: state.energy,
      pokes: state.pokes,
      updatedAt: state.updatedAt,
      tiers: {
        mood: tierOf('mood', state.mood),
        affection: tierOf('affection', state.affection),
        energy: tierOf('energy', state.energy),
      },
    };
  }

  /** 增减数值（可正可负），返回实际变化；0 变化时不写盘 */
  adjust(
    deltas: Partial<Record<MoodKey, number>>,
    opts: { reason?: string; source?: MoodSource } = {}
  ): { state: MoodState; applied: MoodEntry[] } {
    const loaded = this.read();
    const state: MoodState = loaded ? this.applyDecay(loaded.state, loaded.history) : { version: 1, ...DEFAULTS, pokes: 0, updatedAt: this.now() };
    const history = loaded ? loaded.history : [];
    const applied: MoodEntry[] = [];
    const now = this.now();
    const reason = (opts.reason ?? '').slice(0, 200);
    const source = opts.source ?? 'user';
    for (const key of ['mood', 'affection', 'energy'] as MoodKey[]) {
      const delta = Number(deltas[key]);
      if (!Number.isFinite(delta) || delta === 0) continue;
      const from = state[key];
      const to = clampValue(from + delta);
      const real = Math.round((to - from) * 10) / 10;
      if (real === 0) continue;
      state[key] = to;
      const entry: MoodEntry = { ts: now, key, from, to, delta: real, reason, source };
      history.push(entry);
      applied.push(entry);
    }
    if (applied.length === 0) return { state, applied };
    state.updatedAt = now;
    this.write(state, history);
    return { state, applied };
  }

  /** 被戳/摸一下：心情 +1、好感 +0.5（上限都受 clamp 约束） */
  poke(): MoodSnapshot {
    const loaded = this.read();
    let count = 0;
    if (loaded) {
      const decayed = this.applyDecay(loaded.state, loaded.history);
      decayed.pokes = Math.max(0, decayed.pokes) + 1;
      count = decayed.pokes;
      this.write(decayed, loaded.history);
    }
    this.adjust({ mood: 1, affection: 0.5 }, { reason: count > 0 ? `被戳了第 ${count} 次` : '被戳了一下', source: 'poke' });
    return this.current();
  }

  history(limit = 20): MoodEntry[] {
    const loaded = this.read();
    if (!loaded) return [];
    const n = Math.max(1, Math.min(MAX_HISTORY, Math.round(limit) || 20));
    return loaded.history.slice(-n);
  }

  /** 给聊天提示词用（调用方决定开关） */
  prompt(): string {
    return buildMoodPrompt(this.current());
  }
}
