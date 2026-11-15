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
    /** 交接时是否让模型把旧对话整理成摘要（false = 只用机械摘录） */
    handoffUseLlm: boolean;
    /** 摘要最多生成多少 token */
    handoffSummaryTokens: number;
  };
  voice: {
    /** 语音总开关：关闭后 voice.* 返回 E_UNAVAILABLE，聊天也不自动朗读 */
    enabled: boolean;
    /** 主引擎：edge（在线神经语音，音质好）/ sapi（Windows 离线音色） */
    engine: 'edge' | 'sapi';
    /** 默认音色（edge 用 zh-CN-xxxNeural；sapi 用系统音色名） */
    voice: string;
    /** 语速，1 = 正常（0.5–2） */
    rate: number;
    /** 音调，1 = 正常（0.5–2，仅 edge 生效） */
    pitch: number;
    /** 单次朗读文本上限（字符） */
    maxChars: number;
    /** chat.send 未显式指定 speak 时，是否自动朗读助手回复 */
    autoSpeak: boolean;
    /** edge 失败时是否自动回退到本地 SAPI（离线兜底） */
    fallbackToSapi: boolean;
  };
  asr: {
    /** 语音识别总开关：关闭后 asr.* 返回 E_UNAVAILABLE */
    enabled: boolean;
    /** whisper-cli.exe 所在目录（空 = 自动探测：petd/vendor、仓库 app/vendor、环境变量 PETD_WHISPER_DIR） */
    binaryDir: string;
    /** 模型缓存目录（空 = 自动：home/asr，其次旧版 %APPDATA%/dayu-pet/asr） */
    modelDir: string;
    /** 模型档位（多语言：tiny/base/small） */
    model: 'tiny' | 'base' | 'small';
    /** whisper 识别语言（zh / en / auto） */
    language: string;
    /** 是否用 silero VAD 过滤静音（需要 ggml-silero 模型，免幻觉且更快） */
    useVad: boolean;
    /** silero VAD 阈值（0–1，越大越严格） */
    vadThreshold: number;
    /** 偏置提示词：把唤醒词编进去，显著提升「大肥鱼」这类专名的识别率 */
    prompt: string;
    /** 是否开启唤醒词监听 */
    wakeEnabled: boolean;
    /** 唤醒词（匹配时容忍标点/空格/大小写差异） */
    wakeWords: string[];
    /** 唤醒后是否把后面那句话自动发给聊天 */
    autoChat: boolean;
    /** 输入采样率（流式喂音频时用，必须 16000） */
    sampleRate: number;
    /** 能量 VAD 阈值（0–1 的 RMS，环境噪声大就调高） */
    energyThreshold: number;
    /** 一段话最短时长（毫秒），过短当噪声丢弃 */
    minSpeechMs: number;
    /** 静音多久算说完（毫秒） */
    silenceMs: number;
    /** 单段最长时长（毫秒），超了强制切段 */
    maxSegmentMs: number;
  };
  mood: {
    /** 情绪系统总开关：关闭后不注入提示词、不随聊天变化（mood.* 仍可读写） */
    enabled: boolean;
    /** 是否把当前情绪翻译成一段行为指导追加进聊天系统提示词 */
    chatInjection: boolean;
    /** 每轮聊天结束后是否自动微调情绪（心情 +1、精力 -1 这种小步） */
    chatNudge: boolean;
    /** 离线衰减/恢复：每小时心情回落多少、精力恢复多少 */
    moodDecayPerHour: number;
    energyRecoverPerHour: number;
  };
  reminders: {
    /** 提醒总开关：关闭后 reminder.* 与聊天里的提醒工具返回 E_UNAVAILABLE */
    enabled: boolean;
    /** 最多同时挂多少条未响提醒 */
    maxPending: number;
    /** 到点时，超过多少小时的旧提醒不再补报（直接标记 skipped） */
    catchUpHours: number;
    /** 已响/已取消的记录保留多少天后清理 */
    keepFiredDays: number;
  };
  automation: {
    /** 自动化总开关：关闭后定时任务不会跑，automation.* 写方法与聊天工具返回 E_UNAVAILABLE */
    enabled: boolean;
    /** 多久检查一次到期任务（秒） */
    tickSeconds: number;
    /** 关停期间错过的任务，超过多少分钟就不再补跑（直接排下一次） */
    catchUpMinutes: number;
    /** 最多挂多少条任务 */
    maxJobs: number;
    /** 运行记录保留多少条 */
    maxRunsKept: number;
    /** 单次任务运行超时（毫秒） */
    runTimeoutMs: number;
  };
  skills: {
    /** 技能总开关：关闭后不扫描、不注入提示词（skill.* 读方法仍可用） */
    enabled: boolean;
    /** 技能目录（相对 home 或绝对路径） */
    dir: string;
    /** 技能清单+常驻技能正文注入系统提示词的总字符预算 */
    promptMaxChars: number;
  };
  plugins: {
    /** 插件总开关：关闭后不扫描插件、不贡献技能与提示词 */
    enabled: boolean;
    /** 插件目录（相对 home 或绝对路径） */
    dir: string;
  };
  cua: {
    /** 电脑操作（看屏幕/动键鼠）总开关：默认关闭，打开后才把工具给模型 */
    enabled: boolean;
    /** 是否允许真正输入（false = 只能看不能动） */
    control: boolean;
    /** 询权限档位：ask-each-turn（每次看/动都问）、ask-before-acting（看免费动要问）、ask-once（看免费，动问一次授权一段时间）、never-ask */
    permission: 'ask-each-turn' | 'ask-before-acting' | 'ask-once' | 'never-ask';
    /** ask-once 授权有效期（分钟） */
    grantMinutes: number;
    /** 终端里操作是否免掉「每档都单独问」（true = 和普通输入一样按档问） */
    skipTerminalAsk: boolean;
    /** 截图参数 */
    screenshot: {
      /** 截图缩放后的最大宽度（模型拿到的是这个尺寸的图） */
      maxWidth: number;
      /** 截图缩放后的最大高度 */
      maxHeight: number;
      /** JPEG 质量 1–100 */
      quality: number;
      /** 每个输入动作之后是否自动再截一张图 */
      afterAction: boolean;
      /** 动作后等界面变化的毫秒数 */
      settleMs: number;
    };
    /** 用户离开鼠标键盘多久（毫秒）才允许发输入 */
    userIdleMs: number;
    /** 等用户闲置最多多久（毫秒），超时就放弃这次输入 */
    maxYieldWaitMs: number;
    /** 打字分块大小间隔（毫秒） */
    typeChunkDelayMs: number;
    /** 截图是否作为图片发给模型（模型支持看图才开；默认只给文字描述） */
    includeImages: boolean;
  };
  hooks: {
    /** 钩子/审批门总开关：关闭后所有规则不生效（危险动作直接执行） */
    enabled: boolean;
    /** 审批门开关：关闭后 ask 规则一律按拒绝处理（不弹出询问） */
    approvalEnabled: boolean;
    /** 单个审批最多等多久（毫秒），超时按拒绝 */
    approvalTimeoutMs: number;
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
    handoffUseLlm: true,
    handoffSummaryTokens: 600,
  },
  voice: {
    enabled: true,
    engine: 'edge',
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: 1,
    pitch: 1,
    maxChars: 1200,
    autoSpeak: false,
    fallbackToSapi: true,
  },
  asr: {
    enabled: true,
    binaryDir: '',
    modelDir: '',
    model: 'base',
    language: 'zh',
    useVad: true,
    vadThreshold: 0.5,
    prompt: '你好大肥鱼。大肥鱼。小鱼。',
    wakeEnabled: true,
    wakeWords: ['你好大肥鱼', '大肥鱼', '你好大飞鱼'],
    autoChat: false,
    sampleRate: 16000,
    energyThreshold: 0.012,
    minSpeechMs: 300,
    silenceMs: 600,
    maxSegmentMs: 15_000,
  },
  mood: {
    enabled: true,
    chatInjection: true,
    chatNudge: true,
    moodDecayPerHour: 2,
    energyRecoverPerHour: 8,
  },
  reminders: {
    enabled: true,
    maxPending: 50,
    catchUpHours: 24,
    keepFiredDays: 7,
  },
  automation: {
    // 默认关闭：自主任务会花真实 token，明确打开才跑
    enabled: false,
    tickSeconds: 30,
    catchUpMinutes: 15,
    maxJobs: 10,
    maxRunsKept: 100,
    runTimeoutMs: 180_000,
  },
  skills: {
    enabled: true,
    dir: 'skills',
    promptMaxChars: 4000,
  },
  plugins: {
    enabled: true,
    dir: 'plugins',
  },
  cua: {
    // 默认关闭：看屏幕/动键鼠风险高，明确打开并确认权限档位后才把工具给模型
    enabled: false,
    control: true,
    permission: 'ask-once',
    grantMinutes: 30,
    skipTerminalAsk: false,
    screenshot: {
      maxWidth: 1280,
      maxHeight: 800,
      quality: 75,
      afterAction: true,
      settleMs: 500,
    },
    userIdleMs: 2000,
    maxYieldWaitMs: 15_000,
    typeChunkDelayMs: 20,
    includeImages: false,
  },
  hooks: {
    // 危险动作二次确认默认开：删文件/删会话之类的操作会先问一次
    enabled: true,
    approvalEnabled: true,
    approvalTimeoutMs: 60_000,
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
    const hl = chat['handoffUseLlm'];
    if (typeof hl === 'boolean') out.chat.handoffUseLlm = hl;
    else if (hl !== undefined) warnings.push('chat.handoffUseLlm 非法，回默认 true');
    const ht = chat['handoffSummaryTokens'];
    if (typeof ht === 'number' && Number.isInteger(ht) && ht >= 100 && ht <= 4000) out.chat.handoffSummaryTokens = ht;
    else if (ht !== undefined) warnings.push('chat.handoffSummaryTokens 非法，回默认 600');
  }
  const voice = raw['voice'];
  if (isObject(voice)) {
    const ve = voice['enabled'];
    if (typeof ve === 'boolean') out.voice.enabled = ve;
    else if (ve !== undefined) warnings.push('voice.enabled 非法，回默认 true');
    const eng = voice['engine'];
    if (eng === 'edge' || eng === 'sapi') out.voice.engine = eng;
    else if (eng !== undefined) warnings.push('voice.engine 非法，回默认 edge');
    const vn = voice['voice'];
    if (typeof vn === 'string' && vn.trim()) out.voice.voice = vn.trim();
    else if (vn !== undefined) warnings.push('voice.voice 非法，回默认 zh-CN-XiaoxiaoNeural');
    const vr = voice['rate'];
    if (typeof vr === 'number' && Number.isFinite(vr) && vr >= 0.5 && vr <= 2) out.voice.rate = vr;
    else if (vr !== undefined) warnings.push('voice.rate 非法，回默认 1');
    const vp = voice['pitch'];
    if (typeof vp === 'number' && Number.isFinite(vp) && vp >= 0.5 && vp <= 2) out.voice.pitch = vp;
    else if (vp !== undefined) warnings.push('voice.pitch 非法，回默认 1');
    const vm = voice['maxChars'];
    if (typeof vm === 'number' && Number.isInteger(vm) && vm >= 1 && vm <= 4000) out.voice.maxChars = vm;
    else if (vm !== undefined) warnings.push('voice.maxChars 非法，回默认 1200');
    const va = voice['autoSpeak'];
    if (typeof va === 'boolean') out.voice.autoSpeak = va;
    else if (va !== undefined) warnings.push('voice.autoSpeak 非法，回默认 false');
    const vf = voice['fallbackToSapi'];
    if (typeof vf === 'boolean') out.voice.fallbackToSapi = vf;
    else if (vf !== undefined) warnings.push('voice.fallbackToSapi 非法，回默认 true');
  }
  const asr = raw['asr'];
  if (isObject(asr)) {
    const ae = asr['enabled'];
    if (typeof ae === 'boolean') out.asr.enabled = ae;
    else if (ae !== undefined) warnings.push('asr.enabled 非法，回默认 true');
    const bd = asr['binaryDir'];
    if (typeof bd === 'string') out.asr.binaryDir = bd.trim();
    else if (bd !== undefined) warnings.push('asr.binaryDir 非法，回默认空');
    const md = asr['modelDir'];
    if (typeof md === 'string') out.asr.modelDir = md.trim();
    else if (md !== undefined) warnings.push('asr.modelDir 非法，回默认空');
    const am = asr['model'];
    if (am === 'tiny' || am === 'base' || am === 'small') out.asr.model = am;
    else if (am !== undefined) warnings.push('asr.model 非法，回默认 base');
    const al = asr['language'];
    if (typeof al === 'string' && al.trim()) out.asr.language = al.trim();
    else if (al !== undefined) warnings.push('asr.language 非法，回默认 zh');
    const uv = asr['useVad'];
    if (typeof uv === 'boolean') out.asr.useVad = uv;
    else if (uv !== undefined) warnings.push('asr.useVad 非法，回默认 true');
    const vt = asr['vadThreshold'];
    if (typeof vt === 'number' && Number.isFinite(vt) && vt > 0 && vt < 1) out.asr.vadThreshold = vt;
    else if (vt !== undefined) warnings.push('asr.vadThreshold 非法，回默认 0.5');
    const ap = asr['prompt'];
    if (typeof ap === 'string') out.asr.prompt = ap.trim().slice(0, 200);
    else if (ap !== undefined) warnings.push('asr.prompt 非法，回默认');
    const we = asr['wakeEnabled'];
    if (typeof we === 'boolean') out.asr.wakeEnabled = we;
    else if (we !== undefined) warnings.push('asr.wakeEnabled 非法，回默认 true');
    const ww = asr['wakeWords'];
    if (Array.isArray(ww)) {
      const list = ww
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= 20)
        .slice(0, 10);
      if (list.length > 0) out.asr.wakeWords = list;
      else warnings.push('asr.wakeWords 为空或非法，回默认');
    } else if (ww !== undefined) warnings.push('asr.wakeWords 非法，回默认');
    const ac = asr['autoChat'];
    if (typeof ac === 'boolean') out.asr.autoChat = ac;
    else if (ac !== undefined) warnings.push('asr.autoChat 非法，回默认 false');
    const sr2 = asr['sampleRate'];
    if (sr2 === 16000 || sr2 === 8000) out.asr.sampleRate = sr2;
    else if (sr2 !== undefined) warnings.push('asr.sampleRate 只支持 16000，回默认');
    const et = asr['energyThreshold'];
    if (typeof et === 'number' && Number.isFinite(et) && et >= 0.0005 && et <= 0.5) out.asr.energyThreshold = et;
    else if (et !== undefined) warnings.push('asr.energyThreshold 非法，回默认 0.012');
    const ms = asr['minSpeechMs'];
    if (typeof ms === 'number' && Number.isInteger(ms) && ms >= 100 && ms <= 5000) out.asr.minSpeechMs = ms;
    else if (ms !== undefined) warnings.push('asr.minSpeechMs 非法，回默认 300');
    const si = asr['silenceMs'];
    if (typeof si === 'number' && Number.isInteger(si) && si >= 200 && si <= 5000) out.asr.silenceMs = si;
    else if (si !== undefined) warnings.push('asr.silenceMs 非法，回默认 600');
    const mx = asr['maxSegmentMs'];
    if (typeof mx === 'number' && Number.isInteger(mx) && mx >= 1000 && mx <= 60_000) out.asr.maxSegmentMs = mx;
    else if (mx !== undefined) warnings.push('asr.maxSegmentMs 非法，回默认 15000');
  }
  const moodRaw = raw['mood'];
  if (moodRaw !== undefined) {
    if (isObject(moodRaw)) {
      const me = moodRaw['enabled'];
      if (typeof me === 'boolean') out.mood.enabled = me;
      else if (me !== undefined) warnings.push('mood.enabled 非法，回默认 true');
      const ci = moodRaw['chatInjection'];
      if (typeof ci === 'boolean') out.mood.chatInjection = ci;
      else if (ci !== undefined) warnings.push('mood.chatInjection 非法，回默认 true');
      const cn = moodRaw['chatNudge'];
      if (typeof cn === 'boolean') out.mood.chatNudge = cn;
      else if (cn !== undefined) warnings.push('mood.chatNudge 非法，回默认 true');
      const md = moodRaw['moodDecayPerHour'];
      if (typeof md === 'number' && Number.isFinite(md) && md >= 0 && md <= 20) out.mood.moodDecayPerHour = md;
      else if (md !== undefined) warnings.push('mood.moodDecayPerHour 非法，回默认 2');
      const er = moodRaw['energyRecoverPerHour'];
      if (typeof er === 'number' && Number.isFinite(er) && er >= 0 && er <= 50) out.mood.energyRecoverPerHour = er;
      else if (er !== undefined) warnings.push('mood.energyRecoverPerHour 非法，回默认 8');
    } else warnings.push('mood 段必须是对象，回默认');
  }
  const remindersRaw = raw['reminders'];
  if (remindersRaw !== undefined) {
    if (isObject(remindersRaw)) {
      const re = remindersRaw['enabled'];
      if (typeof re === 'boolean') out.reminders.enabled = re;
      else if (re !== undefined) warnings.push('reminders.enabled 非法，回默认 true');
      const mp = remindersRaw['maxPending'];
      if (typeof mp === 'number' && Number.isInteger(mp) && mp >= 1 && mp <= 200) out.reminders.maxPending = mp;
      else if (mp !== undefined) warnings.push('reminders.maxPending 非法，回默认 50');
      const ch = remindersRaw['catchUpHours'];
      if (typeof ch === 'number' && Number.isFinite(ch) && ch >= 1 && ch <= 168) out.reminders.catchUpHours = ch;
      else if (ch !== undefined) warnings.push('reminders.catchUpHours 非法，回默认 24');
      const kf = remindersRaw['keepFiredDays'];
      if (typeof kf === 'number' && Number.isFinite(kf) && kf >= 1 && kf <= 30) out.reminders.keepFiredDays = kf;
      else if (kf !== undefined) warnings.push('reminders.keepFiredDays 非法，回默认 7');
    } else warnings.push('reminders 段必须是对象，回默认');
  }
  const automationRaw = raw['automation'];
  if (automationRaw !== undefined) {
    if (isObject(automationRaw)) {
      const ae = automationRaw['enabled'];
      if (typeof ae === 'boolean') out.automation.enabled = ae;
      else if (ae !== undefined) warnings.push('automation.enabled 非法，回默认 false');
      const ts = automationRaw['tickSeconds'];
      if (typeof ts === 'number' && Number.isInteger(ts) && ts >= 5 && ts <= 600) out.automation.tickSeconds = ts;
      else if (ts !== undefined) warnings.push('automation.tickSeconds 非法，回默认 30');
      const cm = automationRaw['catchUpMinutes'];
      if (typeof cm === 'number' && Number.isFinite(cm) && cm >= 0 && cm <= 1440) out.automation.catchUpMinutes = cm;
      else if (cm !== undefined) warnings.push('automation.catchUpMinutes 非法，回默认 15');
      const mj = automationRaw['maxJobs'];
      if (typeof mj === 'number' && Number.isInteger(mj) && mj >= 1 && mj <= 100) out.automation.maxJobs = mj;
      else if (mj !== undefined) warnings.push('automation.maxJobs 非法，回默认 10');
      const mr = automationRaw['maxRunsKept'];
      if (typeof mr === 'number' && Number.isInteger(mr) && mr >= 1 && mr <= 1000) out.automation.maxRunsKept = mr;
      else if (mr !== undefined) warnings.push('automation.maxRunsKept 非法，回默认 100');
      const rt = automationRaw['runTimeoutMs'];
      if (typeof rt === 'number' && Number.isInteger(rt) && rt >= 5_000 && rt <= 900_000) out.automation.runTimeoutMs = rt;
      else if (rt !== undefined) warnings.push('automation.runTimeoutMs 非法，回默认 180000');
    } else warnings.push('automation 段必须是对象，回默认');
  }
  const skillsRaw = raw['skills'];
  if (skillsRaw !== undefined) {
    if (isObject(skillsRaw)) {
      const se = skillsRaw['enabled'];
      if (typeof se === 'boolean') out.skills.enabled = se;
      else if (se !== undefined) warnings.push('skills.enabled 非法，回默认 true');
      const sd = skillsRaw['dir'];
      if (typeof sd === 'string' && sd.trim().length > 0 && sd.trim().length <= 200) out.skills.dir = sd.trim().replace(/[\\/]+$/, '');
      else if (sd !== undefined) warnings.push('skills.dir 非法，回默认 skills');
      const sp = skillsRaw['promptMaxChars'];
      if (typeof sp === 'number' && Number.isInteger(sp) && sp >= 500 && sp <= 20_000) out.skills.promptMaxChars = sp;
      else if (sp !== undefined) warnings.push('skills.promptMaxChars 非法，回默认 4000');
    } else warnings.push('skills 段必须是对象，回默认');
  }
  const pluginsRaw = raw['plugins'];
  if (pluginsRaw !== undefined) {
    if (isObject(pluginsRaw)) {
      const pe = pluginsRaw['enabled'];
      if (typeof pe === 'boolean') out.plugins.enabled = pe;
      else if (pe !== undefined) warnings.push('plugins.enabled 非法，回默认 true');
      const pd = pluginsRaw['dir'];
      if (typeof pd === 'string' && pd.trim().length > 0 && pd.trim().length <= 200) out.plugins.dir = pd.trim().replace(/[\\/]+$/, '');
      else if (pd !== undefined) warnings.push('plugins.dir 非法，回默认 plugins');
    } else warnings.push('plugins 段必须是对象，回默认');
  }
  const cuaRaw = raw['cua'];
  if (cuaRaw !== undefined) {
    if (isObject(cuaRaw)) {
      const ce = cuaRaw['enabled'];
      if (typeof ce === 'boolean') out.cua.enabled = ce;
      else if (ce !== undefined) warnings.push('cua.enabled 非法，回默认 false');
      const cc = cuaRaw['control'];
      if (typeof cc === 'boolean') out.cua.control = cc;
      else if (cc !== undefined) warnings.push('cua.control 非法，回默认 true');
      const cp = cuaRaw['permission'];
      if (cp === 'ask-each-turn' || cp === 'ask-before-acting' || cp === 'ask-once' || cp === 'never-ask') out.cua.permission = cp;
      else if (cp !== undefined) warnings.push('cua.permission 非法，回默认 ask-once');
      const cg = cuaRaw['grantMinutes'];
      if (typeof cg === 'number' && Number.isFinite(cg) && cg >= 1 && cg <= 1440) out.cua.grantMinutes = cg;
      else if (cg !== undefined) warnings.push('cua.grantMinutes 非法，回默认 30');
      const st = cuaRaw['skipTerminalAsk'];
      if (typeof st === 'boolean') out.cua.skipTerminalAsk = st;
      else if (st !== undefined) warnings.push('cua.skipTerminalAsk 非法，回默认 false');
      const shot = cuaRaw['screenshot'];
      if (isObject(shot)) {
        const mw = shot['maxWidth'];
        if (typeof mw === 'number' && Number.isInteger(mw) && mw >= 320 && mw <= 3840) out.cua.screenshot.maxWidth = mw;
        else if (mw !== undefined) warnings.push('cua.screenshot.maxWidth 非法，回默认 1280');
        const mh = shot['maxHeight'];
        if (typeof mh === 'number' && Number.isInteger(mh) && mh >= 240 && mh <= 2160) out.cua.screenshot.maxHeight = mh;
        else if (mh !== undefined) warnings.push('cua.screenshot.maxHeight 非法，回默认 800');
        const q = shot['quality'];
        if (typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= 100) out.cua.screenshot.quality = q;
        else if (q !== undefined) warnings.push('cua.screenshot.quality 非法，回默认 75');
        const aa = shot['afterAction'];
        if (typeof aa === 'boolean') out.cua.screenshot.afterAction = aa;
        else if (aa !== undefined) warnings.push('cua.screenshot.afterAction 非法，回默认 true');
        const sm = shot['settleMs'];
        if (typeof sm === 'number' && Number.isInteger(sm) && sm >= 0 && sm <= 10_000) out.cua.screenshot.settleMs = sm;
        else if (sm !== undefined) warnings.push('cua.screenshot.settleMs 非法，回默认 500');
      } else if (shot !== undefined) warnings.push('cua.screenshot 非法，回默认');
      const ui = cuaRaw['userIdleMs'];
      if (typeof ui === 'number' && Number.isInteger(ui) && ui >= 0 && ui <= 60_000) out.cua.userIdleMs = ui;
      else if (ui !== undefined) warnings.push('cua.userIdleMs 非法，回默认 2000');
      const mw2 = cuaRaw['maxYieldWaitMs'];
      if (typeof mw2 === 'number' && Number.isInteger(mw2) && mw2 >= 0 && mw2 <= 120_000) out.cua.maxYieldWaitMs = mw2;
      else if (mw2 !== undefined) warnings.push('cua.maxYieldWaitMs 非法，回默认 15000');
      const td = cuaRaw['typeChunkDelayMs'];
      if (typeof td === 'number' && Number.isInteger(td) && td >= 0 && td <= 500) out.cua.typeChunkDelayMs = td;
      else if (td !== undefined) warnings.push('cua.typeChunkDelayMs 非法，回默认 20');
      const ii = cuaRaw['includeImages'];
      if (typeof ii === 'boolean') out.cua.includeImages = ii;
      else if (ii !== undefined) warnings.push('cua.includeImages 非法，回默认 false');
    } else warnings.push('cua 段必须是对象，回默认');
  }
  const hooksRaw = raw['hooks'];
  if (hooksRaw !== undefined) {
    if (isObject(hooksRaw)) {
      const he = hooksRaw['enabled'];
      if (typeof he === 'boolean') out.hooks.enabled = he;
      else if (he !== undefined) warnings.push('hooks.enabled 非法，回默认 true');
      const ha = hooksRaw['approvalEnabled'];
      if (typeof ha === 'boolean') out.hooks.approvalEnabled = ha;
      else if (ha !== undefined) warnings.push('hooks.approvalEnabled 非法，回默认 true');
      const ht = hooksRaw['approvalTimeoutMs'];
      if (typeof ht === 'number' && Number.isInteger(ht) && ht >= 5000 && ht <= 600_000) out.hooks.approvalTimeoutMs = ht;
      else if (ht !== undefined) warnings.push('hooks.approvalTimeoutMs 非法，回默认 60000');
    } else warnings.push('hooks 段必须是对象，回默认');
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
