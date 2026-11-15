/**
 * 文件式工作区记忆：路径准入、文件读写、遍历、清单与检索。
 *
 * 移植来源：Coopanion vendor/cortico bots/cormini persona/memory.ts（MIT，Pal AI Lab，
 * commit 8362383）；保留了路径逃逸防护、原子写、清单折叠、glob/grep 这些核心形状，
 * 去掉了 blob 附件（petd 暂不做图片句柄）。见 docs/记忆移植来源.md。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { decodeText, fileFacts, isUtf16Le, readTextFile, retryBusy } from './util.js';

/** 对非指定目录的每个子目录最多列这么多项；余下折叠成一行计数。 */
export const LIST_DIR_CAP = 10;

/** 生成器文件名（点开头、.tmp- 中间产物）不进目录视图，也不允许直接写。 */
export function visibleEntry(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

/** 返回使用正斜杠、无冗余分隔的相对路径；保留开头的 `/`（由调用方拒绝）。 */
export function normalizeWorkspacePath(relPath: string): string {
  const raw = String(relPath ?? '').trim().replace(/\\/g, '/');
  const rooted = raw.startsWith('/');
  const normalized = raw
    .replace(/\/{2,}/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  return rooted ? `/${normalized}` : normalized;
}

const hiddenPathReason = (p: string, real?: string): string =>
  `点开头的路径（如 .git、.gitignore）由系统管理，不能写入、移动或删除：${p}${real ? `（实际位置 ${real}）` : ''}`;

/**
 * 写入工作区前的路径准入（所有写入口共用）：返回拒绝理由，null 表示可写。
 * 先按字符串拒绝 `..` 段和点开头的段；再按真实路径判断（realpathSync.native 展开
 * 8.3 短名、符号链接、junction），越出工作区或名字与盘上真实名不一致都拒绝。
 */
export function writeBlockReason(root: string, relPath: string): string | null {
  const p = normalizeWorkspacePath(relPath);
  const segments = p.split('/');
  if (segments.includes('..')) return `路径不能包含「..」：${p}`;
  if (segments.some((segment) => segment.startsWith('.'))) return hiddenPathReason(p);
  let existing = path.resolve(root, p);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let rel: string;
  try {
    rel = path.relative(realpathSync.native(root), realpathSync.native(existing));
  } catch {
    return `路径无法解析：${p}`;
  }
  const real = [...rel.split(path.sep).filter(Boolean), ...missing];
  if (path.isAbsolute(rel) || real.includes('..')) return `路径解析后越出了工作区：${p}`;
  if (real.some((segment) => segment.startsWith('.'))) return hiddenPathReason(p, real.join('/'));
  if (real.join('/') !== p) return `路径与盘上的真实名字不一致，请改用：${real.join('/')}`;
  return null;
}

/** 规范化后检查路径是否位于工作区内。 */
function insideWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, path.normalize(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new PetdError('E_BAD_PARAMS', `路径越出了工作区：${rel}`);
  }
  return abs;
}

/** glob → 正则；支持 `**`、`*`、`?`、`{a,b}`，按整条相对路径匹配。 */
export function globToRegExp(glob: string): RegExp {
  const escape = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) {
        re += '\\{';
        continue;
      }
      re += `(?:${glob.slice(i + 1, close).split(',').map(escape).join('|')})`;
      i = close;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

/** 目录项排序：目录在前，同类按名。 */
export function dirsFirst(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  return Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name);
}

function listDirLines(abs: string, prefix: string, full: boolean): string[] {
  const names = readdirSync(abs).sort().filter((name) => !name.startsWith('.'));
  const shown = full ? names : names.slice(0, LIST_DIR_CAP);
  const out: string[] = [];
  for (const name of shown) {
    const child = path.join(abs, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(child);
    if (st.isDirectory()) out.push(...listDirLines(child, rel, false));
    else out.push(`${rel} ${fileFacts(st.size, st.mtimeMs)}`);
  }
  if (names.length > shown.length) {
    out.push(`${prefix}/ … 共 ${names.length} 项，以上只列了前 ${shown.length} 项；用 dir 参数列出全部`);
  }
  return out;
}

function walkFilesAbs(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walkFilesAbs(abs, rel));
    else out.push(rel);
  }
  return out;
}

function entryType(abs: string): 'file' | 'dir' {
  return statSync(abs).isDirectory() ? 'dir' : 'file';
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

/** 检索命中的一份文件：整份行表 + 命中行号。 */
export interface GrepFileHit {
  path: string;
  lines: string[];
  hits: number[];
}

export interface WorkspaceMemoryOptions {
  /** 工作区目录 = 记忆；不存在则创建。 */
  dir: string;
}

/**
 * 工作区记忆本体。所有路径参数都是相对工作区的路径；绝对路径、`..`、
 * 点开头路径都被拒绝（写入另有真实路径校验）。
 */
export class WorkspaceMemory {
  /** 工作区根目录（绝对路径）。 */
  readonly dir: string;

  constructor(opts: WorkspaceMemoryOptions) {
    this.dir = path.resolve(opts.dir);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  // ── 初始化 ────────────────────────────────────────────────────────────

  /** 仅创建尚不存在的种子文件。 */
  seed(files: ReadonlyArray<readonly [string, string]>): void {
    for (const [rel, body] of files) {
      const abs = this.resolveSafe(rel);
      if (existsSync(abs)) continue;
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
  }

  /** 建目录骨架（只创建，不删除）。 */
  ensureDirs(dirs: readonly string[]): void {
    for (const d of dirs) {
      mkdirSync(path.join(this.dir, ...d.split('/').filter(Boolean)), { recursive: true });
    }
  }

  // ── 路径安全 ──────────────────────────────────────────────────────────

  normalize(relPath: string): string {
    return normalizeWorkspacePath(relPath);
  }

  /** 相对路径 → 绝对路径；拒绝盘符、绝对路径和任何 `..` 段。 */
  resolveSafe(relPath: string): string {
    const s = this.normalize(relPath);
    if (/^[a-zA-Z]:/.test(s) || s.startsWith('/') || path.isAbsolute(s)) {
      throw new PetdError('E_BAD_PARAMS', `只接受工作区内的相对路径，不接受绝对路径：${s}`);
    }
    if (s.split('/').some((seg) => seg === '..')) {
      throw new PetdError('E_BAD_PARAMS', `路径不能包含「..」，不允许离开工作区：${s}`);
    }
    const abs = path.resolve(this.dir, s);
    const rel = path.relative(this.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PetdError('E_BAD_PARAMS', `路径解析后越出了工作区：${s}`);
    }
    return abs;
  }

  private resolveWritable(relPath: string): string {
    const blocked = writeBlockReason(this.dir, relPath);
    if (blocked) throw new PetdError('E_BAD_PARAMS', blocked);
    return this.resolveSafe(relPath);
  }

  insideWorkspace(relPath: string): string {
    return insideWorkspace(this.dir, relPath);
  }

  exists(relPath: string): boolean {
    try {
      return existsSync(this.resolveSafe(relPath));
    } catch {
      return false;
    }
  }

  isDir(relPath: string): boolean {
    try {
      const abs = this.resolveSafe(relPath);
      return existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  // ── 读写 ──────────────────────────────────────────────────────────────

  readFile(relPath: string): string {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new PetdError('E_NOT_FOUND', `文件不存在：${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，用 memory.list 查看它`);
    }
    return readTextFile(abs);
  }

  /** 读二进制（附件 blob 用）；文本读取仍走 readFile。 */
  readBytes(relPath: string): Buffer {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new PetdError('E_NOT_FOUND', `文件不存在：${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，不能按文件读`);
    }
    return readFileSync(abs);
  }

  /** 二进制原子写（附件 blob 用）：同目录临时文件写完 rename。 */
  writeBytesAtomic(relPath: string, data: Buffer): void {
    const abs = this.resolveWritable(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，不能作为文件写入`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, data);
      retryBusy(() => renameSync(tmp, abs));
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 保留原始写入错误。
      }
      throw error;
    }
  }

  /** 同目录临时文件写完后 rename；失败时移除临时文件并抛出原始错误。 */
  writeFileAtomic(relPath: string, content: string): void {
    const abs = this.resolveWritable(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，不能作为文件写入`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, content, 'utf8');
      retryBusy(() => renameSync(tmp, abs));
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 保留原始写入错误。
      }
      throw error;
    }
  }

  /** 追加内容前保证现有文件以换行结尾；UTF-16 LE 的文件整份改写成 UTF-8。 */
  appendFile(relPath: string, content: string): void {
    const abs = this.resolveWritable(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，不能追加`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    let payload = content;
    if (existsSync(abs)) {
      const bytes = readFileSync(abs);
      const prev = decodeText(bytes);
      if (prev.length > 0 && !prev.endsWith('\n')) payload = '\n' + payload;
      if (isUtf16Le(bytes)) {
        this.writeFileAtomic(relPath, prev + payload);
        return;
      }
    }
    appendFileSync(abs, payload, 'utf8');
  }

  renameFile(fromRel: string, toRel: string): void {
    const from = this.resolveWritable(fromRel);
    const to = this.resolveWritable(toRel);
    if (!existsSync(from)) throw new PetdError('E_NOT_FOUND', `文件不存在：${this.normalize(fromRel)}`);
    if (statSync(from).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(fromRel)} 是目录，只能移动文件`);
    }
    if (existsSync(to)) {
      throw new PetdError('E_CONFLICT', `目标已存在：${this.normalize(toRel)}，换个名字或先删除它`);
    }
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
  }

  deleteFile(relPath: string): void {
    const abs = this.resolveWritable(relPath);
    if (!existsSync(abs)) throw new PetdError('E_NOT_FOUND', `文件不存在：${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是目录，只能删除文件`);
    }
    unlinkSync(abs);
  }

  /** 从 relPath 所在目录往上删空目录，到工作区根为止（根不删）。 */
  pruneEmptyDirs(relPath: string): void {
    let dir = path.dirname(this.resolveSafe(relPath));
    while (dir !== this.dir && dir.startsWith(this.dir + path.sep)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) return;
      rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  // ── 遍历 ──────────────────────────────────────────────────────────────

  /** 列出一层目录：目录在前并带尾部 `/`。 */
  listDir(relPath = ''): WorkspaceEntry[] {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new PetdError('E_NOT_FOUND', `目录不存在：${this.normalize(relPath) || '工作区根'}`);
    if (!statSync(abs).isDirectory()) {
      throw new PetdError('E_BAD_PARAMS', `${this.normalize(relPath)} 是文件，用 memory.read 读它`);
    }
    const prefix = path.relative(this.dir, abs).split(path.sep).filter(Boolean).join('/');
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => visibleEntry(e.name))
      .sort((a, b) => dirsFirst({ name: a.name, isDirectory: () => a.isDirectory() }, { name: b.name, isDirectory: () => b.isDirectory() }))
      .map((e) => {
        const childAbs = path.join(abs, e.name);
        const st = statSync(childAbs);
        return {
          name: e.name,
          path: prefix ? `${prefix}/${e.name}` : e.name,
          type: entryType(childAbs),
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      });
  }

  /** rel 之下每一个文件的工作区相对路径（含 rel 前缀）；点开头的整条跳过。 */
  walkFiles(rel = ''): string[] {
    const abs = this.insideWorkspace(rel || '.');
    const prefix = path.relative(this.dir, abs).split(path.sep).filter(Boolean).join('/');
    return walkFilesAbs(abs, prefix);
  }

  /** 完整列出 dir（空值为工作区根），各子目录最多显示 LIST_DIR_CAP 项。 */
  listing(dir = ''): string {
    const abs = this.insideWorkspace(dir || '.');
    if (!existsSync(abs)) return `[not found] ${dir}`;
    if (!statSync(abs).isDirectory()) return `[not a directory] ${dir}`;
    const rel = path.relative(this.dir, abs).split(path.sep).filter((s) => s !== '').join('/');
    const lines = listDirLines(abs, rel, true);
    if (lines.length === 0) return rel ? `${rel}/ 是空的。` : '工作区是空的。';
    return `工作区 ${rel ? `${rel}/` : '根目录'} 的文件：\n${lines.map((f) => `- ${f}`).join('\n')}`;
  }

  /** 整棵树的树枝图。 */
  tree(): string {
    const lines: string[] = ['workspace/'];
    const walk = (abs: string, prefix: string): void => {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => visibleEntry(e.name))
        .sort((a, b) => dirsFirst({ name: a.name, isDirectory: () => a.isDirectory() }, { name: b.name, isDirectory: () => b.isDirectory() }));
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        lines.push(prefix + (last ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(abs, e.name), prefix + (last ? '    ' : '│   '));
      });
    };
    walk(this.dir, '');
    return lines.join('\n');
  }

  /** 只渲染最外层直接子项，防止大型子目录占用常驻前缀。 */
  treeShallow(): string {
    const lines: string[] = ['workspace/'];
    for (const e of readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => visibleEntry(entry.name))
      .sort((a, b) => dirsFirst({ name: a.name, isDirectory: () => a.isDirectory() }, { name: b.name, isDirectory: () => b.isDirectory() }))) {
      lines.push(e.isDirectory() ? `${e.name}/` : e.name);
    }
    return lines.join('\n');
  }

  // ── 检索 ──────────────────────────────────────────────────────────────

  /** 按模式找文件（匹配整条相对路径），最近改过的在前；不以「双星斜杠」开头的模式会自动补上。 */
  globFiles(pattern: string, dir = ''): string[] {
    const re = globToRegExp(pattern.startsWith('**/') ? pattern : `**/${pattern}`);
    return this.walkFiles(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, mtime: statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  }

  /** 一份文件清单行尾的「(大小, 最后修改日期)」。 */
  facts(relPath: string): string {
    const st = statSync(path.join(this.dir, relPath));
    return fileFacts(st.size, st.mtimeMs);
  }

  /**
   * 从 path（文件或目录，空值为工作区）检索。match 可以是子串或正则。
   * 跳过含 NUL 的二进制文件与原子写临时文件；按 CRLF/LF 切行。
   */
  grep(opts: { match: string | RegExp; path?: string; filter?: RegExp | null }): GrepFileHit[] {
    const where = opts.path ?? '';
    const abs = this.insideWorkspace(where || '.');
    const files = statSync(abs).isDirectory()
      ? this.walkFiles(where)
      : [path.relative(this.dir, abs).split(path.sep).join('/')];
    const test = typeof opts.match === 'string'
      ? (line: string): boolean => line.includes(opts.match as string)
      : (line: string): boolean => (opts.match as RegExp).test(line);
    const out: GrepFileHit[] = [];
    for (const f of files) {
      if (opts.filter && !opts.filter.test(f)) continue;
      if (f.split('/').some((seg) => seg.includes('.tmp-'))) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(path.join(this.dir, f));
      } catch {
        continue;
      }
      const text = decodeText(buf);
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      const hits: number[] = [];
      lines.forEach((l, i) => {
        if (test(l)) hits.push(i);
      });
      if (hits.length === 0) continue;
      out.push({ path: f, lines, hits });
    }
    return out;
  }
}
