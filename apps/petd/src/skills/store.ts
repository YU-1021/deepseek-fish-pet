/**
 * 技能（skill）系统：一个技能 = 一个目录里的 SKILL.md。
 *
 * SKILL.md 结构（YAML frontmatter + Markdown 正文）：
 *   ---
 *   name: 早安
 *   description: 主人早上第一次说话时，用更有精神的方式打招呼
 *   keywords: [早上, 早安, 起床]
 *   always: false
 *   ---
 *   这里是正文：什么情况下用、按什么步骤做、有什么注意事项。
 *
 * 设计要点：
 * - 技能分两类来源：工作区技能（home/skills/<name>/SKILL.md）与插件贡献的技能
 *   （home/plugins/<plugin>/skills/<name>/SKILL.md，只有插件启用时才可见）。
 * - 系统提示词里只放「清单 + 常驻技能正文」，正文按 promptMaxChars 预算截断；
 *   其余技能由模型用聊天工具 load_skill 按需读取，避免把上下文撑爆。
 * - 插件技能的名字带插件前缀（`pluginId/skill`），避免重名；工作区技能只允许
 *   字母数字下划线连字符的安全名字，防止路径穿越。
 * - 本模块只做文件与提示词，不执行任何代码；插件也不跑任意 JS（先做声明式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';

/** 技能目录里的固定文件名 */
const SKILL_FILE = 'SKILL.md';
/** 技能名：安全字符，避免路径穿越 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_CHARS = 20;
const MAX_BODY_CHARS = 20_000;
/** 清单里每条技能占用的上限（防止一条描述撑爆预算） */
const MAX_LIST_ITEM_CHARS = 180;

export type SkillSource = 'workspace' | 'plugin';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  keywords?: string[];
  always?: boolean;
}

export interface ParsedSkill {
  meta: SkillFrontmatter;
  body: string;
  warnings: string[];
}

export interface SkillInfo {
  /** 唯一键：工作区技能是 name，插件技能是 `pluginId/name` */
  key: string;
  name: string;
  description: string;
  keywords: string[];
  /** true = 正文直接注入系统提示词（适合短小的行为约定） */
  always: boolean;
  source: SkillSource;
  pluginId?: string;
  /** 正文长度（字符） */
  bodyChars: number;
  updatedAt: string;
}

export interface SkillContent extends SkillInfo {
  body: string;
}

export interface SkillCreateInput {
  name: string;
  description?: string;
  body: string;
  keywords?: string[];
  always?: boolean;
}

export interface SkillUpdateInput {
  description?: string;
  body?: string;
  keywords?: string[];
  always?: boolean;
}

export interface SkillStoreLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface SkillExtraRoot {
  pluginId: string;
  /** 插件贡献技能的根目录（里面每个子目录一份 SKILL.md） */
  dir: string;
}

export interface SkillStoreOptions {
  /** 工作区技能根目录（绝对路径） */
  dir: string;
  /** 提示词预算（字符） */
  promptMaxChars: number;
  logger?: SkillStoreLogger;
  /** 额外技能根（插件）；每次扫描时现取，插件开关立即生效 */
  extraRoots?: () => SkillExtraRoot[];
}

export function isSafeSkillName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && name.length <= MAX_NAME_CHARS;
}

/** 解析 ```[frontmatter] + 正文```；容忍缺 frontmatter（整段当正文） */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const warnings: string[] = [];
  const meta: SkillFrontmatter = {};
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      warnings.push('frontmatter 没有结束（缺 ---），整段按正文处理');
    } else {
      bodyStart = end + 1;
      for (let i = 1; i < end; i++) {
        const line = lines[i] ?? '';
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        let value = line.slice(colon + 1).trim();
        if (value.length === 0) continue;
        if (key === 'name' || key === 'description') {
          value = stripQuotes(value);
          if (key === 'name') meta.name = value;
          else meta.description = value;
        } else if (key === 'always') {
          meta.always = value.toLowerCase() === 'true';
        } else if (key === 'keywords' || key === 'tags') {
          meta.keywords = splitList(value);
        }
      }
    }
  } else if (normalized.trim().length > 0) {
    warnings.push('缺少 frontmatter（第一行应为 ---），整段按正文处理');
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  return { meta, body, warnings };
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitList(value: string): string[] {
  const raw = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return raw
    .split(/[,，、]/)
    .map((x) => stripQuotes(x.trim()))
    .filter((x) => x.length > 0);
}

/** 渲染成 SKILL.md 文本（写盘用） */
export function buildSkillMarkdown(input: {
  name: string;
  description: string;
  keywords: string[];
  always: boolean;
  body: string;
}): string {
  const lines = ['---', `name: ${input.name}`];
  if (input.description) lines.push(`description: ${input.description}`);
  if (input.keywords.length > 0) lines.push(`keywords: [${input.keywords.join(', ')}]`);
  lines.push(`always: ${input.always ? 'true' : 'false'}`, '---', '', input.body.trim(), '');
  return lines.join('\n');
}

export class SkillStore {
  private readonly root: string;
  private readonly promptMaxChars: number;
  private readonly logger?: SkillStoreLogger;
  private readonly extraRoots?: () => SkillExtraRoot[];

  constructor(opts: SkillStoreOptions) {
    this.root = opts.dir;
    this.promptMaxChars = Math.max(500, Math.floor(opts.promptMaxChars));
    this.logger = opts.logger;
    this.extraRoots = opts.extraRoots;
  }

  get dir(): string {
    return this.root;
  }

  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 全量扫描（工作区 + 启用插件的技能根） */
  list(): SkillInfo[] {
    const found: SkillInfo[] = [];
    this.scanRoot(this.root, 'workspace', undefined, found);
    for (const extra of this.extraRoots?.() ?? []) {
      if (!path.isAbsolute(extra.dir)) continue;
      if (!fs.existsSync(extra.dir)) continue;
      this.scanRoot(extra.dir, 'plugin', extra.pluginId, found);
    }
    found.sort((a, b) => a.key.localeCompare(b.key));
    return found;
  }

  get(key: string): SkillContent {
    const wanted = normalizeSkillKey(key);
    const info = this.list().find((s) => s.key === wanted);
    if (!info) throw new PetdError('E_NOT_FOUND', `没有这个技能：${key}`);
    const text = fs.readFileSync(this.fileOf(info), 'utf8');
    const parsed = parseSkillMarkdown(text);
    return { ...info, body: parsed.body };
  }

  create(input: SkillCreateInput): SkillInfo {
    if (!isSafeSkillName(input.name)) {
      throw new PetdError('E_BAD_PARAMS', '技能名只能用字母、数字、下划线、连字符（1–64 字符）');
    }
    const dir = path.join(this.root, input.name);
    if (fs.existsSync(dir)) throw new PetdError('E_CONFLICT', `技能已存在：${input.name}`);
    const description = normalizeDescription(input.description);
    const keywords = normalizeKeywords(input.keywords);
    const body = normalizeBody(input.body);
    this.ensure();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SKILL_FILE);
    writeFileAtomic(file, buildSkillMarkdown({ name: input.name, description, keywords, always: input.always === true, body }));
    return this.get(input.name);
  }

  update(name: string, patch: SkillUpdateInput): SkillInfo {
    const current = this.get(name);
    if (current.source !== 'workspace') {
      throw new PetdError('E_FORBIDDEN', `插件技能不能直接改：${name}`);
    }
    const description = patch.description === undefined ? current.description : normalizeDescription(patch.description);
    const keywords = patch.keywords === undefined ? current.keywords : normalizeKeywords(patch.keywords);
    const always = patch.always === undefined ? current.always : patch.always === true;
    const body = patch.body === undefined ? current.body : normalizeBody(patch.body);
    writeFileAtomic(
      this.fileOf(current),
      buildSkillMarkdown({ name: current.name, description, keywords, always, body })
    );
    return this.get(current.name);
  }

  remove(name: string): void {
    const current = this.get(name);
    if (current.source !== 'workspace') {
      throw new PetdError('E_FORBIDDEN', `插件技能不能删：${name}`);
    }
    fs.rmSync(path.dirname(this.fileOf(current)), { recursive: true, force: true });
  }

  /**
   * 拼进系统提示词的技能段：清单 + 常驻技能正文，总量不超过 promptMaxChars。
   * 没有技能时返回空串。
   */
  prompt(): string {
    const skills = this.list();
    if (skills.length === 0) return '';
    const parts: string[] = ['## 可用技能'];
    parts.push('需要用到某个技能时，先用 `load_skill` 读取它的完整说明，再按说明做；不要凭名字猜内容。');
    const lines: string[] = [];
    for (const skill of skills) {
      if (skill.always) continue;
      const suffix = skill.keywords.length > 0 ? `（关键词：${skill.keywords.join('、')}）` : '';
      const line = `- ${skill.key}：${skill.description || '（无描述）'}${suffix}`;
      lines.push(trimText(line, MAX_LIST_ITEM_CHARS));
    }
    if (lines.length > 0) parts.push(lines.join('\n'));
    let used = parts.join('\n\n').length;
    const always = skills.filter((s) => s.always);
    if (always.length > 0 && used < this.promptMaxChars) {
      const blocks: string[] = [];
      for (const skill of always) {
        const head = `### 常驻技能：${skill.key}\n`;
        const content = this.get(skill.key);
        const room = this.promptMaxChars - used - head.length;
        if (room < 80) break;
        const body = trimText(content.body, room);
        blocks.push(head + body);
        used += head.length + body.length + 2;
      }
      if (blocks.length > 0) parts.push(blocks.join('\n\n'));
      if (blocks.length < always.length) parts.push('（还有常驻技能因提示词预算没有注入，需要时用 load_skill 读）');
    }
    return parts.join('\n\n');
  }

  private fileOf(info: SkillInfo): string {
    if (info.source === 'workspace') return path.join(this.root, info.name, SKILL_FILE);
    const root = (this.extraRoots?.() ?? []).find((r) => r.pluginId === info.pluginId);
    if (!root) throw new PetdError('E_NOT_FOUND', `插件的技能目录不存在了：${info.key}`);
    return path.join(root.dir, info.name, SKILL_FILE);
  }

  private scanRoot(root: string, source: SkillSource, pluginId: string | undefined, out: SkillInfo[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(root, entry.name, SKILL_FILE);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillMarkdown(text);
      for (const w of parsed.warnings) {
        this.logger?.warn(`技能 ${entry.name} 解析提醒`, { file, warning: w });
      }
      // 技能身份 = 目录名（frontmatter 里的 name 只作展示，不参与寻址），避免同名前缀互相覆盖
      const name = entry.name;
      if (!isSafeSkillName(name)) {
        this.logger?.warn('技能目录名非法，已跳过', { file, name: entry.name });
        continue;
      }
      let updatedAt = new Date(0).toISOString();
      try {
        updatedAt = fs.statSync(file).mtime.toISOString();
      } catch {
        /* 忽略 */
      }
      out.push({
        key: pluginId === undefined ? name : `${pluginId}/${name}`,
        name,
        description: normalizeDescription(parsed.meta.description),
        keywords: normalizeKeywords(parsed.meta.keywords),
        always: parsed.meta.always === true,
        source,
        ...(pluginId === undefined ? {} : { pluginId }),
        bodyChars: parsed.body.length,
        updatedAt,
      });
    }
  }
}

/** 把 `plugin/skill` 或 `skill` 规范成查询键 */
export function normalizeSkillKey(key: string): string {
  return key.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeDescription(v: string | undefined): string {
  const text = (v ?? '').replace(/\s+/g, ' ').trim();
  return trimText(text, MAX_DESCRIPTION_CHARS);
}

function normalizeKeywords(v: string[] | undefined): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const word = item.trim();
    if (word.length === 0 || word.length > MAX_KEYWORD_CHARS) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function normalizeBody(v: string): string {
  const text = String(v ?? '');
  if (text.trim().length === 0) throw new PetdError('E_BAD_PARAMS', '技能正文不能为空');
  if (text.length > MAX_BODY_CHARS) throw new PetdError('E_BAD_PARAMS', `技能正文太长（上限 ${MAX_BODY_CHARS} 字）`);
  return text.trim();
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  return text.slice(0, maxChars - 1) + '…';
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
