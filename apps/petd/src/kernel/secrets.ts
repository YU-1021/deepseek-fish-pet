/**
 * 密钥存储：home/secrets.json（0600）。
 *
 * 原则：
 *   - 密钥只进这个文件，绝不进 config.json / 日志 / 方法返回值；
 *   - 环境变量优先（PETD_LLM_API_KEY）便于临时覆盖与 CI；
 *   - Windows 上 chmod 基本无效，靠用户目录 ACL；记录在文档里而不是假装安全。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PetdSecrets {
  version: 1;
  llm: {
    apiKey: string;
  };
}

export const DEFAULT_SECRETS: PetdSecrets = { version: 1, llm: { apiKey: '' } };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function loadSecrets(file: string, env: NodeJS.ProcessEnv = process.env): PetdSecrets {
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const out: PetdSecrets = JSON.parse(JSON.stringify(DEFAULT_SECRETS)) as PetdSecrets;
  if (isObject(raw) && isObject(raw['llm']) && typeof raw['llm']['apiKey'] === 'string') {
    out.llm.apiKey = raw['llm']['apiKey'];
  }
  if (env.PETD_LLM_API_KEY && env.PETD_LLM_API_KEY.trim()) {
    out.llm.apiKey = env.PETD_LLM_API_KEY.trim();
  }
  if (!fs.existsSync(file)) saveSecretsAtomic(file, out);
  return out;
}

export function saveSecretsAtomic(file: string, secrets: PetdSecrets): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}
