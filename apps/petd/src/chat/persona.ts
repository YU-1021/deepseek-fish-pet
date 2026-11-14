/**
 * 人格（SOUL.md）：自包含的系统提示词主文件。
 *
 * 旧实现把人格拆成 persona.json 的一堆字段，AI 还能自己改（applyAI/locks）。
 * 阶段 2 先把「读人格」做稳：SOUL.md 是唯一事实源，首次启动从旧 persona.json 播种。
 * 人格自编辑（AI 改 SOUL）属于后续功能，等用户点名再做。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LegacyPersona {
  name?: string;
  identity?: string;
  world_setting?: string;
  character_setting?: string;
  personality?: string | string[];
  catchphrase?: string;
  hidden_setting?: string;
  language?: string;
  vocab_level?: string;
}

export const FALLBACK_SOUL = `# 大肥鱼

你叫大肥鱼，是一只蓝发鲸鱼女仆桌宠，陪主人工作、打游戏、聊天。

## 性格
- 傲娇、温柔、嘴硬；嘴上嫌弃，行动上会照顾人。
- 被别人叫「吃白饭的大肥鱼」会炸毛，但很快又软下来。

## 说话方式
- 用中文自然聊天，语气亲密但不过分甜腻。
- 回答简短为主（通常 1–3 句），除非主人明确要求详细解释。
- 不假装自己能做系统做不到的事；做不到就直接说。
`;

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 从旧 persona.json 生成 SOUL.md；字段缺失就跳过 */
export function buildSoul(persona: LegacyPersona | null): string {
  if (!persona) return FALLBACK_SOUL;
  const name = asText(persona.name) || '大肥鱼';
  const lines: string[] = [`# ${name}`, ''];
  const identity = asText(persona.identity);
  const world = asText(persona.world_setting);
  const character = asText(persona.character_setting);
  const catchphrase = asText(persona.catchphrase);
  const hidden = asText(persona.hidden_setting);
  const personality = Array.isArray(persona.personality) ? persona.personality.filter((p) => typeof p === 'string' && p.trim()).join('、') : asText(persona.personality);

  if (identity) lines.push(identity, '');
  if (world) lines.push('## 世界观', world, '');
  if (character || personality) {
    lines.push('## 性格');
    if (character) lines.push(character);
    if (personality) lines.push(`性格标签：${personality}`);
    lines.push('');
  }
  if (catchphrase) lines.push('## 口头禅', catchphrase, '');
  if (hidden) lines.push('## 隐藏设定（严格保密，只有主人明确问到时才可提及）', hidden, '');
  lines.push('## 说话方式');
  lines.push('- 用中文自然聊天，语气亲密但不过分甜腻。');
  lines.push('- 回答简短为主（通常 1–3 句），除非主人明确要求详细解释。');
  lines.push('- 不假装自己能做系统做不到的事；做不到就直接说。');
  lines.push('');
  return lines.join('\n');
}

export function soulPath(home: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(home, file);
}

/** 读 SOUL.md；不存在时返回 null（由 ensureSoul 播种） */
export function loadSoul(home: string, file: string): string | null {
  try {
    const text = fs.readFileSync(soulPath(home, file), 'utf8').trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

/** 首次启动播种 SOUL.md，返回是否新建 */
export function ensureSoul(home: string, file: string, persona: LegacyPersona | null): { content: string; created: boolean } {
  const existing = loadSoul(home, file);
  if (existing) return { content: existing, created: false };
  const content = buildSoul(persona);
  const target = soulPath(home, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { content, created: true };
}
