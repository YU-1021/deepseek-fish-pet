/**
 * 旧版数据导入（只为迁移，不长期依赖）。
 *
 * 读 %APPDATA%/dayu-pet/{config.json,persona.json}：
 *   - config.apiBase/apiKey/model → 首次启动填 secrets.json / config.llm；
 *   - persona.json → 首次启动播种 SOUL.md。
 *
 * 只读、不写旧目录；apiKey 绝不进日志。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LegacyPersona } from './persona.js';

export interface LegacyImport {
  dir: string;
  config: { apiBase?: string; apiKey?: string; model?: string } | null;
  persona: LegacyPersona | null;
}

function defaultLegacyDir(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'dayu-pet');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pickStr(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function readLegacyImport(opts: { dir?: string; env?: NodeJS.ProcessEnv } = {}): LegacyImport {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? defaultLegacyDir(env);
  const rawConfig = readJson(path.join(dir, 'config.json'));
  const rawPersona = readJson(path.join(dir, 'persona.json'));

  let config: LegacyImport['config'] = null;
  if (isObject(rawConfig)) {
    config = {
      apiBase: pickStr(rawConfig, 'apiBase'),
      apiKey: pickStr(rawConfig, 'apiKey'),
      model: pickStr(rawConfig, 'model'),
    };
    if (!config.apiBase && !config.apiKey && !config.model) config = null;
  }

  let persona: LegacyPersona | null = null;
  if (isObject(rawPersona)) {
    persona = {
      name: pickStr(rawPersona, 'name'),
      identity: pickStr(rawPersona, 'identity'),
      world_setting: pickStr(rawPersona, 'world_setting'),
      character_setting: pickStr(rawPersona, 'character_setting'),
      personality: rawPersona['personality'] as LegacyPersona['personality'],
      catchphrase: pickStr(rawPersona, 'catchphrase'),
      hidden_setting: pickStr(rawPersona, 'hidden_setting'),
      language: pickStr(rawPersona, 'language'),
      vocab_level: pickStr(rawPersona, 'vocab_level'),
    };
  }

  return { dir, config, persona };
}
