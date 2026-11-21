/**
 * 人格自编辑存储：SOUL.md（内核，只有人能改）+ SOUL.agent.md（外圈，AI 可改）
 * + persona-state.json（版本 / 锁 / 历史）。
 *
 * 自我迭代安全边界（docs/自我迭代-安全边界.md）：
 *   - SOUL.md 是人格内核，AI 只读；用户（或人直接改文件）才能写；
 *   - SOUL.agent.md 是可演化外圈（口头禅、相处细节、说话方式等），AI 的 patch 只写它；
 *   - 读取时合并两份（agent 覆盖 core），聊天/UI 看到的是合并结果；
 *   - 用户改某个小节时，同一小节的 agent 覆盖会被清掉，让用户的值生效；
 *   - 版本/锁/历史/回滚语义不变；外部手改任一份文件都能被检测到。
 *
 * 小节 key 由标题映射：身份/世界观/性格/口头禅/隐藏设定/说话方式；未知标题归 custom:*。
 * - AI（persona.evolve）只能改 AI_EDITABLE_KEYS 且未上锁的小节；
 * - 世界观永远只有用户能改（USER_ONLY_KEYS），不能上锁；
 * - 用户（persona.patch）可改任何小节，锁只约束 AI。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { buildSoul, type LegacyPersona } from '../chat/persona.js';
import { assertAgentWritable } from '../kernel/agent-files.js';

export const PERSONA_STATE_VERSION = 1;
export const MAX_SOUL_CHARS = 20_000;
export const MAX_SECTION_CHARS = 4_000;
export const MAX_HISTORY = 50;
/** AI 可写的人格外圈文件名（相对 home，或与 SOUL 同目录） */
export const SOUL_AGENT_FILE = 'SOUL.agent.md';

export type PersonaActor = 'user' | 'agent' | 'system';

export interface PersonaSection {
  key: string;
  heading: string;
  content: string;
}

export interface PersonaSectionView extends PersonaSection {
  locked: boolean;
  aiEditable: boolean;
  userOnly: boolean;
  /** 该小节来自 SOUL.agent.md（外圈覆盖）还是内核 */
  source?: 'core' | 'agent';
}

export interface PersonaRevision {
  version: number;
  ts: string;
  actor: PersonaActor;
  reason: string;
  /** 该版本写入后的合并全文（回滚直接用它，避免重放差分的坑） */
  snapshot: string;
  changedKeys: string[];
}

export interface PersonaState {
  version: number;
  updatedAt: string;
  soulHash: string;
  locks: Record<string, boolean>;
  history: PersonaRevision[];
}

export interface PersonaSnapshot {
  content: string;
  hash: string;
  version: number;
  updatedAt: string;
  title: string;
  preamble: string;
  sections: PersonaSectionView[];
  locks: Record<string, boolean>;
  /** 内核文件绝对路径（只有人能改） */
  coreFile: string;
  /** 外圈文件绝对路径（AI 可改） */
  agentFile: string;
  hasAgentOverrides: boolean;
}

export interface PersonaPatchInput {
  sections: Record<string, string>;
  reason?: string;
  actor?: PersonaActor;
  expectedVersion?: number;
}

export interface PersonaRejected {
  key: string;
  reason: string;
}

export interface PersonaPatchResult {
  changed: boolean;
  version: number;
  applied: string[];
  skipped: string[];
  rejected: PersonaRejected[];
}

export interface ParsedSoul {
  title: string;
  preamble: string;
  sections: PersonaSection[];
}

/** AI 可编辑的小节 key */
export const AI_EDITABLE_KEYS: readonly string[] = ['identity', 'character', 'catchphrase', 'hidden', 'speaking'];
/** 永远只有用户能改的小节 key */
export const USER_ONLY_KEYS: readonly string[] = ['worldview'];

const KNOWN_HEADINGS: Array<{ match: RegExp; key: string }> = [
  { match: /^身份/, key: 'identity' },
  { match: /^世界观/, key: 'worldview' },
  { match: /^人物设定|^角色设定/, key: 'character' },
  { match: /^性格/, key: 'character' },
  { match: /^口头禅/, key: 'catchphrase' },
  { match: /^隐藏设定/, key: 'hidden' },
  { match: /^说话方式/, key: 'speaking' },
];

function sectionKeyOf(heading: string): string {
  for (const { match, key } of KNOWN_HEADINGS) {
    if (match.test(heading)) return key;
  }
  return 'custom:' + heading;
}

export function hashSoul(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 合并 hash：内核 + 外圈，任何一份被外部改都能看出来 */
function hashLayers(core: string, agent: string): string {
  return hashSoul(core + '\n/*agent*/\n' + agent);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** SOUL.md → 标题 / 前言 / 小节列表（不丢内容，未知标题保留） */
export function parseSoul(text: string): ParsedSoul {
  const lines = normalizeNewlines(text).split('\n');
  let title = '';
  const preambleLines: string[] = [];
  const sections: ParsedSoul['sections'] = [];
  const usedKeys = new Map<string, number>();
  let current: { heading: string; content: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const base = sectionKeyOf(current.heading);
    const seen = usedKeys.get(base) ?? 0;
    usedKeys.set(base, seen + 1);
    const key = seen === 0 ? base : `${base}#${seen + 1}`;
    sections.push({ key, heading: current.heading, content: current.content.join('\n').trim() });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '');
    const h1 = /^#\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h1 && current === null && !title) {
      title = (h1[1] ?? '').trim();
      continue;
    }
    if (h2) {
      flush();
      current = { heading: (h2[1] ?? '').trim(), content: [] };
      continue;
    }
    if (current) current.content.push(line);
    else preambleLines.push(line);
  }
  flush();
  return { title, preamble: preambleLines.join('\n').trim(), sections };
}

/** 小节列表 → SOUL 文本 */
export function renderSoul(parsed: ParsedSoul): string {
  const parts: string[] = [];
  if (parsed.title) parts.push('# ' + parsed.title);
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const s of parsed.sections) parts.push('## ' + s.heading + '\n' + s.content.trim());
  return parts.join('\n\n').trim() + '\n';
}

/** 合并内核与外圈：同 key 外圈覆盖内核，外圈独有小节追加在后 */
export function mergeSoulLayers(core: ParsedSoul, agent: ParsedSoul): ParsedSoul {
  const byKey = new Map<string, PersonaSection>();
  const order: string[] = [];
  for (const s of core.sections) {
    if (!byKey.has(s.key)) order.push(s.key);
    byKey.set(s.key, { ...s, source: 'core' } as PersonaSection);
  }
  for (const s of agent.sections) {
    if (!byKey.has(s.key)) order.push(s.key);
    byKey.set(s.key, { ...s, source: 'agent' } as PersonaSection);
  }
  return {
    title: core.title || agent.title,
    preamble: agent.preamble || core.preamble,
    sections: order.map((k) => byKey.get(k) as PersonaSection),
  };
}

export interface PersonaLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface PersonaStoreOptions {
  home: string;
  /** SOUL.md 文件名（相对 home）或绝对路径 */
  file: string;
  /** SOUL.agent.md 文件名（相对 home）或绝对路径；默认与 file 同目录的 SOUL.agent.md */
  agentFile?: string;
  /** 首次播种用：旧 persona.json 字段 */
  legacy?: LegacyPersona | null;
  now?: () => string;
  logger?: PersonaLogger;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolvePath(home: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(home, file);
}

function readTextIfExists(file: string): string {
  try {
    return normalizeNewlines(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

function readStateFile(file: string): PersonaState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const version = raw['version'];
  const soulHash = raw['soulHash'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (typeof soulHash !== 'string' || !soulHash) return null;
  const locksRaw = raw['locks'];
  const locks: Record<string, boolean> = {};
  if (isObject(locksRaw)) {
    for (const [k, v] of Object.entries(locksRaw)) if (v === true) locks[k] = true;
  }
  const history: PersonaRevision[] = [];
  if (Array.isArray(raw['history'])) {
    for (const item of raw['history']) {
      if (!isObject(item)) continue;
      const v = item['version'];
      const ts = item['ts'];
      const snapshot = item['snapshot'];
      if (typeof v !== 'number' || typeof ts !== 'string' || typeof snapshot !== 'string') continue;
      history.push({
        version: v,
        ts,
        actor: item['actor'] === 'agent' || item['actor'] === 'system' ? item['actor'] : 'user',
        reason: typeof item['reason'] === 'string' ? item['reason'] : '',
        snapshot,
        changedKeys: Array.isArray(item['changedKeys']) ? item['changedKeys'].filter((k): k is string => typeof k === 'string') : [],
      });
    }
  }
  return {
    version,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : new Date().toISOString(),
    soulHash,
    locks,
    history,
  };
}

export class PersonaStore {
  private readonly home: string;
  private readonly file: string;
  private readonly agentFile: string;
  private readonly legacy: LegacyPersona | null;
  private readonly now: () => string;
  private readonly logger?: PersonaLogger;

  constructor(opts: PersonaStoreOptions) {
    this.home = opts.home;
    this.file = opts.file;
    const defaultAgent = path.join(path.dirname(resolvePath(opts.home, opts.file)), SOUL_AGENT_FILE);
    this.agentFile = opts.agentFile ? resolvePath(opts.home, opts.agentFile) : defaultAgent;
    this.legacy = opts.legacy ?? null;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.logger = opts.logger;
  }

  /** 内核文件（只有人能写） */
  get soulFile(): string {
    return resolvePath(this.home, this.file);
  }

  /** 外圈文件（AI 可写） */
  get agentSoulFile(): string {
    return this.agentFile;
  }

  get stateFile(): string {
    return path.join(this.home, 'persona-state.json');
  }

  /** 首次启动：播种 SOUL.md / SOUL.agent.md、补齐 persona-state.json */
  ensure(): { createdSoul: boolean; createdState: boolean; createdAgent: boolean } {
    let createdSoul = false;
    if (!fs.existsSync(this.soulFile)) {
      fs.mkdirSync(path.dirname(this.soulFile), { recursive: true });
      fs.writeFileSync(this.soulFile, buildSoul(this.legacy), 'utf8');
      createdSoul = true;
    }
    let createdAgent = false;
    if (!fs.existsSync(this.agentSoulFile)) {
      fs.mkdirSync(path.dirname(this.agentSoulFile), { recursive: true });
      fs.writeFileSync(this.agentSoulFile, '', 'utf8');
      createdAgent = true;
    }
    const core = readTextIfExists(this.soulFile);
    const agent = readTextIfExists(this.agentSoulFile);
    const merged = mergeSoulLayers(parseSoul(core), parseSoul(agent));
    const content = renderSoul(merged);
    let createdState = false;
    if (!readStateFile(this.stateFile)) {
      const ts = this.now();
      const state: PersonaState = {
        version: 1,
        updatedAt: ts,
        soulHash: hashLayers(core, agent),
        locks: {},
        history: [
          {
            version: 1,
            ts,
            actor: 'system',
            reason: '初始化人格',
            snapshot: content,
            changedKeys: [],
          },
        ],
      };
      writeJsonAtomic(this.stateFile, state);
      createdState = true;
    }
    return { createdSoul, createdState, createdAgent };
  }

  /** 读当前人格快照（内核 + 外圈合并）；任一份被外部手改都会升版本 */
  read(): PersonaSnapshot {
    if (!fs.existsSync(this.soulFile)) {
      throw new PetdError('E_INTERNAL', `人格文件不存在：${this.soulFile}`);
    }
    const core = readTextIfExists(this.soulFile);
    const agent = readTextIfExists(this.agentSoulFile);
    const mergedParsed = mergeSoulLayers(parseSoul(core), parseSoul(agent));
    const content = renderSoul(mergedParsed);
    const hash = hashLayers(core, agent);
    let state = readStateFile(this.stateFile);
    if (!state) {
      state = { version: 1, updatedAt: this.now(), soulHash: hash, locks: {}, history: [] };
      writeJsonAtomic(this.stateFile, state);
    } else if (state.soulHash !== hash) {
      const ts = this.now();
      const version = state.version + 1;
      const revision: PersonaRevision = {
        version,
        ts,
        actor: 'user',
        reason: '检测到人格文件被外部编辑',
        snapshot: content,
        changedKeys: [],
      };
      state = {
        ...state,
        version,
        updatedAt: ts,
        soulHash: hash,
        history: [revision, ...state.history].slice(0, MAX_HISTORY),
      };
      writeJsonAtomic(this.stateFile, state);
      this.logger?.info('检测到人格文件外部修改', { version });
    }
    const sections: PersonaSectionView[] = mergedParsed.sections.map((s) => {
      const userOnly = USER_ONLY_KEYS.includes(s.key);
      return {
        ...s,
        locked: Boolean(state.locks[s.key]),
        aiEditable: !userOnly && AI_EDITABLE_KEYS.includes(s.key),
        userOnly,
        source: (s as PersonaSectionView).source ?? 'core',
      };
    });
    return {
      content,
      hash,
      version: state.version,
      updatedAt: state.updatedAt,
      title: mergedParsed.title,
      preamble: mergedParsed.preamble,
      sections,
      locks: { ...state.locks },
      coreFile: this.soulFile,
      agentFile: this.agentSoulFile,
      hasAgentOverrides: parseSoul(agent).sections.length > 0,
    };
  }

  /**
   * 按小节改写人格。
   * - actor='user'：写内核 SOUL.md，并清掉同小节的 agent 覆盖；
   * - actor='agent'：只写外圈 SOUL.agent.md，只能改 AI_EDITABLE_KEYS 且未上锁的小节。
   */
  patch(input: PersonaPatchInput): PersonaPatchResult {
    const snapshot = this.read();
    if (input.expectedVersion !== undefined && input.expectedVersion !== snapshot.version) {
      throw new PetdError('E_CONFLICT', `人格版本已变化（期望 v${input.expectedVersion}，当前 v${snapshot.version}），请刷新后重试`);
    }
    const actor: PersonaActor = input.actor ?? 'user';
    const applied: string[] = [];
    const skipped: string[] = [];
    const rejected: PersonaRejected[] = [];
    const byKey = new Map(snapshot.sections.map((s) => [s.key, s]));
    const next = new Map<string, string>();

    for (const [key, rawValue] of Object.entries(input.sections ?? {})) {
      const section = byKey.get(key);
      if (!section) {
        rejected.push({ key, reason: '小节不存在' });
        continue;
      }
      if (typeof rawValue !== 'string') {
        rejected.push({ key, reason: '内容必须是字符串' });
        continue;
      }
      const content = normalizeNewlines(rawValue).trim();
      if (!content) {
        rejected.push({ key, reason: '内容不能为空' });
        continue;
      }
      if (content.length > MAX_SECTION_CHARS) {
        rejected.push({ key, reason: `内容过长（上限 ${MAX_SECTION_CHARS} 字）` });
        continue;
      }
      if (actor === 'agent') {
        if (USER_ONLY_KEYS.includes(key)) {
          rejected.push({ key, reason: '该小节仅用户可改（AI 不可编辑）' });
          continue;
        }
        if (!AI_EDITABLE_KEYS.includes(key)) {
          rejected.push({ key, reason: '该小节不允许 AI 编辑' });
          continue;
        }
        if (snapshot.locks[key]) {
          skipped.push(key);
          continue;
        }
      }
      if (content === section.content) {
        skipped.push(key);
        continue;
      }
      next.set(key, content);
      applied.push(key);
    }

    if (next.size === 0) {
      return { changed: false, version: snapshot.version, applied: [], skipped, rejected };
    }

    const coreParsed = parseSoul(readTextIfExists(this.soulFile));
    const agentParsed = parseSoul(readTextIfExists(this.agentSoulFile));
    let newCore = coreParsed;
    let newAgent = agentParsed;

    if (actor === 'agent') {
      const agentSections = new Map(agentParsed.sections.map((s) => [s.key, s]));
      for (const [key, value] of next) {
        const existing = agentSections.get(key);
        const heading = existing?.heading ?? byKey.get(key)?.heading ?? key;
        agentSections.set(key, { key, heading, content: value });
      }
      newAgent = { ...agentParsed, sections: Array.from(agentSections.values()) };
    } else {
      newCore = {
        ...coreParsed,
        sections: coreParsed.sections.map((s) => {
          const value = next.get(s.key);
          return value === undefined ? s : { ...s, content: value };
        }),
      };
      const agentSections = agentParsed.sections.filter((s) => !next.has(s.key));
      newAgent = { ...agentParsed, sections: agentSections };
    }

    const mergedPreview = renderSoul(mergeSoulLayers(newCore, newAgent));
    if (mergedPreview.length > MAX_SOUL_CHARS) {
      throw new PetdError('E_BAD_PARAMS', `人格总长度超限（上限 ${MAX_SOUL_CHARS} 字）`);
    }
    const newCoreText = renderSoul(newCore);
    const newAgentText = renderSoul(newAgent);
    const ts = this.now();
    const state = readStateFile(this.stateFile) ?? {
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      soulHash: snapshot.hash,
      locks: snapshot.locks,
      history: [],
    };
    const revision: PersonaRevision = {
      version: state.version + 1,
      ts,
      actor,
      reason: (input.reason ?? '').trim() || '未注明原因',
      snapshot: mergedPreview,
      changedKeys: applied,
    };
    // 先写内核再写外圈；状态最后写，保证 hash 与文件一致。
    // 外圈是 AI 唯一能写的人格文件，写前再过一次白名单守卫（INV-1/7）。
    if (mergedPreview.length > MAX_SOUL_CHARS) throw new PetdError('E_BAD_PARAMS', '人格总长度超限');
    if (actor === 'agent') assertAgentWritable(this.home, this.agentSoulFile);
    writeTextAtomic(this.soulFile, newCoreText);
    writeTextAtomic(this.agentSoulFile, newAgentText);
    const nextState: PersonaState = {
      ...state,
      version: revision.version,
      updatedAt: ts,
      soulHash: hashLayers(newCoreText, newAgentText),
      history: [revision, ...state.history].slice(0, MAX_HISTORY),
    };
    writeJsonAtomic(this.stateFile, nextState);
    this.logger?.info('人格已修改', { version: revision.version, actor, applied, reason: revision.reason });
    return { changed: true, version: revision.version, applied, skipped, rejected };
  }

  /** 上锁/解锁 AI 可编辑小节（世界观本来就不能被 AI 改，不提供锁） */
  setLock(key: string, locked: boolean): Record<string, boolean> {
    if (USER_ONLY_KEYS.includes(key)) {
      throw new PetdError('E_BAD_PARAMS', '该小节仅用户可改，无需上锁');
    }
    if (!AI_EDITABLE_KEYS.includes(key)) {
      throw new PetdError('E_BAD_PARAMS', `未知小节：${key}`);
    }
    const state = readStateFile(this.stateFile);
    if (!state) throw new PetdError('E_INTERNAL', '人格状态文件缺失，请先启动一次 petd');
    const locks = { ...state.locks };
    if (locked) locks[key] = true;
    else delete locks[key];
    writeJsonAtomic(this.stateFile, { ...state, updatedAt: this.now(), locks });
    return locks;
  }

  /** 历史版本列表（里层 snapshot 不回传，避免一次拿一大堆全文） */
  history(limit = 20): Array<Omit<PersonaRevision, 'snapshot'>> {
    const state = readStateFile(this.stateFile);
    if (!state) return [];
    const n = Math.max(1, Math.min(MAX_HISTORY, Math.floor(limit)));
    return state.history.slice(0, n).map(({ snapshot: _snapshot, ...rest }) => rest);
  }

  /** 回滚到某个历史版本：快照写回内核，外圈清空（合并结果即该版本） */
  rollback(version: number): PersonaPatchResult {
    const state = readStateFile(this.stateFile);
    if (!state) throw new PetdError('E_INTERNAL', '人格状态文件缺失，无法回滚');
    const target = state.history.find((r) => r.version === version);
    if (!target) throw new PetdError('E_NOT_FOUND', `没有 v${version} 的历史版本`);
    const content = normalizeNewlines(target.snapshot);
    writeTextAtomic(this.soulFile, content);
    writeTextAtomic(this.agentSoulFile, '');
    const ts = this.now();
    const revision: PersonaRevision = {
      version: state.version + 1,
      ts,
      actor: 'user',
      reason: `回滚到 v${version}`,
      snapshot: content,
      changedKeys: ['*'],
    };
    const nextState: PersonaState = {
      ...state,
      version: revision.version,
      updatedAt: ts,
      soulHash: hashLayers(content, ''),
      history: [revision, ...state.history].slice(0, MAX_HISTORY),
    };
    writeJsonAtomic(this.stateFile, nextState);
    this.logger?.info('人格已回滚', { from: state.version, to: revision.version, target: version });
    return { changed: true, version: revision.version, applied: ['*'], skipped: [], rejected: [] };
  }
}

function writeTextAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export { readStateFile };
