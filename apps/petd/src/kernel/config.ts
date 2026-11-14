/**
 * 配置：JSON 文件 + schema 版本号 + 原子写。
 *
 * 阶段 1 只放 gateway/log 两类；阶段 2 起 memory/persona 等按域扩展（config.json5 由蓝图约定，
 * 先保持 JSON 以便零依赖，迁移时只换序列化层）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_VERSION = 1;

export interface PetdConfig {
  version: number;
  gateway: {
    host: string;
    /** 0 = 随机端口（写 gateway.json 报给客户端） */
    port: number;
  };
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    /** 单文件上限，超过轮转为 petd.log.1 */
    maxBytes: number;
  };
}

export const DEFAULT_CONFIG: PetdConfig = {
  version: CONFIG_VERSION,
  gateway: { host: '127.0.0.1', port: 0 },
  log: { level: 'info', maxBytes: 5 * 1024 * 1024 },
};

export interface LoadResult {
  config: PetdConfig;
  /** 文件不存在时用默认值创建 */
  created: boolean;
  /** 做了哪些兼容修补（阶段 2 起记录迁移） */
  warnings: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 浅合并 + 类型校验；非法值回默认并记 warning（不抛错，守护进程要能起） */
export function normalizeConfig(raw: unknown): { config: PetdConfig; warnings: string[] } {
  const warnings: string[] = [];
  const out: PetdConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PetdConfig;
  if (!isObject(raw)) {
    return { config: out, warnings: ['配置不是对象，使用默认值'] };
  }
  if (typeof raw['version'] === 'number' && raw['version'] !== CONFIG_VERSION) {
    warnings.push(`配置版本 ${String(raw['version'])} → ${CONFIG_VERSION}（阶段 1 仅提示，阶段 2 接迁移链）`);
  }
  const gw = raw['gateway'];
  if (isObject(gw)) {
    if (typeof gw['host'] === 'string' && gw['host'].trim()) out.gateway.host = gw['host'].trim();
    if (typeof gw['port'] === 'number' && Number.isInteger(gw['port']) && gw['port'] >= 0 && gw['port'] <= 65535) out.gateway.port = gw['port'];
    else if (gw['port'] !== undefined) warnings.push('gateway.port 非法，回默认 0');
  }
  const log = raw['log'];
  if (isObject(log)) {
    const lv = log['level'];
    if (lv === 'debug' || lv === 'info' || lv === 'warn' || lv === 'error') out.log.level = lv;
    else if (lv !== undefined) warnings.push('log.level 非法，回默认 info');
    const mb = log['maxBytes'];
    if (typeof mb === 'number' && Number.isFinite(mb) && mb >= 64 * 1024) out.log.maxBytes = Math.floor(mb);
    else if (mb !== undefined) warnings.push('log.maxBytes 非法，回默认 5MB');
  }
  out.version = CONFIG_VERSION;
  return { config: out, warnings };
}

export function loadConfig(file: string): LoadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PetdConfig;
    saveConfigAtomic(file, config);
    return { config, created: true, warnings: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PetdConfig;
    return { config, created: false, warnings: ['配置文件 JSON 解析失败，使用默认值（原文件保留）'] };
  }
  const { config, warnings } = normalizeConfig(raw);
  return { config, created: false, warnings };
}

/** 原子写：tmp + rename，避免半截文件 */
export function saveConfigAtomic(file: string, config: PetdConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
