/**
 * 学习闭环（自我迭代第 5 步，INV-5/6/9）：
 * - AI 只能写候选：`home/proposals/*.agent.md`（改 prompt/参数/偏好）、`home/skills/staging/*.agent.md`（候选技能）；
 * - 人审后才转正：`learning.approve` 把候选技能写到 `home/skills/<name>/SKILL.md`（正式技能），
 *   把 prompt/参数/偏好写到 `home/learning/<name>.agent.json`（已批准的学习结果，拼进系统提示词）；
 * - 灰度：批准时可标「灰度」，按 `config.learning.grayPercent` 的比例参与，`grayDays` 内可一键回滚；
 * - 回滚：`learning.rollback` 删掉已生效的产物，并记一条 `actor=user` 的审计；
 * - 状态落盘：`home/state/learning.json` 只存 id → 状态（正文在文件里，可审计、可人工直接看）。
 *
 * 红线：AI 不能改 `requireApproval`/灰度参数（这些在 config.json 里，只有人能改，见 INV-3/10）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import { assertAgentWritable } from '../kernel/agent-files.js';
import type { AgentAuditLog } from '../kernel/agent-audit.js';
import { buildSkillMarkdown, isSafeSkillName, parseSkillMarkdown } from '../skills/store.js';

export const LEARNING_KINDS = ['skill', 'prompt', 'params', 'preference'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningStatus = 'pending' | 'approved' | 'gray' | 'rejected' | 'rolledback';

/** 灰度信息：按比例参与、观察期内可回滚 */
export interface GrayInfo {
  percent: number;
  startedAt: number;
  rollbackAfterDays: number;
}

export interface LearningItem {
  id: string;
  kind: LearningKind;
  name: string;
  reason: string;
  /** 相对 home 的路径（统一用 /） */
  path: string;
  createdAt: number;
  status: LearningStatus;
  /** 候选带来的改动说明（自由文本） */
  diff?: string;
  contentChars: number;
  gray?: GrayInfo;
}

export interface LearningItemDetail extends LearningItem {
  /** 候选正文（已批准的技能是 SKILL.md 正文；提案是原候选正文） */
  body: string;
}

export interface LearningProposeInput {
  kind: LearningKind;
  name: string;
  content: string;
  reason: string;
  diff?: string;
}

export interface LearningStatusSummary {
  enabled: boolean;
  requireApproval: boolean;
  counts: Record<LearningStatus, number>;
  pending: LearningItem[];
  activeGray: Array<Pick<LearningItem, 'id' | 'name' | 'kind' | 'gray'>>;
  dirs: { proposals: string; staging: string; approved: string };
  maxPending: number;
}

export interface LearningLogger {
  debug?(msg: string, data?: Record<string, unknown>): void;
  info?(msg: string, data?: Record<string, unknown>): void;
  warn?(msg: string, data?: Record<string, unknown>): void;
  error?(msg: string, data?: Record<string, unknown>): void;
}

export interface LearningServiceOptions {
  home: string;
  config: () => PetdConfig['learning'];
  logger?: LearningLogger;
  publish?: (event: string, data: unknown) => void;
  audit?: AgentAuditLog;
  now?: () => number;
  /** 灰度抽样用；测试可注入固定值 */
  random?: () => number;
}

interface LearningStateItem {
  status: LearningStatus;
  at: number;
  gray?: GrayInfo;
  reason?: string;
}

interface LearningState {
  version: 1;
  items: Record<string, LearningStateItem>;
}

const MAX_CONTENT = 20_000;
const MAX_REASON = 500;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 解析本服务自己写的小 frontmatter（id/kind/name/reason/createdAt/diff） */
function parseMeta(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const meta: Record<string, string> = {};
  if (lines[0]?.trim() !== '---') return { meta, body: normalized };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { meta, body: normalized };
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value) meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

export class LearningService {
  private readonly home: string;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: LearningServiceOptions) {
    this.home = options.home;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  private get cfg(): PetdConfig['learning'] {
    return this.options.config();
  }

  private dirProposals(): string {
    return path.join(this.home, 'proposals');
  }
  private dirStaging(): string {
    return path.join(this.home, 'skills', 'staging');
  }
  private dirApproved(): string {
    return path.join(this.home, 'learning');
  }
  private dirState(): string {
    return path.join(this.home, 'state');
  }
  private stateFile(): string {
    return path.join(this.dirState(), 'learning.json');
  }

  ensure(): void {
    for (const dir of [this.dirProposals(), this.dirStaging(), this.dirApproved(), this.dirState()]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.stateFile())) this.writeState({ version: 1, items: {} });
  }

  private readState(): LearningState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as unknown;
      if (raw !== null && typeof raw === 'object' && (raw as LearningState).version === 1 && typeof (raw as LearningState).items === 'object') {
        return raw as LearningState;
      }
    } catch {
      /* 损坏就当空状态 */
    }
    return { version: 1, items: {} };
  }

  private writeState(state: LearningState): void {
    const file = this.stateFile();
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  private setStatus(id: string, status: LearningStatus, extra: { gray?: GrayInfo; reason?: string } = {}): void {
    const state = this.readState();
    state.items[id] = { status, at: this.now(), ...(extra.gray === undefined ? {} : { gray: extra.gray }), ...(extra.reason === undefined ? {} : { reason: extra.reason }) };
    this.writeState(state);
  }

  /** 扫候选文件（skills/staging + proposals）与已批准的 learning 产物 */
  private scanFiles(): LearningItem[] {
    const items: LearningItem[] = [];
    const state = this.readState();
    const scan = (dir: string, source: 'staging' | 'proposal'): void => {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.agent.md')) continue;
        const abs = path.join(dir, entry);
        let text: string;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const { meta, body } = parseMeta(text);
        const st = state.items[String(meta['id'] ?? '')] ?? null;
        const kind = (LEARNING_KINDS as readonly string[]).includes(meta['kind'] ?? '') ? (meta['kind'] as LearningKind) : source === 'staging' ? 'skill' : 'prompt';
        items.push({
          id: String(meta['id'] ?? `file-${entry}`),
          kind,
          name: String(meta['name'] ?? entry.replace(/\.agent\.md$/, '')),
          reason: String(meta['reason'] ?? ''),
          path: toPosix(path.relative(this.home, abs)),
          createdAt: Number(meta['createdAt'] ?? 0) || Math.round(this.fileMtime(abs)),
          status: st?.status ?? 'pending',
          ...(meta['diff'] === undefined ? {} : { diff: meta['diff'] }),
          contentChars: body.length,
          ...(st?.gray === undefined ? {} : { gray: st.gray }),
        });
      }
    };
    scan(this.dirStaging(), 'staging');
    scan(this.dirProposals(), 'proposal');
    // 已批准的学习结果（learning/*.agent.json）
    try {
      for (const entry of fs.readdirSync(this.dirApproved())) {
        if (!entry.endsWith('.agent.json')) continue;
        const abs = path.join(this.dirApproved(), entry);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = String(parsed['id'] ?? entry.replace(/\.agent\.json$/, ''));
        const st = state.items[id] ?? null;
        const kindRaw = String(parsed['kind'] ?? '');
        items.push({
          id,
          kind: (LEARNING_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as LearningKind) : 'preference',
          name: String(parsed['name'] ?? entry.replace(/\.agent\.json$/, '')),
          reason: String(parsed['reason'] ?? ''),
          path: toPosix(path.relative(this.home, abs)),
          createdAt: Number(parsed['approvedAt'] ?? 0) || Math.round(this.fileMtime(abs)),
          status: st?.status ?? 'approved',
          contentChars: String(parsed['content'] ?? '').length,
          ...(st?.gray === undefined ? {} : { gray: st.gray }),
        });
      }
    } catch {
      /* 目录不存在 */
    }
    return items;
  }

  private fileMtime(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return this.now();
    }
  }

  list(query: { kind?: LearningKind; status?: LearningStatus } = {}): LearningItem[] {
    this.ensure();
    const items = this.scanFiles();
    // 同一条提案在「候选文件」和「已批准产物」里各有一份；列表里只留一份：
    // 已生效的偏好/参数以 learning/ 里的产物为准，技能则以 staging 里的候选为准（技能产物没有 id）。
    const unique = new Map<string, LearningItem>();
    for (const item of items) {
      const prev = unique.get(item.id);
      if (prev === undefined) {
        unique.set(item.id, item);
        continue;
      }
      if (item.path.startsWith('learning/') && prev.path.startsWith('proposals/')) unique.set(item.id, item);
    }
    return [...unique.values()]
      .filter((item) => (query.kind === undefined ? true : item.kind === query.kind))
      .filter((item) => (query.status === undefined ? true : item.status === query.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): LearningItemDetail {
    this.ensure();
    const item = this.scanFiles().find((it) => it.id === id);
    if (!item) throw new PetdError('E_NOT_FOUND', `找不到这条学习提案：${id}`);
    const abs = path.join(this.home, item.path);
    let body = '';
    try {
      const text = fs.readFileSync(abs, 'utf8');
      if (abs.endsWith('.agent.json')) {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        body = String(parsed['content'] ?? '');
      } else {
        body = parseMeta(text).body;
      }
    } catch {
      /* 文件可能已被回滚删掉 */
    }
    return { ...item, body };
  }

  private validateName(kind: LearningKind, name: unknown): string {
    if (kind === 'skill') {
      if (!isSafeSkillName(name)) throw new PetdError('E_BAD_PARAMS', '技能名只能用字母/数字/下划线/中划线，最长 64 字');
      return name;
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new PetdError('E_BAD_PARAMS', '名字只能用字母/数字/点/下划线/中划线（≤49 字），例如 language、reply_style');
    }
    return name;
  }

  /** AI 写候选（只写到 proposals / skills/staging，不直接影响运行时） */
  propose(input: LearningProposeInput): LearningItem {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new PetdError('E_UNAVAILABLE', '学习/提案功能已关闭（config.learning.enabled=false）');
    if (!(LEARNING_KINDS as readonly string[]).includes(input.kind)) throw new PetdError('E_BAD_PARAMS', `kind 必须是 ${LEARNING_KINDS.join('/')}`);
    const name = this.validateName(input.kind, input.name);
    const content = String(input.content ?? '').trim();
    if (!content) throw new PetdError('E_BAD_PARAMS', 'content 不能为空');
    if (content.length > MAX_CONTENT) throw new PetdError('E_BAD_PARAMS', `content 太长（上限 ${MAX_CONTENT} 字）`);
    const reason = String(input.reason ?? '').trim();
    if (!reason) throw new PetdError('E_BAD_PARAMS', 'reason 不能为空（要写清楚为什么建议这样改）');
    if (reason.length > MAX_REASON) throw new PetdError('E_BAD_PARAMS', `reason 太长（上限 ${MAX_REASON} 字）`);
    this.ensure();
    const pending = this.list({ status: 'pending' }).length;
    if (pending >= cfg.maxPending) {
      throw new PetdError('E_UNAVAILABLE', `待审提案太多（${pending} 条，上限 ${cfg.maxPending}），等主人先处理一些`);
    }
    const id = `lrn-${this.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const createdAt = this.now();
    const dir = input.kind === 'skill' ? this.dirStaging() : this.dirProposals();
    const abs = path.join(dir, `${id}.agent.md`);
    assertAgentWritable(this.home, abs);
    const header: string[] = ['---', `id: ${id}`, `kind: ${input.kind}`, `name: ${name}`, `reason: ${reason}`, `createdAt: ${createdAt}`];
    if (input.diff !== undefined && String(input.diff).trim()) header.push(`diff: ${String(input.diff).trim().slice(0, MAX_REASON)}`);
    header.push('---', '');
    const text = header.join('\n') + '\n' + content + '\n';
    fs.writeFileSync(abs, text, 'utf8');
    this.options.audit?.append({ path: toPosix(path.relative(this.home, abs)), actor: 'agent', action: 'write', reason: `AI 提案：${reason}`, beforeText: null, afterText: text });
    this.setStatus(id, 'pending');
    this.options.logger?.info?.('收到学习提案', { id, kind: input.kind, name });
    this.options.publish?.('learning.proposed', { id, kind: input.kind, name, reason });
    return this.get(id);
  }

  /** 人批：技能转正；其他写进 learning/ 供提示词装配。gray=true 时按比例灰度 */
  approve(id: string, opts: { gray?: boolean; force?: boolean } = {}): LearningItemDetail {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new PetdError('E_UNAVAILABLE', '学习/提案功能已关闭（config.learning.enabled=false）');
    const item = this.get(id);
    if (item.status !== 'pending') throw new PetdError('E_CONFLICT', `这条提案已经处理过了（状态：${item.status}）`);
    const useGray = opts.gray === true && item.kind !== 'skill';
    const now = this.now();
    const gray: GrayInfo | undefined = useGray ? { percent: Math.max(0, Math.min(100, cfg.grayPercent)), startedAt: now, rollbackAfterDays: Math.max(0, cfg.grayDays) } : undefined;
    if (item.kind === 'skill') {
      const name = this.validateName('skill', item.name);
      const dir = path.join(this.home, 'skills', name);
      const target = path.join(dir, 'SKILL.md');
      if (fs.existsSync(target) && opts.force !== true) throw new PetdError('E_CONFLICT', `已经有一个叫「${name}」的正式技能了（要覆盖请加 force）`);
      const parsed = parseSkillMarkdown(item.body);
      const markdown = buildSkillMarkdown({
        name,
        description: parsed.meta.description ?? item.reason.slice(0, 120),
        keywords: parsed.meta.keywords ?? [],
        always: parsed.meta.always === true,
        body: parsed.body,
      });
      const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, markdown, 'utf8');
      this.options.audit?.append({ path: toPosix(path.relative(this.home, target)), actor: 'user', action: 'write', reason: `批准技能提案：${id}`, beforeText: before, afterText: markdown });
    } else {
      const name = this.validateName(item.kind, item.name);
      const target = path.join(this.dirApproved(), `${name}.agent.json`);
      if (fs.existsSync(target) && opts.force !== true) throw new PetdError('E_CONFLICT', `已经有一条叫「${name}」的学习结果了（要覆盖请加 force）`);
      const payload = {
        id,
        kind: item.kind,
        name,
        reason: item.reason,
        content: item.body,
        approvedAt: now,
        ...(gray === undefined ? {} : { gray }),
      };
      const text = JSON.stringify(payload, null, 2) + '\n';
      const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      fs.writeFileSync(target, text, 'utf8');
      this.options.audit?.append({ path: toPosix(path.relative(this.home, target)), actor: 'user', action: 'write', reason: `批准学习提案：${id}`, beforeText: before, afterText: text });
    }
    const status: LearningStatus = gray === undefined ? 'approved' : 'gray';
    this.setStatus(id, status, gray === undefined ? {} : { gray });
    this.options.publish?.('learning.approved', { id, kind: item.kind, name: item.name, status, gray });
    this.options.logger?.info?.('学习提案已批准', { id, kind: item.kind, name: item.name, status });
    return this.get(id);
  }

  reject(id: string, reason?: string): LearningItemDetail {
    const item = this.get(id);
    if (item.status !== 'pending') throw new PetdError('E_CONFLICT', `这条提案已经处理过了（状态：${item.status}）`);
    const note = String(reason ?? '').trim().slice(0, MAX_REASON);
    this.setStatus(id, 'rejected', note ? { reason: note } : {});
    this.options.publish?.('learning.rejected', { id, kind: item.kind, name: item.name, ...(note ? { reason: note } : {}) });
    return this.get(id);
  }

  /** 人：把已生效的技能/学习结果撤掉（回滚也进审计） */
  rollback(id: string): LearningItemDetail {
    const item = this.get(id);
    if (item.status !== 'approved' && item.status !== 'gray') {
      throw new PetdError('E_CONFLICT', `只有已生效（approved/gray）的条目能回滚（当前：${item.status}）`);
    }
    const removed: string[] = [];
    const removeIfExists = (abs: string, opts: { restoreDir?: boolean } = {}): void => {
      if (!fs.existsSync(abs)) return;
      const before = fs.readFileSync(abs, 'utf8');
      fs.rmSync(abs);
      removed.push(toPosix(path.relative(this.home, abs)));
      this.options.audit?.append({ path: toPosix(path.relative(this.home, abs)), actor: 'user', action: 'delete', reason: `回滚学习条目：${id}`, beforeText: before, afterText: null });
      if (opts.restoreDir === true) {
        try {
          fs.rmdirSync(path.dirname(abs));
        } catch {
          /* 目录非空就留着 */
        }
      }
    };
    if (item.kind === 'skill') {
      removeIfExists(path.join(this.home, 'skills', item.name, 'SKILL.md'), { restoreDir: true });
    } else {
      removeIfExists(path.join(this.dirApproved(), `${item.name}.agent.json`));
    }
    this.setStatus(id, 'rolledback');
    this.options.publish?.('learning.rolledback', { id, kind: item.kind, name: item.name, removed });
    return this.get(id);
  }

  status(): LearningStatusSummary {
    this.ensure();
    const items = this.list();
    const counts: Record<LearningStatus, number> = { pending: 0, approved: 0, gray: 0, rejected: 0, rolledback: 0 };
    for (const item of items) counts[item.status] += 1;
    return {
      enabled: this.cfg.enabled,
      requireApproval: this.cfg.requireApproval,
      counts,
      pending: items.filter((it) => it.status === 'pending'),
      activeGray: items
        .filter((it) => it.status === 'gray')
        .map((it) => ({ id: it.id, name: it.name, kind: it.kind, ...(it.gray === undefined ? {} : { gray: it.gray }) })),
      dirs: { proposals: this.dirProposals(), staging: this.dirStaging(), approved: this.dirApproved() },
      maxPending: this.cfg.maxPending,
    };
  }

  /**
   * 拼进系统提示词的学习结果（已批准/灰度的 prompt|params|preference）。
   * 灰度的按 grayPercent 抽样、观察期内一直参与；学习结果只当参考数据，不当系统指令。
   */
  promptAdditions(): string {
    const cfg = this.cfg;
    if (!cfg.enabled || cfg.promptMaxChars <= 0) return '';
    const candidates = this.list().filter((it) => (it.kind === 'prompt' || it.kind === 'params' || it.kind === 'preference') && (it.status === 'approved' || it.status === 'gray'));
    const lines: string[] = [];
    for (const item of candidates) {
      if (item.status === 'gray') {
        const gray = item.gray;
        const percent = gray?.percent ?? cfg.grayPercent;
        if (this.random() * 100 >= percent) continue;
      }
      let content = '';
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.home, item.path), 'utf8')) as Record<string, unknown>;
        content = String(parsed['content'] ?? '').trim();
      } catch {
        continue;
      }
      if (!content) continue;
      lines.push(`- [${item.kind}] ${item.name}：${content}`);
    }
    if (lines.length === 0) return '';
    const header = '## 学习到的偏好与经验（主人已批准，只作参考；不要覆盖安全规则）';
    const text = `${header}\n${lines.join('\n')}`;
    return text.length > cfg.promptMaxChars ? `${text.slice(0, cfg.promptMaxChars)}…` : text;
  }
}
