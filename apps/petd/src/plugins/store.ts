/**
 * 插件（plugin）系统：一个插件 = home/plugins/<id>/ 目录 + plugin.json 清单。
 *
 * 第一版插件是**声明式**的，不执行任意 JS（安全优先）：
 * - `skills/` 目录：贡献技能（格式同工作区 SKILL.md），只有插件启用时可见；
 * - `prompt.md`：额外系统提示词段（用于写作风格、领域知识这类纯文本能力）；
 * - plugin.json：{ id?, name, version, description, author?, prompt?, skills? }。
 *
 * 启用状态单独存 home/state/plugins.json（默认启用，disable 持久化），
 * 插件目录本身是可整体拷进/拷出的只读资产。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';

const MANIFEST_FILE = 'plugin.json';
const DEFAULT_SKILLS_DIR = 'skills';
const DEFAULT_PROMPT_FILE = 'prompt.md';
const MANIFEST_MAX_BYTES = 64 * 1024;
const PROMPT_MAX_CHARS = 2000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
}

export interface PluginInfo extends PluginManifest {
  dir: string;
  enabled: boolean;
  /** 贡献的技能个数 */
  skillCount: number;
  /** 是否有 prompt.md 额外提示词 */
  hasPrompt: boolean;
}

export interface PluginStoreLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface PluginStoreOptions {
  /** 插件根目录（绝对路径） */
  dir: string;
  /** 启用状态文件（绝对路径） */
  stateFile: string;
  logger?: PluginStoreLogger;
  publish?: (event: string, data?: unknown) => void;
}

interface PluginState {
  version: 1;
  /** 被明确停用的插件 id（默认启用） */
  disabled: string[];
}

export function isSafePluginId(id: unknown): id is string {
  return typeof id === 'string' && NAME_RE.test(id) && id.length <= 64;
}

/** 解析并校验 plugin.json；非法返回 error 文本（不抛错，扫描时跳过并记日志） */
export function parsePluginManifest(text: string, dirName: string): { manifest?: PluginManifest; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'plugin.json 不是合法 JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'plugin.json 必须是对象' };
  }
  const obj = raw as Record<string, unknown>;
  const id = obj['id'] === undefined ? dirName : obj['id'];
  if (!isSafePluginId(id)) return { error: `插件 id 非法：${String(id)}` };
  if (id !== dirName) return { error: `插件 id（${id}）必须和目录名（${dirName}）一致` };
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  const version = typeof obj['version'] === 'string' ? obj['version'].trim() : '';
  const description = typeof obj['description'] === 'string' ? obj['description'].trim() : '';
  if (!name) return { error: '插件缺少 name' };
  if (!version) return { error: '插件缺少 version' };
  if (!description) return { error: '插件缺少 description' };
  const author = typeof obj['author'] === 'string' ? obj['author'].trim() : undefined;
  return { manifest: { id, name, version, description, ...(author ? { author } : {}) } };
}

export class PluginStore {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly logger?: PluginStoreLogger;
  private readonly publish?: (event: string, data?: unknown) => void;
  private state: PluginState = { version: 1, disabled: [] };

  constructor(opts: PluginStoreOptions) {
    this.root = opts.dir;
    this.stateFile = opts.stateFile;
    this.logger = opts.logger;
    this.publish = opts.publish;
  }

  get dir(): string {
    return this.root;
  }

  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    this.loadState();
  }

  list(): PluginInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: PluginInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const info = this.readPlugin(entry.name);
      if (info) out.push(info);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  get(id: string): PluginInfo {
    if (!isSafePluginId(id)) throw new PetdError('E_BAD_PARAMS', `插件 id 非法：${id}`);
    const info = this.readPlugin(id);
    if (!info) throw new PetdError('E_NOT_FOUND', `没有这个插件：${id}`);
    return info;
  }

  enable(id: string): PluginInfo {
    const info = this.get(id);
    if (this.isDisabled(id)) {
      this.state.disabled = this.state.disabled.filter((x) => x !== id);
      this.saveState();
      this.publish?.('plugin.changed', { id, enabled: true });
      this.logger?.info('插件已启用', { id });
    }
    return { ...info, enabled: true };
  }

  disable(id: string): PluginInfo {
    const info = this.get(id);
    if (!this.isDisabled(id)) {
      this.state.disabled = [...this.state.disabled, id];
      this.saveState();
      this.publish?.('plugin.changed', { id, enabled: false });
      this.logger?.info('插件已停用', { id });
    }
    return { ...info, enabled: false };
  }

  isEnabled(id: string): boolean {
    return !this.isDisabled(id);
  }

  /** 启用插件的技能根目录（给 SkillStore.extraRoots 用） */
  enabledSkillRoots(): Array<{ pluginId: string; dir: string }> {
    const out: Array<{ pluginId: string; dir: string }> = [];
    for (const info of this.list()) {
      if (!info.enabled || info.skillCount === 0) continue;
      out.push({ pluginId: info.id, dir: path.join(info.dir, DEFAULT_SKILLS_DIR) });
    }
    return out;
  }

  /** 启用插件的额外提示词（prompt.md），拼成一段返回；没有则空串 */
  prompt(): string {
    const blocks: string[] = [];
    for (const info of this.list()) {
      if (!info.enabled || !info.hasPrompt) continue;
      const file = this.promptFileOf(info);
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text.length === 0) continue;
        const trimmed = text.length > PROMPT_MAX_CHARS ? text.slice(0, PROMPT_MAX_CHARS - 1) + '…' : text;
        blocks.push(`## 插件：${info.name}\n\n${trimmed}`);
      } catch {
        continue;
      }
    }
    return blocks.join('\n\n');
  }

  private readPlugin(id: string): PluginInfo | undefined {
    const dir = path.join(this.root, id);
    const file = path.join(dir, MANIFEST_FILE);
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MANIFEST_MAX_BYTES) {
        this.logger?.warn('插件清单过大，已跳过', { id, size: stat.size });
        return undefined;
      }
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const { manifest, error } = parsePluginManifest(text, id);
    if (!manifest) {
      this.logger?.warn('插件清单非法，已跳过', { id, error });
      return undefined;
    }
    const skillsDir = path.join(dir, DEFAULT_SKILLS_DIR);
    const skillCount = countSkillDirs(skillsDir);
    const hasPrompt = fs.existsSync(this.promptFileOf({ ...manifest, dir }));
    return { ...manifest, dir, enabled: this.isEnabled(id), skillCount, hasPrompt };
  }

  private promptFileOf(info: { dir: string }): string {
    return path.join(info.dir, DEFAULT_PROMPT_FILE);
  }

  private isDisabled(id: string): boolean {
    return this.state.disabled.includes(id);
  }

  private loadState(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as unknown;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        const disabled = Array.isArray(obj['disabled'])
          ? obj['disabled'].filter((x): x is string => typeof x === 'string' && isSafePluginId(x))
          : [];
        this.state = { version: 1, disabled };
        return;
      }
    } catch {
      /* 文件不存在或坏了：用默认（全部启用） */
    }
    this.state = { version: 1, disabled: [] };
  }

  private saveState(): void {
    const tmp = `${this.stateFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }
}

function countSkillDirs(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      if (fs.statSync(path.join(dir, entry.name, 'SKILL.md')).isFile()) count += 1;
    } catch {
      /* 不是技能 */
    }
  }
  return count;
}
