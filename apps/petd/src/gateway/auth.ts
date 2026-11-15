/**
 * 网关鉴权：
 *   - token 持久化在 home/token.json（0600），重启复用，避免每次重连重新配对；
 *   - 校验用 sha256 + timingSafeEqual，避免按字符比较的时序泄漏；
 *   - gateway.json 是易失的「当前监听地址」文件，退出时删除。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TokenRecord {
  token: string;
  createdAt: number;
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

export function verifyToken(expected: string, given: string): boolean {
  if (!expected || !given) return false;
  const a = digest(expected);
  const b = digest(given);
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 读已有 token；不存在/损坏则生成并原子写（Windows 上 chmod 不生效，靠目录 ACL，记录风险） */
export function loadOrCreateToken(tokenFile: string): TokenRecord {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as Partial<TokenRecord>;
    if (typeof raw.token === 'string' && raw.token.length >= 32) {
      return { token: raw.token, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now() };
    }
  } catch {}
  const rec: TokenRecord = { token: generateToken(), createdAt: Date.now() };
  writeJsonAtomic(tokenFile, rec);
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {}
  return rec;
}

export interface GatewayFileRecord {
  port: number;
  pid: number;
  version: string;
  protocol: number;
  startedAt: number;
}

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function removeIfExists(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {}
}
