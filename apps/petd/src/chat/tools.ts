/**
 * 记忆工具：给聊天里的模型主动读写工作区（Coo 的 9 个文件工具，去掉附件/end_turn）。
 *
 * 安全边界：
 *   - 只能操作工作区相对路径（MemoryService/WorkspaceMemory 里已有 ..
 *     点开头、绝对路径、realpath 逃逸的防护）；
 *   - 每次聊天最多 maxWrites 次写操作（写/追加/编辑/删除/移动都算），防止模型失控；
 *   - 每个工具结果截断到 maxResultChars 再回给模型，避免把上下文撑爆；
 *   - 工具错误不抛给上层，而是变成「错误：…」文本回给模型，让它自己纠正。
 */
import { PetdError } from '@petd/protocol';
import type { AutomationStore } from '../automation/store.js';
import { validateScheduleInput } from '../automation/store.js';
import type { LlmToolCall, LlmToolDefinition } from '../llm/client.js';
import type { BlobStore } from '../memory/blob.js';
import { isTextMime } from '../memory/blob.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderStore } from '../reminders/store.js';
import type { SkillStore } from '../skills/store.js';
import type { LearningService } from '../learning/service.js';
import type { CuaEngine } from '../cua/engine.js';
import { CUA_TOOL_NAMES, CUA_TOOLS, executeCuaTool } from './cua-tools.js';

/** 声明给模型的工具（OpenAI function calling 格式） */
export const MEMORY_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区某个目录（不传 dir 就列根目录）。想不起来记忆放哪时先调它。',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: '工作区相对目录，如 partner；不传=根目录' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读工作区里的一个文本文件。大文件可给 offset/limit 分段读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径，如 partner/偏好.md' },
          offset: { type: 'integer', minimum: 1, description: '起始行（1 起，可选）' },
          limit: { type: 'integer', minimum: 1, maximum: 400, description: '最多读多少行（可选）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: '按文件名模式找工作区文件，如 *.md、partner/**/*.md。',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'glob 模式，如 **/*.md' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description: '在工作区文件内容里搜关键词，返回「路径:行号: 内容」。查记忆、确认事实时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜的子串（regex=true 时按正则）' },
          path: { type: 'string', description: '只搜某个文件（可选）' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回多少行（默认 50）' },
          regex: { type: 'boolean', description: '是否按正则解释 query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '整份写入工作区文件（自动建目录、自动 Git 提交）。记长期的事用它；一个主题一个文件，文件名要自解释。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径，如 partner/偏好.md' },
          content: { type: 'string', description: '文件全文（Markdown/文本）' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '追加到工作区文件末尾（不存在则创建、自动提交）。给已有文件补一条时用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径' },
          content: { type: 'string', description: '要追加的内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '把文件里的一段原文精确替换成新内容（old_string 必须唯一命中，自动提交）。改错字/改一小节时用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径' },
          old_string: { type: 'string', description: '要被替换的原文片段（必须唯一）' },
          new_string: { type: 'string', description: '替换成的新内容' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除工作区文件（旧内容优先 move 到 archive/，确定没用再删；PARTNER.md 是常驻文件删不了）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '工作区相对路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: '移动/改名工作区文件（自动提交）。归档旧内容、合并同主题文件时用。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '原相对路径' },
          to: { type: 'string', description: '目标相对路径' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_blobs',
      description: '列出工作区附件（图片/文件，句柄形如 blob:xxx.png）。找用户发过的东西时先调它。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_blob',
      description: '读一个文本类附件（txt/md/json/log 等）；图片/音频等二进制只返回元数据，看不到内容。',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: '附件句柄，如 blob:abc123-照片.png 或 blobs/abc123-照片.png' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_blob',
      description: '把一段内容存成附件（文本或 base64），返回句柄。普通记忆笔记请用 write_file，这里只存二进制/原始附件。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '带扩展名的文件名，如 录音.txt' },
          mime: { type: 'string', description: 'MIME，可省略，按扩展名推断' },
          text: { type: 'string', description: '文本内容（与 data_base64 二选一）' },
          data_base64: { type: 'string', description: 'base64 内容（与 text 二选一）' },
        },
        required: ['name'],
      },
    },
  },
];

/** 提醒工具：让模型能在聊天里直接设/查/取消提醒（不占记忆写配额，但创建本身有上限） */
export const REMINDER_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'remind_in',
      description: '设一个「N 分钟后」的一次性提醒。主人说「过一会儿/半小时后提醒我」时用。',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', minimum: 0.01, maximum: 43200, description: '多少分钟后（正数，最多 30 天）' },
          text: { type: 'string', maxLength: 300, description: '提醒内容，如「喝水」「开会」' },
        },
        required: ['minutes', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remind_at',
      description: '设一个「今天/明天某个时刻」的提醒（HH:MM，今天已过就排在明天）。',
      parameters: {
        type: 'object',
        properties: {
          at_clock: { type: 'string', description: '时刻，形如 14:30 或 9:05' },
          text: { type: 'string', maxLength: 300, description: '提醒内容' },
        },
        required: ['at_clock', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remind_list',
      description: '列出当前还没响的提醒（确认自己设过什么、什么时候响）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remind_cancel',
      description: '取消一条还没响的提醒（需要 id，可先用 remind_list 查）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '提醒编号，如 r3' } },
        required: ['id'],
      },
    },
  },
];

/** 自动化工具：让模型能给自己安排定时任务（自主挂机），不占记忆写配额之外的额外限制 */
export const AUTOMATION_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        '给未来的自己安排一个自主任务：到点后你会在专用会话里自己跑一轮（会花 token）。主人说「以后每天/每隔一会儿帮我…」时用。只给一种时间；都不给 = 建一个只手动跑的任务。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 2000, description: '到点后你要做的事（就是给自己的一条消息）' },
          name: { type: 'string', maxLength: 40, description: '任务名（可选，方便以后认）' },
          every_minutes: { type: 'number', minimum: 1, maximum: 43200, description: '每隔多少分钟跑一次' },
          at_clock: { type: 'string', description: '每天几点跑，形如 08:30' },
          at: { type: 'string', description: '只跑一次的绝对时间（ISO，如 2026-11-20T09:00:00+08:00）' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: '列出现在有哪些自主任务、各自什么时候跑（确认安排前先看）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: '删掉一条自主任务（需要 id，可先用 list_tasks 查）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务编号，如 a3' } },
        required: ['id'],
      },
    },
  },
];

/** 技能：列出技能 / 按需读取技能正文（清单进系统提示词，正文用工具拉，避免撑爆上下文） */
export const SKILL_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '读取一个技能的完整说明（正文）。清单里只有名字和一句简介；真正要做之前先读正文，按里面的步骤与注意事项执行。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能键：工作区技能名，或「插件id/技能名」' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出当前可用技能（工作区技能 + 启用插件贡献的技能）。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** 学习：把观察到的偏好/经验/技能改进写成提案（只写候选，等主人批准；approve/reject/rollback 不暴露给 AI） */
export const LEARNING_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'propose_learning',
      description:
        '把一条值得记住的偏好/经验/技能改进写成学习提案。只写候选文件，主人批准后才生效；不要试图自己批准，也不要写敏感内容。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['skill', 'prompt', 'params', 'preference'],
            description: '提案类型：skill=候选技能，prompt=提示词调整，params=参数建议，preference=主人偏好',
          },
          name: { type: 'string', description: '短名字，如 reply_style、morning_greeting' },
          content: { type: 'string', description: '提案正文：技能写技能正文；偏好写一句或几条规则' },
          reason: { type: 'string', description: '为什么建议这样改（主人看这个决定批不批）' },
          diff: { type: 'string', description: '可选：改动前后的简要说明' },
        },
        required: ['kind', 'name', 'content', 'reason'],
      },
    },
  },
];

/** 聊天里可用的全部工具（记忆 + 提醒 + 自动化） */
export const CHAT_TOOLS: LlmToolDefinition[] = [...MEMORY_TOOLS, ...REMINDER_TOOLS];

/** 所有已知工具名（含未启用的组）：执行时用来区分「没这个工具」和「这组没启用」 */
const ALL_TOOL_NAMES = new Set<string>([
  ...MEMORY_TOOLS,
  ...REMINDER_TOOLS,
  ...AUTOMATION_TOOLS,
  ...SKILL_TOOLS,
  ...LEARNING_TOOLS,
  ...CUA_TOOLS,
].map((t) => t.function.name));

export interface ToolExecutionResult {
  ok: boolean;
  /** 回给模型的文本（已截断） */
  text: string;
  /** 需要追加成图片消息的截图（base64 JPEG） */
  images?: Array<{ mime: string; data: string }>;
}

export interface MemoryToolboxOptions {
  service: MemoryService;
  /** 附件存储（blobs/）；不传 = 不启用附件工具 */
  blobs?: BlobStore;
  /** 提醒存储；不传 = 不启用提醒工具 */
  reminders?: ReminderStore;
  /** 自动化任务存储；不传 = 不启用自主任务工具 */
  automation?: AutomationStore;
  /** 技能存储；不传 = 不启用技能工具 */
  skills?: SkillStore;
  /** 学习闭环；不传 = 不暴露学习提案工具 */
  learning?: LearningService;
  /** 电脑操作引擎；不传/未启用 = 不暴露 CUA 工具 */
  cua?: CuaEngine;
  /** 截图是否作为图片一起回给模型（config.cua.includeImages） */
  cuaIncludeImages?: boolean;
  /** 每轮允许的写操作次数 */
  maxWrites: number;
  /** 单个工具结果回给模型的字符上限 */
  maxResultChars: number;
  /** 审批门：返回 not allowed 时工具直接失败（危险动作先确认） */
  guard?: (ctx: {
    kind: 'tool';
    name: string;
    args?: Record<string, unknown>;
    sessionId?: string;
  }) => Promise<{ allowed: boolean; reason?: string }>;
}

/** 写操作：写/追加/编辑/删除/移动/存附件/建改任务，都算一次配额 */
const WRITE_TOOLS = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'delete_file',
  'move_file',
  'save_blob',
  'schedule_task',
  'cancel_task',
  'propose_learning',
]);

/** 本地时间（给模型看的，形如 2026-11-15 20:30） */
function formatAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 剩余时长（给模型看的人话，如「约 30 分钟」） */
function formatMinutes(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${rest} 分钟`;
}

export class MemoryToolbox {
  private readonly service: MemoryService;
  private readonly blobs?: BlobStore;
  private readonly reminders?: ReminderStore;
  private readonly automation?: AutomationStore;
  private readonly skills?: SkillStore;
  private readonly learning?: LearningService;
  private readonly cua?: CuaEngine;
  private readonly cuaIncludeImages: boolean;
  private readonly maxWrites: number;
  private readonly maxResultChars: number;
  private readonly guard?: MemoryToolboxOptions['guard'];
  /** 本轮已用掉的写操作次数 */
  writes = 0;

  constructor(opts: MemoryToolboxOptions) {
    this.service = opts.service;
    this.blobs = opts.blobs;
    this.reminders = opts.reminders;
    this.automation = opts.automation;
    this.skills = opts.skills;
    this.learning = opts.learning;
    this.cua = opts.cua;
    this.cuaIncludeImages = opts.cuaIncludeImages === true;
    this.maxWrites = opts.maxWrites;
    this.maxResultChars = opts.maxResultChars;
    this.guard = opts.guard;
  }

  /** 声明给模型的工具列表（没配对应服务就不暴露那组工具） */
  definitions(): LlmToolDefinition[] {
    let tools = this.reminders ? CHAT_TOOLS : MEMORY_TOOLS;
    if (this.automation !== undefined && this.automation.isEnabled()) tools = [...tools, ...AUTOMATION_TOOLS];
    if (this.skills !== undefined) tools = [...tools, ...SKILL_TOOLS];
    if (this.learning !== undefined) tools = [...tools, ...LEARNING_TOOLS];
    if (this.cua !== undefined && this.cua.enabled) tools = [...tools, ...CUA_TOOLS];
    return tools;
  }

  /** 执行一个工具调用；永远返回文本结果，不抛错（错误也交给模型自己纠正）。 */
  async execute(
    call: LlmToolCall,
    opts: { signal?: AbortSignal; sessionId?: string } = {}
  ): Promise<ToolExecutionResult> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象');
      args = parsed as Record<string, unknown>;
    } catch (e) {
      return { ok: false, text: this.truncate(`错误：工具参数不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`) };
    }

    if (this.guard !== undefined) {
      try {
        const verdict = await this.guard({
          kind: 'tool',
          name: call.name,
          args,
          ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
        });
        if (!verdict.allowed) {
          return {
            ok: false,
            text: this.truncate(`错误（E_FORBIDDEN）：${verdict.reason ?? '这次操作没有通过审批门'}`),
          };
        }
      } catch (e) {
        return {
          ok: false,
          text: this.truncate(`错误（E_INTERNAL）：审批门出错（${e instanceof Error ? e.message : String(e)}）`),
        };
      }
    }

    if (CUA_TOOL_NAMES.has(call.name)) {
      if (this.cua === undefined || !this.cua.enabled) {
        return { ok: false, text: this.truncate('错误：电脑操作没有开启（config.cua.enabled=false）') };
      }
      try {
        const res = await executeCuaTool(this.cua, call.name, args, {
          includeImages: this.cuaIncludeImages,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        });
        return {
          ok: res.ok,
          text: this.truncate(res.text),
          ...(res.images === undefined ? {} : { images: res.images }),
        };
      } catch (e) {
        if (e instanceof PetdError) return { ok: false, text: this.truncate(`错误（${e.code}）：${e.message}`) };
        return { ok: false, text: this.truncate(`错误：${e instanceof Error ? e.message : String(e)}`) };
      }
    }

    if (!WRITE_TOOLS.has(call.name) && !ALL_TOOL_NAMES.has(call.name)) {
      return { ok: false, text: `错误：没有这个工具（${call.name}）` };
    }
    if (WRITE_TOOLS.has(call.name)) {
      if (this.writes >= this.maxWrites) {
        return { ok: false, text: `错误：本轮写操作已达上限（${this.maxWrites} 次），先把要记的内容整理好，下一轮再写。` };
      }
      this.writes += 1;
    }

    try {
      const text = await this.dispatch(call.name, args);
      return { ok: true, text: this.truncate(text) };
    } catch (e) {
      if (e instanceof PetdError) return { ok: false, text: this.truncate(`错误（${e.code}）：${e.message}`) };
      return { ok: false, text: this.truncate(`错误：${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const str = (key: string): string => {
      const v = args[key];
      if (typeof v !== 'string' || v.trim() === '') throw new PetdError('E_BAD_PARAMS', `缺少参数 ${key}`);
      return v;
    };
    const optStr = (key: string): string | undefined => {
      const v = args[key];
      return typeof v === 'string' && v.trim() !== '' ? v : undefined;
    };
    const optNum = (key: string): number | undefined => {
      const v = args[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      return undefined;
    };

    switch (name) {
      case 'load_skill': {
        const skill = this.requireSkills().get(str('name'));
        return `技能 ${skill.key}（${skill.description || '无描述'}）的正文：\n\n${skill.body}`;
      }
      case 'list_skills': {
        const skills = this.requireSkills().list();
        if (skills.length === 0) return '现在还没有任何技能。';
        return `可用技能（${skills.length} 个）：\n${skills.map((s) => `- ${s.key}：${s.description || '（无描述）'}`).join('\n')}`;
      }
      case 'list_files': {
        const dir = optStr('dir') ?? '';
        const entries = this.service.list(dir);
        if (entries.length === 0) return dir ? `目录 ${dir}/ 是空的。` : '工作区是空的。';
        const lines = entries.map((e) => `- ${e.type === 'dir' ? `${e.path}/` : e.path}${e.type === 'file' ? ` (${e.size} B)` : ''}`);
        return `工作区 ${dir ? `${dir}/` : '根目录'}：\n${lines.join('\n')}`;
      }
      case 'read_file': {
        const p = str('path');
        const { content } = this.service.read(p);
        const offset = optNum('offset');
        const limit = optNum('limit');
        if (offset === undefined && limit === undefined) return content;
        const all = content.split('\n');
        const start = Math.max(1, offset ?? 1);
        const take = limit ?? 200;
        const slice = all.slice(start - 1, start - 1 + take);
        return `（${p} 第 ${start}-${Math.min(all.length, start - 1 + slice.length)} 行，共 ${all.length} 行）\n${slice.join('\n')}`;
      }
      case 'glob_files': {
        const pattern = str('pattern');
        const files = this.service.glob(pattern, optStr('dir') ?? '');
        if (files.length === 0) return `没有匹配 ${pattern} 的文件。`;
        return `匹配 ${pattern} 的文件（${files.length} 个）：\n${files.map((f) => `- ${f}`).join('\n')}`;
      }
      case 'grep_files': {
        const query = str('query');
        const hits = this.service.grep(query, {
          ...(optStr('path') === undefined ? {} : { path: optStr('path') }),
          ...(optNum('limit') === undefined ? {} : { limit: optNum('limit') }),
          ...(args['regex'] === true ? { regex: true } : {}),
        });
        if (hits.length === 0) return `没有命中「${query}」。`;
        return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
      }
      case 'write_file': {
        const r = await this.service.write(str('path'), str('content'));
        return `已写入 ${r.path}（${r.bytes} 字节，Git ${r.commit ?? '无提交'}）`;
      }
      case 'append_file': {
        const r = await this.service.append(str('path'), str('content'));
        return `已追加到 ${r.path}（${r.bytes} 字节，Git ${r.commit ?? '无提交'}）`;
      }
      case 'edit_file': {
        const p = str('path');
        const oldText = str('old_string');
        const newText = typeof args['new_string'] === 'string' ? args['new_string'] : '';
        const current = this.service.read(p).content;
        const first = current.indexOf(oldText);
        if (first < 0) throw new PetdError('E_NOT_FOUND', `在 ${p} 里找不到这段原文，先用 read_file 看清再改`);
        if (current.indexOf(oldText, first + 1) >= 0) throw new PetdError('E_CONFLICT', `这段原文在 ${p} 里出现不止一次，给更长的片段以保证唯一`);
        const updated = current.slice(0, first) + newText + current.slice(first + oldText.length);
        const r = await this.service.write(p, updated);
        return `已编辑 ${r.path}（Git ${r.commit ?? '无提交'}）`;
      }
      case 'delete_file': {
        const r = await this.service.remove(str('path'));
        return `已删除 ${r.path}（Git ${r.commit ?? '无提交'}）`;
      }
      case 'move_file': {
        const r = await this.service.move(str('from'), str('to'));
        return `已移动 ${r.from} → ${r.to}（Git ${r.commit ?? '无提交'}）`;
      }
      case 'list_blobs': {
        const blobs = this.requireBlobs().list();
        if (blobs.length === 0) return '工作区里还没有附件。';
        return `工作区附件（${blobs.length} 个）：\n${blobs
          .map((b) => `- ${b.handle}（${b.name}，${b.mime}，${b.size} 字节，${b.createdAt}）`)
          .join('\n')}`;
      }
      case 'read_blob': {
        const { meta, data } = this.requireBlobs().getBytes(str('ref'));
        if (!isTextMime(meta.mime)) {
          return `${meta.handle} 是二进制附件（${meta.mime}，${meta.size} 字节），当前没有视觉/音频解析能力，只能确认它存在；需要内容请让主人转成文字。`;
        }
        const text = data.toString('utf8');
        return `（${meta.handle}，${meta.mime}，${meta.size} 字节，文本共 ${text.length} 字）\n${text}`;
      }
      case 'save_blob': {
        const name = str('name');
        const textBody = typeof args['text'] === 'string' ? args['text'] : undefined;
        const base64Body = typeof args['data_base64'] === 'string' ? args['data_base64'] : undefined;
        if (textBody === undefined && base64Body === undefined) {
          throw new PetdError('E_BAD_PARAMS', 'save_blob 需要 text 或 data_base64 之一');
        }
        const data = base64Body !== undefined ? Buffer.from(base64Body, 'base64') : Buffer.from(textBody ?? '', 'utf8');
        const meta = this.requireBlobs().put({
          data,
          name,
          ...(typeof args['mime'] === 'string' && args['mime'].trim() !== '' ? { mime: args['mime'] } : {}),
        });
        return `已保存附件 ${meta.handle}（${meta.mime}，${meta.size} 字节）`;
      }
      case 'remind_in': {
        const minutes = Number(args['minutes']);
        const text = str('text');
        const item = this.requireReminders().create({ text, inMinutes: minutes, source: 'tool' });
        return `已设提醒 ${item.id}：${item.text}（${formatAt(item.at)}，约 ${formatMinutes(item.at - Date.now())}后）`;
      }
      case 'remind_at': {
        const atClock = str('at_clock');
        const text = str('text');
        const item = this.requireReminders().create({ text, atClock, source: 'tool' });
        return `已设提醒 ${item.id}：${item.text}（${formatAt(item.at)}）`;
      }
      case 'remind_list': {
        const items = this.requireReminders().list();
        if (items.length === 0) return '当前没有待响的提醒。';
        return `待响提醒（${items.length} 条）：\n${items
          .map((it) => `- ${it.id}｜${formatAt(it.at)}｜${it.text}`)
          .join('\n')}`;
      }
      case 'remind_cancel': {
        const item = this.requireReminders().cancel(str('id'));
        return `已取消提醒 ${item.id}：${item.text}`;
      }
      case 'schedule_task': {
        const prompt = str('prompt');
        const name = optStr('name');
        const every = optNum('every_minutes');
        const atClock = optStr('at_clock');
        const atRaw = optStr('at');
        const given = [every, atClock, atRaw].filter((v) => v !== undefined).length;
        if (given > 1) throw new PetdError('E_BAD_PARAMS', '时间只能给一种：every_minutes / at_clock / at');
        const rounded = every === undefined ? undefined : Math.round(every);
        const raw: unknown =
          rounded !== undefined
            ? { kind: 'interval', everyMinutes: rounded }
            : atClock !== undefined
              ? { kind: 'daily', atClock }
              : atRaw !== undefined
                ? { kind: 'once', at: atRaw }
                : { kind: 'manual' };
        const schedule = validateScheduleInput(raw, Date.now());
        const job = this.requireAutomation().create({
          ...(name === undefined ? {} : { name }),
          prompt,
          schedule,
        });
        const next = job.nextRunAt === null ? '手动运行' : `下次 ${formatAt(job.nextRunAt)}`;
        return `已建自主任务 ${job.id}：${job.name}（${job.scheduleText}，${next}）。到点我会自己跑一轮，会花 token，随时可以取消。`;
      }
      case 'list_tasks': {
        const jobs = this.requireAutomation().listJobs();
        if (jobs.length === 0) return '现在没有自主任务。';
        return `自主任务（${jobs.length} 条）：\n${jobs
          .map(
            (j) =>
              `- ${j.id}｜${j.name}｜${j.scheduleText}｜${j.enabled ? '启用' : '暂停'}｜${j.nextRunAt === null ? '无下次' : formatAt(j.nextRunAt)}`
          )
          .join('\n')}`;
      }
      case 'cancel_task': {
        const id = str('id');
        this.requireAutomation().delete(id);
        return `已删除自主任务 ${id}。`;
      }
      case 'propose_learning': {
        const kindRaw = str('kind');
        if (!(kindRaw === 'skill' || kindRaw === 'prompt' || kindRaw === 'params' || kindRaw === 'preference')) {
          throw new PetdError('E_BAD_PARAMS', 'kind 只能是 skill / prompt / params / preference');
        }
        const diff = optStr('diff');
        const item = this.requireLearning().propose({
          kind: kindRaw,
          name: str('name'),
          content: str('content'),
          reason: str('reason'),
          ...(diff === undefined ? {} : { diff }),
        });
        return `已写成学习提案 ${item.id}（${item.kind}，${item.name}，状态：待主人审批）。主人批准后才生效；可以在提案列表里查看正文。`;
      }
      default:
        throw new PetdError('E_BAD_PARAMS', `没有这个工具：${name}`);
    }
  }

  /** 附件工具必须配了 BlobStore 才能用（避免误调时给出难懂的错） */
  private requireBlobs(): BlobStore {
    if (!this.blobs) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用附件存储');
    return this.blobs;
  }

  /** 提醒工具必须配了 ReminderStore 才能用 */
  private requireReminders(): ReminderStore {
    if (!this.reminders) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用提醒');
    return this.reminders;
  }

  /** 自动化工具必须配了自动化存储且总开关开着才能用 */
  private requireAutomation(): AutomationStore {
    if (!this.automation) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用自动化');
    if (!this.automation.isEnabled()) throw new PetdError('E_UNAVAILABLE', '自动化已关闭（config.automation.enabled=false）');
    return this.automation;
  }

  /** 技能工具必须配了技能存储才能用 */
  private requireSkills(): SkillStore {
    if (!this.skills) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用技能');
    return this.skills;
  }

  /** 学习提案工具必须配了学习服务才能用 */
  private requireLearning(): LearningService {
    if (!this.learning) throw new PetdError('E_UNAVAILABLE', '这个 petd 没有启用学习闭环');
    return this.learning;
  }

  private truncate(text: string): string {
    if (text.length <= this.maxResultChars) return text;
    return text.slice(0, this.maxResultChars) + `\n…（结果太长，已截断到 ${this.maxResultChars} 字符；需要更多可以分段读）`;
  }
}
