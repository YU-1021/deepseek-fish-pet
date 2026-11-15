/**
 * 钩子规则存储：内置「危险动作先确认」规则 + 用户自定义 allow/ask/deny 规则。
 *
 * 规则按 priority 升序匹配（数字越小越先），第一个命中的规则决定结果：
 *   - allow：放行（用户规则可以优先于内置 ask 规则做白名单）
 *   - ask：交给审批门，弹窗问用户
 *   - deny：直接拒绝
 *
 * 落盘 home/state/hooks.json；文件坏了不覆盖原文件，按内置规则启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { argsInclude, matchAnyName } from './match.js';
import type { HookAction, HookContext, HookKind, HookMatchResult, HookRule } from './types.js';

export interface HookStoreOptions {
  file: string;
  logger?: (msg: string, data?: Record<string, unknown>) => void;
  publish?: (event: string, data?: unknown) => void;
}

export interface HookRuleInput {
  id?: string;
  description?: string;
  enabled?: boolean;
  kind: HookKind;
  names: string[];
  action: HookAction;
  message?: string;
  argContains?: string;
  priority?: number;
}

interface HookFile {
  version: number;
  rules: HookRule[];
}

const FILE_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_NAMES = 20;
const MAX_PATTERN_LEN = 80;
const MAX_DESCRIPTION = 120;
const MAX_MESSAGE = 300;
const MAX_ARG_CONTAINS = 200;
const USER_PRIORITY = 10;
const BUILTIN_PRIORITY = 100;

/** 内置规则：危险/不可逆动作先问一句。用户规则 priority 默认 10，可覆盖它们。 */
export const BUILTIN_RULES: readonly HookRule[] = [
  {
    id: 'method-memory-delete',
    description: '删除工作区记忆文件',
    enabled: true,
    kind: 'method',
    names: ['memory.delete'],
    action: 'ask',
    message: '要删除一个记忆文件，删了就找不回来了',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-memory-move',
    description: '移动/改名工作区记忆文件',
    enabled: true,
    kind: 'method',
    names: ['memory.move'],
    action: 'ask',
    message: '要移动或改名一个记忆文件',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-blob-delete',
    description: '删除一个附件',
    enabled: true,
    kind: 'method',
    names: ['blob.delete'],
    action: 'ask',
    message: '要删除一个附件',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-skill-delete',
    description: '删除一个技能',
    enabled: true,
    kind: 'method',
    names: ['skill.delete'],
    action: 'ask',
    message: '要删除一个技能',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-plugin-disable',
    description: '停用一个插件',
    enabled: true,
    kind: 'method',
    names: ['plugin.disable'],
    action: 'ask',
    message: '要停用一个插件',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-session-delete',
    description: '删除一段聊天会话',
    enabled: true,
    kind: 'method',
    names: ['session.delete'],
    action: 'ask',
    message: '要删除一整段聊天会话',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'method-automation-delete',
    description: '删除一个自主任务',
    enabled: true,
    kind: 'method',
    names: ['automation.delete'],
    action: 'ask',
    message: '要删除一个自主任务',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'tool-file-delete',
    description: '删工作区文件（模型工具）',
    enabled: true,
    kind: 'tool',
    names: ['delete_file'],
    action: 'ask',
    message: '模型要删除一个工作区文件',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
  {
    id: 'tool-file-move',
    description: '移动/改名工作区文件（模型工具）',
    enabled: true,
    kind: 'tool',
    names: ['move_file'],
    action: 'ask',
    message: '模型要移动或改名一个工作区文件',
    priority: BUILTIN_PRIORITY,
    builtin: true,
  },
];

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describeRule(rule: HookRule): string {
  if (rule.action === 'deny') return rule.message ?? `规则「${rule.description || rule.id}」禁止了这个操作`;
  return rule.message ?? (rule.description || `这个操作需要确认（${rule.id}）`);
}

function normalizeNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NAMES) {
    throw new PetdError('E_BAD_PARAMS', `names 必须是 1–${MAX_NAMES} 个字符串`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new PetdError('E_BAD_PARAMS', 'names 里每一项都必须是字符串');
    const t = item.trim();
    if (t === '' || t.length > MAX_PATTERN_LEN) throw new PetdError('E_BAD_PARAMS', `名字模式必须是 1–${MAX_PATTERN_LEN} 个字符`);
    out.push(t);
  }
  return out;
}

function normalizeRule(raw: Record<string, unknown>, fallbackId: string): HookRule {
  const kind = raw['kind'];
  if (kind !== 'tool' && kind !== 'method') throw new PetdError('E_BAD_PARAMS', 'kind 必须是 tool 或 method');
  const action = raw['action'];
  if (action !== 'allow' && action !== 'ask' && action !== 'deny') {
    throw new PetdError('E_BAD_PARAMS', 'action 必须是 allow、ask 或 deny');
  }
  const idRaw = raw['id'];
  const id = typeof idRaw === 'string' && idRaw.trim() !== '' ? idRaw.trim() : fallbackId;
  if (!ID_RE.test(id)) throw new PetdError('E_BAD_PARAMS', `规则 id 不合法：${id}（小写字母/数字/短横线，最长 41）`);
  const description = typeof raw['description'] === 'string' ? raw['description'].trim().slice(0, MAX_DESCRIPTION) : '';
  const message = typeof raw['message'] === 'string' ? raw['message'].trim().slice(0, MAX_MESSAGE) : undefined;
  const argContains = typeof raw['argContains'] === 'string' ? raw['argContains'].slice(0, MAX_ARG_CONTAINS) : undefined;
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true;
  const priorityRaw = raw['priority'];
  const priority =
    typeof priorityRaw === 'number' && Number.isInteger(priorityRaw) && priorityRaw >= 0 && priorityRaw <= 1000
      ? priorityRaw
      : USER_PRIORITY;
  return {
    id,
    description: description === '' ? id : description,
    enabled,
    kind,
    names: normalizeNames(raw['names']),
    action,
    ...(message === undefined ? {} : { message }),
    ...(argContains === undefined || argContains === '' ? {} : { argContains }),
    priority,
    ...(raw['builtin'] === true ? { builtin: true } : {}),
  };
}

export class HookStore {
  private rules: HookRule[] = [];
  private loaded = false;

  constructor(private readonly opts: HookStoreOptions) {}

  /** 首次启动播种内置规则；文件坏了保留原文件、内存用内置。 */
  ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.opts.file, 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      this.rules = BUILTIN_RULES.map((r) => ({ ...r, names: [...r.names] }));
      this.save();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed) || !Array.isArray(parsed['rules'])) throw new Error('缺少 rules 数组');
      const kept: HookRule[] = [];
      for (const raw of parsed['rules']) {
        if (!isObject(raw)) continue;
        try {
          kept.push(normalizeRule(raw, `rule-${kept.length}`));
        } catch (e) {
          this.opts.logger?.('hooks: 跳过坏规则', { error: e instanceof Error ? e.message : String(e) });
        }
      }
      this.rules = kept;
    } catch (e) {
      this.opts.logger?.('hooks: 规则文件解析失败，用内置规则启动（原文件未改）', {
        error: e instanceof Error ? e.message : String(e),
      });
      this.rules = BUILTIN_RULES.map((r) => ({ ...r, names: [...r.names] }));
    }
  }

  list(): HookRule[] {
    this.ensure();
    return [...this.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  get(id: string): HookRule | null {
    this.ensure();
    return this.rules.find((r) => r.id === id) ?? null;
  }

  create(input: HookRuleInput): HookRule {
    this.ensure();
    const id = input.id?.trim() || `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (this.rules.some((r) => r.id === id)) throw new PetdError('E_CONFLICT', `规则 ${id} 已存在`);
    const rule = normalizeRule({ ...input, id }, id);
    this.rules.push(rule);
    this.save();
    this.opts.publish?.('hooks.changed', { action: 'created', rule });
    return rule;
  }

  update(id: string, patch: Partial<HookRuleInput>): HookRule {
    this.ensure();
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new PetdError('E_NOT_FOUND', `规则不存在：${id}`);
    const current = this.rules[idx]!;
    const merged = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      id,
    } as Record<string, unknown>;
    const rule = normalizeRule(merged, id);
    this.rules[idx] = rule;
    this.save();
    this.opts.publish?.('hooks.changed', { action: 'updated', rule });
    return rule;
  }

  toggle(id: string, enabled: boolean): HookRule {
    return this.update(id, { enabled });
  }

  remove(id: string): boolean {
    this.ensure();
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    const [removed] = this.rules.splice(idx, 1);
    this.save();
    this.opts.publish?.('hooks.changed', { action: 'deleted', rule: removed });
    return true;
  }

  /** 第一个命中的启用规则决定结果；没有规则命中 → allow（无规则即放行）。 */
  evaluate(ctx: HookContext): HookMatchResult {
    for (const rule of this.list()) {
      if (!rule.enabled) continue;
      if (rule.kind !== ctx.kind) continue;
      if (!matchAnyName(rule.names, ctx.name)) continue;
      if (rule.argContains !== undefined && !argsInclude(ctx.args, rule.argContains)) continue;
      return { action: rule.action, rule, message: describeRule(rule) };
    }
    return { action: 'allow', rule: null, message: '' };
  }

  private save(): void {
    const file: HookFile = { version: FILE_VERSION, rules: this.rules };
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
    const tmp = this.opts.file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.opts.file);
  }
}
