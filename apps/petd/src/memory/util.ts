/**
 * 工作区记忆的底层小工具：文本解码、大小/日期格式化、Busy 重试。
 *
 * 移植来源：Coopanion vendor/cortico bots/cormini persona/memory.ts（MIT，Pal AI Lab，
 * commit 8362383）用到的 util / fs-busy 片段；只保留 petd 需要的部分，
 * 改写为本地实现，无外部依赖。见 docs/记忆移植来源.md。
 */
import { readFileSync } from 'node:fs';

/** UTF-16 LE BOM（0xFF 0xFE）。旧版记事本写出的笔记可能是这个编码。 */
export function isUtf16Le(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
}

/** 逐字节判断是否 UTF-8 BOM。 */
function isUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** 把工作区文件字节解成字符串：UTF-8（可带 BOM）、UTF-16 LE/BE 都认。 */
export function decodeText(bytes: Uint8Array): string {
  if (isUtf8Bom(bytes)) return Buffer.from(bytes.subarray(3)).toString('utf8');
  if (isUtf16Le(bytes)) return Buffer.from(bytes.subarray(2)).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    if (body.length % 2 !== 0) return body.toString('utf8');
    body.swap16();
    return body.toString('utf16le');
  }
  return Buffer.from(bytes).toString('utf8');
}

export function readTextFile(abs: string): string {
  return decodeText(readFileSync(abs));
}

/** 字节数的短写：B、KB（一位小数）、MB（一位小数）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD。 */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 文件清单行尾的「(大小, 最后修改日期)」；日期按本机时区。 */
export function fileFacts(size: number, mtimeMs: number): string {
  return `(${formatSize(size)}, ${localDate(mtimeMs)})`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/** Windows 上 rename 偶尔被占用：短暂重试，仍失败则抛最后一次错误。 */
export function retryBusy<T>(fn: () => T, tries = 5, delayMs = 25): T {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e)) throw e;
      last = e;
      sleepSync(delayMs);
    }
  }
  throw last;
}
