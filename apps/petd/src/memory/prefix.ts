/**
 * 记忆前缀：把工作区里最该常驻的内容拼进聊天系统提示词。
 *
 * 形状移植自 Coopanion vendor/cortico bots/cormini persona（persona.ts 的
 * prefixWorkspaceListing / prefixFolds 与 Coopanion core/persona.ts 的 MEMORY_NOTE），
 * 但内容按 petd 的场景重写（聊天天花板、只读清单、不接 agent 工具循环）。
 * 见 docs/记忆移植来源.md。
 */
import { PetdError } from '@petd/protocol';
import type { WorkspaceMemory } from './store.js';

/** 单个子目录直属文件超过这个数就在前缀里折叠成计数行。 */
export const LISTING_DIR_CAP = 10;

/** 前缀清单总字符上限；超了退化成「顶层目录 + 份数」。 */
export const LISTING_MAX_CHARS = 6000;

/** 总是折叠成一行计数的目录（历史/附件/归档/蒸馏记忆不占常驻前缀）。 */
export const FOLD_DIRS = new Set(['handoffs', 'blobs', 'archive', 'memory']);

/** 常驻文件：整份进前缀，不允许删除或整份移动。 */
export const RESIDENT_FILES = ['PARTNER.md'];

/** 关于主人画像的单文件字符上限，超了截断并留下提示。 */
export const PARTNER_MAX_CHARS = 4000;

/** 首次启动播种的目录骨架。 */
export const SEED_DIRS = ['partner', 'notes', 'handoffs', 'archive', 'blobs', 'memory/diary', 'memory/medium'];

/** 首次启动播种的文件（只创建不覆盖）。 */
export const SEED_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    'PARTNER.md',
    [
      '# 坐在电脑前的人',
      '',
      '（这里放关于主人最重要、最稳定的几件事：怎么称呼、在意什么、作息、正在做什么、不喜欢什么。保持简短；细节写到 partner/ 里。）',
      '',
    ].join('\n'),
  ],
  [
    'MEMORY.md',
    [
      '# 我的记忆',
      '',
      '（这里放从对话里沉淀下来的事实与决定；一个主题一个小节或一个文件，文件名要能自解释。）',
      '',
    ].join('\n'),
  ],
  [
    'todo.md',
    [
      '# 待办',
      '',
      '（在这里记下承诺与没做完的事，带日期；做完就删掉。）',
      '',
    ].join('\n'),
  ],
  [
    'memory/facts.md',
    [
      '# 记住的事',
      '',
      '（程序按权重挑这些事实注入对话；手改也可以，一行一条，别删表头。）',
      '',
      '| 事实 | 权重 | 标签 | 出现 | 最近 |',
      '| --- | --- | --- | --- | --- |',
      '',
    ].join('\n'),
  ],
  [
    'memory/experiences.md',
    [
      '# 学到的做事经验',
      '',
      '（程序蒸馏出来的程序性经验候选；够稳的会走学习闭环变成技能文件。）',
      '',
    ].join('\n'),
  ],
];

/** 记忆维护约定：拼进系统提示词，约束模型自己怎么整理文件。 */
export const MEMORY_NOTE = [
  '记忆就是工作区里的文件，不是数据库：想留到下次对话的东西，必须写进文件（或者请主人帮你写）。',
  '聊天时你可以直接调用记忆工具（list_files/read_file/glob_files/grep_files/write_file/append_file/edit_file/delete_file/move_file）读写这些文件；不确定或想回忆某件事时，先读文件，不要凭空猜。',
  '一个主题一个文件，文件名要能自解释（例如 partner/称呼和作息.md，不要 notes2.md）。',
  '新建文件前先用 glob_files / grep_files 找同主题的旧文件，能改旧的就改旧的；两份同主题就合并成一份。',
  '承诺和没做完的事写进 todo.md 并带日期；做完就删。',
  '跟时间有关的内容，日期写进文件名（例如 log/2026-11.md，每月一个）；正文写具体日期，不要写「今天」「明天」。',
  '长文件把旧内容移到 archive/ 归档；archive/ 在清单里折叠成一行，但仍然能被 grep 搜到。',
  '`memory/` 目录是程序维护的蒸馏记忆（facts.md 永久事实、diary/ 日记、medium/ 会话摘要），注入的是加工后的内容；不要整份重写它，想补一条事实就按表格格式加一行。',
].join('\n');

/** 读 PARTNER.md；不存在或读失败返回 null。 */
export function readPartner(memory: WorkspaceMemory): string | null {
  try {
    if (!memory.exists('PARTNER.md')) return null;
    return memory.readFile('PARTNER.md');
  } catch {
    return null;
  }
}

/** 是否常驻文件（禁删/禁整份移动）。 */
export function isResident(relPath: string): boolean {
  return RESIDENT_FILES.includes(memoryPathKey(relPath));
}

function memoryPathKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/**
 * 工作区文件清单：根文件逐个列；子目录按「折叠目录 / 直属文件超上限」折叠成计数行；
 * 总字符超上限时退化成「顶层目录 + 份数」。
 */
export function buildWorkspaceListing(memory: WorkspaceMemory, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? LISTING_MAX_CHARS;
  let files: string[] = [];
  try {
    files = memory.walkFiles('');
  } catch {
    return '（工作区暂时读不到）';
  }
  if (files.length === 0) return '（工作区是空的）';

  const rootFiles: string[] = [];
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash < 0) {
      rootFiles.push(f);
      continue;
    }
    const top = f.slice(0, slash);
    const list = groups.get(top) ?? [];
    list.push(f);
    groups.set(top, list);
  }
  rootFiles.sort();
  const tops = [...groups.keys()].sort();

  const full: string[] = [...rootFiles];
  for (const top of tops) {
    const group = groups.get(top) ?? [];
    if (FOLD_DIRS.has(top) || group.length > LISTING_DIR_CAP) {
      full.push(`${top}/ （${group.length} 份）`);
      continue;
    }
    full.push(...group.slice().sort());
  }
  const text = full.join('\n');
  if (text.length <= maxChars) return text;

  const compact: string[] = [...rootFiles];
  for (const top of tops) compact.push(`${top}/ （${(groups.get(top) ?? []).length} 份）`);
  return compact.join('\n');
}

/**
 * 生成聊天系统提示词：人格 SOUL（调用方给） + 关于主人 + 蒸馏记忆 + 记忆约定 + 工作区清单。
 * 每次发消息前现算，用户手改文件后下一轮立即生效。
 */
export function buildChatSystemPrompt(
  memory: WorkspaceMemory,
  personaContent: string,
  opts: { distilled?: string } = {}
): string {
  const sections: string[] = [];
  const persona = personaContent.trim();
  if (persona) sections.push(persona);

  const partner = readPartner(memory);
  if (partner !== null) {
    const trimmed = partner.trim();
    if (trimmed) {
      const capped = trimmed.length > PARTNER_MAX_CHARS
        ? `${trimmed.slice(0, PARTNER_MAX_CHARS)}\n…（PARTNER.md 太长，后面已截断；细节请放到 partner/）`
        : trimmed;
      sections.push(`## 关于主人\n\n${capped}`);
    }
  }

  const distilled = opts.distilled?.trim() ?? '';
  if (distilled) sections.push(distilled);

  sections.push(`## 记忆维护约定\n\n${MEMORY_NOTE}`);
  sections.push(`## 工作区文件（你的长期记忆）\n\n${buildWorkspaceListing(memory)}`);
  return sections.join('\n\n');
}

/** 供 gateway 方法做路径守卫：拒绝空路径（空表示工作区根，只用于读）。 */
export function assertNonEmptyPath(relPath: string): string {
  const p = relPath.trim();
  if (!p) throw new PetdError('E_BAD_PARAMS', '需要文件路径（工作区内的相对路径）');
  return p;
}
