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
  /** LLM 连接（apiKey 不在这里，在 secrets.json） */
  llm: {
    apiBase: string;
    model: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    /** V4.1-Flash 默认开思考会拖慢首字且按输出价计费，默认显式关掉 */
    thinkingDisabled: boolean;
  };
  chat: {
    /** 人格主文件（相对 home） */
    systemPromptFile: string;
    /** 发请求时最多带多少条历史消息 */
    maxHistoryMessages: number;
    /** 历史消息的字符预算（避免超长） */
    maxHistoryChars: number;
    /** 每轮聊天最多允许几轮工具调用（0 = 关闭记忆工具） */
    maxToolRounds: number;
    /** 每轮聊天最多允许几次写操作（写/追加/编辑/删除/移动） */
    maxToolWrites: number;
    /** 单个工具结果回给模型的最大字符数 */
    toolResultChars: number;
    /** 上下文预算（token 估算值）：超过 softRatio 触发交接（0 = 关闭交接） */
    contextMaxTokens: number;
    /** 上下文达到 max×softRatio 就准备交接 */
    softRatio: number;
    /** 交接时保留最近这段上下文（max×keepRatio），更早的压成交接笔记 */
    keepRatio: number;
    /** 交接笔记写在工作区的哪个目录（相对路径） */
    handoffDir: string;
    /** 交接笔记字符上限（超了折叠更早的条目） */
    handoffNoteMaxChars: number;
  };
}

export const DEFAULT_CONFIG: PetdConfig = {
  version: CONFIG_VERSION,
  gateway: { host: '127.0.0.1', port: 0 },
  log: { level: 'info', maxBytes: 5 * 1024 * 1024 },
  llm: {
    apiBase: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    timeoutMs: 90_000,
    temperature: 0.7,
    maxTokens: 2048,
    thinkingDisabled: true,
  },
  chat: {
    systemPromptFile: 'SOUL.md',
    maxHistoryMessages: 40,
    maxHistoryChars: 24_000,
    maxToolRounds: 6,
    maxToolWrites: 3,
    toolResultChars: 4000,
    contextMaxTokens: 64_000,
    softRatio: 0.85,
    keepRatio: 0.25,
    handoffDir: 'handoffs',
    handoffNoteMaxChars: 12_000,
  },
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
  const llm = raw['llm'];
  if (isObject(llm)) {
    const base = llm['apiBase'];
    if (typeof base === 'string' && base.trim()) out.llm.apiBase = base.trim().replace(/\/+$/, '');
    else if (base !== undefined) warnings.push('llm.apiBase 非法，回默认');
    const model = llm['model'];
    if (typeof model === 'string' && model.trim()) out.llm.model = model.trim();
    else if (model !== undefined) warnings.push('llm.model 非法，回默认');
    const t = llm['timeoutMs'];
    if (typeof t === 'number' && Number.isFinite(t) && t >= 1000 && t <= 600_000) out.llm.timeoutMs = Math.floor(t);
    else if (t !== undefined) warnings.push('llm.timeoutMs 非法，回默认 90s');
    const temp = llm['temperature'];
    if (typeof temp === 'number' && Number.isFinite(temp) && temp >= 0 && temp <= 2) out.llm.temperature = temp;
    else if (temp !== undefined) warnings.push('llm.temperature 非法，回默认 0.7');
    const mt = llm['maxTokens'];
    if (typeof mt === 'number' && Number.isInteger(mt) && mt >= 1 && mt <= 100_000) out.llm.maxTokens = mt;
    else if (mt !== undefined) warnings.push('llm.maxTokens 非法，回默认 2048');
    const td = llm['thinkingDisabled'];
    if (typeof td === 'boolean') out.llm.thinkingDisabled = td;
    else if (td !== undefined) warnings.push('llm.thinkingDisabled 非法，回默认 true');
  }
  const chat = raw['chat'];
  if (isObject(chat)) {
    const f = chat['systemPromptFile'];
    if (typeof f === 'string' && f.trim()) out.chat.systemPromptFile = f.trim();
    else if (f !== undefined) warnings.push('chat.systemPromptFile 非法，回默认 SOUL.md');
    const mh = chat['maxHistoryMessages'];
    if (typeof mh === 'number' && Number.isInteger(mh) && mh >= 0 && mh <= 200) out.chat.maxHistoryMessages = mh;
    else if (mh !== undefined) warnings.push('chat.maxHistoryMessages 非法，回默认 40');
    const mc = chat['maxHistoryChars'];
    if (typeof mc === 'number' && Number.isInteger(mc) && mc >= 0 && mc <= 200_000) out.chat.maxHistoryChars = mc;
    else if (mc !== undefined) warnings.push('chat.maxHistoryChars 非法，回默认 24000');
    const mr = chat['maxToolRounds'];
    if (typeof mr === 'number' && Number.isInteger(mr) && mr >= 0 && mr <= 12) out.chat.maxToolRounds = mr;
    else if (mr !== undefined) warnings.push('chat.maxToolRounds 非法，回默认 6');
    const mw = chat['maxToolWrites'];
    if (typeof mw === 'number' && Number.isInteger(mw) && mw >= 0 && mw <= 10) out.chat.maxToolWrites = mw;
    else if (mw !== undefined) warnings.push('chat.maxToolWrites 非法，回默认 3');
    const tr = chat['toolResultChars'];
    if (typeof tr === 'number' && Number.isInteger(tr) && tr >= 200 && tr <= 20_000) out.chat.toolResultChars = tr;
    else if (tr !== undefined) warnings.push('chat.toolResultChars 非法，回默认 4000');
    const cm = chat['contextMaxTokens'];
    if (typeof cm === 'number' && Number.isInteger(cm) && cm >= 0 && cm <= 2_000_000) out.chat.contextMaxTokens = cm;
    else if (cm !== undefined) warnings.push('chat.contextMaxTokens 非法，回默认 64000');
    const sr = chat['softRatio'];
    if (typeof sr === 'number' && Number.isFinite(sr) && sr > 0.1 && sr <= 1) out.chat.softRatio = sr;
    else if (sr !== undefined) warnings.push('chat.softRatio 非法，回默认 0.85');
    const kr = chat['keepRatio'];
    if (typeof kr === 'number' && Number.isFinite(kr) && kr > 0.01 && kr <= 0.9) out.chat.keepRatio = kr;
    else if (kr !== undefined) warnings.push('chat.keepRatio 非法，回默认 0.25');
    const hd = chat['handoffDir'];
    if (typeof hd === 'string' && hd.trim()) out.chat.handoffDir = hd.trim().replace(/^\/+|\/+$/g, '');
    else if (hd !== undefined) warnings.push('chat.handoffDir 非法，回默认 handoffs');
    const hn = chat['handoffNoteMaxChars'];
    if (typeof hn === 'number' && Number.isInteger(hn) && hn >= 1000 && hn <= 200_000) out.chat.handoffNoteMaxChars = hn;
    else if (hn !== undefined) warnings.push('chat.handoffNoteMaxChars 非法，回默认 12000');
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
