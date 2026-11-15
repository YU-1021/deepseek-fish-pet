/**
 * 工作区附件（blob）：图片/文件等二进制内容存在 `workspace/blobs/` 下，不进 Git 历史，靠句柄引用。
 *
 * 形状参考 Cormini 的 WorkspaceBlobStore / save_blob（MIT，Pal AI Lab，commit 8362383），
 * 改造点：内容寻址（文件名 = sha256 前 16 位 + 可读 slug + 扩展名）、加大小上限、句柄统一为 `blob:<文件名>`。
 * 移植说明见 docs/记忆移植来源.md。
 */
import { createHash } from 'node:crypto';
import { PetdError } from '@petd/protocol';
import { decodeText } from './util.js';
import type { WorkspaceMemory } from './store.js';

/** 附件都放在工作区这个子目录（在 Git 里被忽略） */
export const BLOB_DIR = 'blobs';
/** 单个附件大小上限：8MB（WS 一帧 base64 后约 11MB，够用） */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** 句柄前缀 */
export const BLOB_HANDLE_PREFIX = 'blob:';
/** 句柄里 slug 的最大长度 */
const MAX_SLUG_CHARS = 40;
/** 文件名里 slug 外的扩展名最大长度 */
const MAX_EXT_CHARS = 8;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/jsonl',
  ndjson: 'application/jsonl',
  csv: 'text/csv',
  log: 'text/plain',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/jsonl': 'jsonl',
  'text/csv': 'csv',
  'application/yaml': 'yaml',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
};

/** 能当文本直接读的 MIME（read_blob 用） */
const TEXT_MIMES = new Set([
  'application/json',
  'application/jsonl',
  'application/xml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-ndjson',
  'application/x-yaml',
]);

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'csv', 'log', 'yml', 'yaml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'xml', 'svg', 'ini', 'toml', 'conf', 'bat', 'ps1', 'sh']);

/** 附件大类：UI 用来决定怎么预览（图片缩略图 / 文本摘录 / 音视频播放器 / 普通文件） */
export type BlobKind = 'image' | 'audio' | 'video' | 'text' | 'binary';

/** 图片尺寸（从文件头嗅探，不解码整张图） */
export interface ImageSize {
  width: number;
  height: number;
}

/** 嗅探图片尺寸时最多读多少字节（JPEG 的 SOF 段可能靠后一点） */
const HEAD_SNIFF_BYTES = 256 * 1024;

/** MIME → 大类 */
export function blobKindOf(mime: string): BlobKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (isTextMime(m)) return 'text';
  return 'binary';
}

/**
 * 从文件头嗅探图片宽高（PNG/JPEG/GIF/WebP/BMP/SVG 的 viewBox 不做）。
 * 只读文件头、不做完整解码；认不出返回 null。
 */
export function sniffImageSize(head: Buffer, mime: string): ImageSize | null {
  const m = mime.toLowerCase();
  try {
    if (m === 'image/png' && head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (m === 'image/gif' && head.length >= 10) {
      const sig = head.subarray(0, 6).toString('ascii');
      if (sig === 'GIF87a' || sig === 'GIF89a') {
        return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
      }
    }
    if (m === 'image/bmp' && head.length >= 26 && head.subarray(0, 2).toString('ascii') === 'BM') {
      return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) };
    }
    if (m === 'image/webp' && head.length >= 30 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
      const chunk = head.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8 ') {
        return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && head.length >= 25) {
        const bits = head.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && head.length >= 30) {
        return {
          width: head.readUIntLE(24, 3) + 1,
          height: head.readUIntLE(27, 3) + 1,
        };
      }
      return null;
    }
    if (m === 'image/jpeg' && head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < head.length) {
        if (head[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = head[offset + 1] ?? 0;
        // SOF0~SOF15（排除 DHT=C4、JPG=C8、DAC=CC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const len = head.readUInt16BE(offset + 2);
        if (len < 2) return null;
        offset += 2 + len;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}


export interface BlobMeta {
  /** 统一句柄：`blob:<文件名>` */
  handle: string;
  /** 工作区相对路径：`blobs/<文件名>` */
  path: string;
  /** 文件名（不含路径） */
  name: string;
  mime: string;
  /** UI 预览用的大类 */
  kind: BlobKind;
  /** 图片的宽高（非图片或识别失败时缺省） */
  image?: ImageSize;
  size: number;
  sha256: string;
  /** 落盘时间（ISO） */
  createdAt: string;
}

/** 附件预览结果：文本给摘录，图片给尺寸（字节由 blob.get 取），其余只给元数据 */
export interface BlobPreview {
  meta: BlobMeta;
  /** 文本摘录（kind === 'text' 时存在） */
  text?: string;
  /** 文本是否被截断 */
  truncated?: boolean;
}

/** 预览文本默认/最大字符数 */
export const PREVIEW_TEXT_DEFAULT_CHARS = 2000;
export const PREVIEW_TEXT_MAX_CHARS = 20000;

export interface BlobPutInput {
  data: Buffer;
  /** 原始文件名，用来推断 MIME 与可读 slug（可选） */
  name?: string;
  /** 显式 MIME（优先于文件名推断） */
  mime?: string;
}

/** 这个 MIME 是否可按文本读取 */
export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || TEXT_MIMES.has(mime);
}

/** 文件名 → MIME；认不出就 application/octet-stream */
export function inferMime(name: string, mime?: string): string {
  const explicit = (mime ?? '').trim().toLowerCase();
  if (explicit !== '') return explicit;
  const ext = extOfName(name);
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** MIME → 扩展名 */
export function extForMime(mime: string): string {
  const mapped = EXT_BY_MIME[mime.toLowerCase()];
  if (mapped) return mapped;
  if (mime.startsWith('text/')) return 'txt';
  return 'bin';
}

/** 文件句柄（给模型的统一写法） */
export function blobHandle(fileName: string): string {
  return BLOB_HANDLE_PREFIX + fileName;
}

/** 把 `blob:<name>` / `blobs/<name>` / `<name>` 统一成 blobs/ 下的文件名；非法形式抛 E_BAD_PARAMS */
export function blobFileNameFromRef(ref: string): string {
  const raw = (ref ?? '').trim();
  if (raw === '') throw new PetdError('E_BAD_PARAMS', '附件引用不能为空');
  let name = raw;
  if (name.startsWith(BLOB_HANDLE_PREFIX)) name = name.slice(BLOB_HANDLE_PREFIX.length);
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith(`${BLOB_DIR}/`)) name = normalized.slice(BLOB_DIR.length + 1);
  if (name === '' || name.includes('/') || name.includes('..') || name.startsWith('.')) {
    throw new PetdError('E_BAD_PARAMS', `不是合法的附件引用：${raw}`);
  }
  return name;
}

function extOfName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length <= MAX_EXT_CHARS && /^[a-z0-9]+$/.test(ext) ? ext : '';
}

function slugify(name: string): string {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.[^.]*$/, '');
  const cleaned = base
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, MAX_SLUG_CHARS) || 'file';
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 工作区附件存储：内容寻址 + 句柄解析。自身不做 Git 提交（blobs/ 被忽略）。 */
export class BlobStore {
  private readonly memory: WorkspaceMemory;

  constructor(memory: WorkspaceMemory) {
    this.memory = memory;
  }

  /** 确保 blobs/ 存在（可重复调用） */
  ensure(): void {
    this.memory.ensureDirs([BLOB_DIR]);
  }

  /** 存一个附件：同内容同 slug 会复用已有文件；返回句柄与元数据。 */
  put(input: BlobPutInput): BlobMeta {
    const data = input.data;
    if (data.length === 0) throw new PetdError('E_BAD_PARAMS', '附件内容为空');
    if (data.length > MAX_BLOB_BYTES) {
      throw new PetdError('E_BAD_PARAMS', `附件太大（${data.length} 字节，上限 ${MAX_BLOB_BYTES} 字节/8MB）`);
    }
    const sha = sha256Hex(data);
    const mime = inferMime(input.name ?? '', input.mime);
    const ext = extOfName(input.name ?? '') || extForMime(mime);
    const slug = slugify(input.name ?? '');
    const fileName = `${sha.slice(0, 16)}-${slug}.${ext}`;
    const relPath = `${BLOB_DIR}/${fileName}`;
    if (!this.memory.exists(relPath)) this.memory.writeBytesAtomic(relPath, data);
    return this.metaOf(fileName);
  }

  /** 列出 blobs/ 下的附件（按修改时间从新到旧） */
  list(): BlobMeta[] {
    const entries = this.memory
      .listDir(BLOB_DIR)
      .filter((e) => e.type === 'file')
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries.map((e) => this.metaOf(e.name, e.size, e.mtimeMs));
  }

  /** 解析引用并返回元数据；不存在抛 E_NOT_FOUND */
  resolve(ref: string): BlobMeta {
    const fileName = blobFileNameFromRef(ref);
    const relPath = `${BLOB_DIR}/${fileName}`;
    if (!this.memory.exists(relPath)) throw new PetdError('E_NOT_FOUND', `附件不存在：${ref}`);
    return this.metaOf(fileName);
  }

  /** 读附件原始字节 */
  getBytes(ref: string): { meta: BlobMeta; data: Buffer } {
    const meta = this.resolve(ref);
    return { meta, data: this.memory.readBytes(meta.path) };
  }

  /**
   * 预览：文本返回开头摘录（按字符截断），图片返回宽高，其余只返回元数据。
   * UI 拿图片缩略图时应先用 blob.get 取一次原字节，再用 Electron nativeImage 缩放（不要在服务端解码大图）。
   */
  preview(ref: string, opts: { maxChars?: number } = {}): BlobPreview {
    const meta = this.resolve(ref);
    if (meta.kind !== 'text') return { meta };
    const maxChars = clampPreviewChars(opts.maxChars);
    // UTF-8 最多 4 字节/字符；多读一点再按字符裁剪
    const head = this.memory.readHead(meta.path, maxChars * 4 + 4);
    const truncatedByBytes = head.length < meta.size;
    const decoded = decodeText(head);
    const truncatedByChars = decoded.length > maxChars;
    return {
      meta,
      text: truncatedByChars ? decoded.slice(0, maxChars) : decoded,
      truncated: truncatedByBytes || truncatedByChars,
    };
  }

  /** 删除附件（物理删除，不进 Git 历史） */
  remove(ref: string): { path: string; deleted: boolean } {
    const meta = this.resolve(ref);
    this.memory.deleteFile(meta.path);
    return { path: meta.path, deleted: true };
  }

  private metaOf(fileName: string, size?: number, mtimeMs?: number): BlobMeta {
    const relPath = `${BLOB_DIR}/${fileName}`;
    const stat = size === undefined || mtimeMs === undefined ? undefined : { size, mtimeMs };
    const actual = stat ?? { size: this.memory.readBytes(relPath).length, mtimeMs: 0 };
    const dash = fileName.indexOf('-');
    const sha16 = dash > 0 ? fileName.slice(0, dash) : '';
    const mime = inferMime(fileName);
    const kind = blobKindOf(mime);
    let image: ImageSize | undefined;
    if (kind === 'image' && actual.size > 0) {
      try {
        const head = this.memory.readHead(relPath, Math.min(HEAD_SNIFF_BYTES, actual.size));
        image = sniffImageSize(head, mime) ?? undefined;
      } catch {
        image = undefined;
      }
    }
    return {
      handle: blobHandle(fileName),
      path: relPath,
      name: fileName,
      mime,
      kind,
      ...(image === undefined ? {} : { image }),
      size: actual.size,
      sha256: sha16,
      createdAt: new Date(actual.mtimeMs || Date.now()).toISOString(),
    };
  }
}

function clampPreviewChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PREVIEW_TEXT_DEFAULT_CHARS;
  const rounded = Math.floor(value);
  if (rounded <= 0) return PREVIEW_TEXT_DEFAULT_CHARS;
  return Math.min(rounded, PREVIEW_TEXT_MAX_CHARS);
}
