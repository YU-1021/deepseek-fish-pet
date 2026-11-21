/**
 * AI 可写文件的命名与路径策略（自我迭代安全边界 INV-1/2/7）。
 *
 * 约定：带 `.agent.md` / `.agent.json` 后缀的文件 = AI 能改；没后缀 = AI 只能读。
 * 另外记忆区 `home/workspace/**` 是数据区，允许 AI 写入（文件名不强制后缀）。
 *
 * 这个模块只做「策略判断」，不管 IO；写盘守卫、学习产物、审计都以它为准。
 */
import path from 'node:path';
import { PetdError } from '@petd/protocol';

/** 能改的文件后缀（放在扩展名之前），如 SOUL.agent.md / preferences.agent.json */
export const AGENT_FILE_MARK = '.agent.';
/** AI 可写的记忆区（相对 home） */
export const MEMORY_ZONE = 'workspace';
/** AI 可写的 .agent.* 目录（相对 home） */
export const AGENT_ZONES: readonly string[] = ['SOUL.agent.md', 'learning', 'proposals', 'skills/staging'];

export type AgentWriteZone = 'memory' | 'agent-file';

export interface AgentWritePolicy {
  ok: boolean;
  /** 解析后的绝对路径（即使拒绝也给，便于日志） */
  abs: string;
  /** 相对 home 的路径（统一用 /） */
  rel: string;
  zone: AgentWriteZone | null;
  /** 拒绝原因（人话） */
  reason?: string;
}

/** 文件名是否带 `.agent.<ext>` 后缀 */
export function isAgentFileName(name: string): boolean {
  return /\.agent\.[A-Za-z0-9]+$/.test(name);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isUnder(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(dir + '/');
}

/** 判断 AI 能否写目标路径；不抛错，返回策略结果 */
export function agentWritePolicy(home: string, target: string): AgentWritePolicy {
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(home, target);
  const relRaw = path.relative(path.resolve(home), abs);
  const rel = toPosix(relRaw);
  if (!rel || rel.startsWith('..') || path.isAbsolute(relRaw)) {
    return { ok: false, abs, rel, zone: null, reason: '路径不在 petd home 目录内' };
  }
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '')) {
    return { ok: false, abs, rel, zone: null, reason: '路径包含非法片段' };
  }
  if (parts[0] === MEMORY_ZONE) {
    return { ok: true, abs, rel, zone: 'memory' };
  }
  const name = parts[parts.length - 1] ?? '';
  if (isAgentFileName(name)) {
    const inSoul = rel === 'SOUL.agent.md';
    const inLearningOrProposals = parts[0] === 'learning' || parts[0] === 'proposals';
    const inSkillStaging = parts[0] === 'skills' && parts[1] === 'staging';
    if (inSoul || inLearningOrProposals || inSkillStaging) {
      return { ok: true, abs, rel, zone: 'agent-file' };
    }
    return { ok: false, abs, rel, zone: null, reason: '该目录不允许 AI 写 .agent.* 文件' };
  }
  return {
    ok: false,
    abs,
    rel,
    zone: null,
    reason: '只允许写记忆区（workspace/**）或带 .agent.* 后缀的动态文件',
  };
}

/** 校验并返回绝对路径；不允许时抛 E_FORBIDDEN */
export function assertAgentWritable(home: string, target: string): string {
  const policy = agentWritePolicy(home, target);
  if (!policy.ok) {
    throw new PetdError('E_FORBIDDEN', `不允许 AI 写这个文件：${policy.rel || target}（${policy.reason ?? '不在白名单'}）`);
  }
  return policy.abs;
}

/** 人类可读的白名单说明（提示词/文档用） */
export function describeAgentWriteScope(): string {
  return [
    '能改的加 .agent 后缀（.agent.md / .agent.json），没后缀一律只读；',
    '可写位置：workspace/**（记忆区）、SOUL.agent.md、learning/**、proposals/**、skills/staging/**。',
  ].join('');
}
