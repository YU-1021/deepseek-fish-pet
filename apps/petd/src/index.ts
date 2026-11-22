#!/usr/bin/env node
/**
 * petd 入口（阶段 1）：常驻网关。
 *
 * 生命周期：
 *   1. 解析参数/路径 → 读配置（缺省自动创建）
 *   2. 读/建 token
 *   3. 注册方法 → 启动 WS 网关（端口 0 时由内核分配）
 *   4. 原子写 gateway.json（pet-ui 从这里发现端口）
 *   5. stdout 打一行 READY JSON（给父进程/脚本判断）
 *   6. SIGINT/SIGTERM 优雅退出：关闭连接 → 删除 gateway.json → exit 0
 *
 * 参数：--home <dir> / --port <n> / --echo / --version / --help
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@petd/protocol';
import { EventBus } from './kernel/events.js';
import { systemClock } from './kernel/clock.js';
import { ensurePaths, resolvePaths } from './kernel/paths.js';
import { loadConfig, saveConfigAtomic } from './kernel/config.js';
import { createLogger, type Logger } from './kernel/logger.js';
import { loadSecrets, saveSecretsAtomic } from './kernel/secrets.js';
import { MethodRegistry } from './gateway/registry.js';
import { Gateway } from './gateway/server.js';
import { loadOrCreateToken, removeIfExists, writeJsonAtomic, type GatewayFileRecord } from './gateway/auth.js';
import { registerHealth } from './gateway/methods/health.js';
import { registerChatMethods } from './gateway/methods/chat.js';
import { registerPersonaMethods } from './gateway/methods/persona.js';
import { registerMemoryMethods } from './gateway/methods/memory.js';
import { registerBlobMethods } from './gateway/methods/blob.js';
import { ChatStore } from './chat/store.js';
import { ChatService } from './chat/service.js';
import { PersonaStore } from './persona/store.js';
import { evolvePersona } from './persona/evolve.js';
import { readLegacyImport } from './chat/legacy.js';
import { createLlmClient } from './llm/client.js';
import { WorkspaceMemory } from './memory/store.js';
import { WorkspaceGit } from './memory/git.js';
import { MemoryService } from './memory/service.js';
import { BlobStore } from './memory/blob.js';
import { VoiceService } from './voice/service.js';
import { registerVoiceMethods } from './gateway/methods/voice.js';
import { AsrService } from './asr/service.js';
import { registerAsrMethods } from './gateway/methods/asr.js';
import { MemoryToolbox } from './chat/tools.js';
import { buildChatSystemPrompt } from './memory/prefix.js';
import { buildDistilledContext } from './memory/distill.js';
import { MoodStore } from './state/mood.js';
import { registerMoodMethods } from './gateway/methods/mood.js';
import { ReminderStore } from './reminders/store.js';
import { registerReminderMethods } from './gateway/methods/reminder.js';
import { AutomationStore } from './automation/store.js';
import { registerAutomationMethods } from './gateway/methods/automation.js';
import { SkillStore } from './skills/store.js';
import { PluginStore } from './plugins/store.js';
import { registerSkillMethods } from './gateway/methods/skill.js';
import { registerPluginMethods } from './gateway/methods/plugin.js';
import { PauseGate } from './kernel/pause.js';
import { PermissionBroker } from './cua/permission.js';
import { CuaEngine } from './cua/engine.js';
import { buildCuaPrompt } from './cua/prompt.js';
import { registerCuaMethods } from './gateway/methods/cua.js';
import { registerRunMethods } from './gateway/methods/run.js';
import { HookStore } from './hooks/store.js';
import { ApprovalBroker } from './hooks/approval.js';
import { RiskAssessor } from './hooks/risk.js';
import { HooksService } from './hooks/service.js';
import { registerHooksMethods } from './gateway/methods/hooks.js';
import { PresenceService } from './presence/service.js';
import { registerPresenceMethods } from './gateway/methods/presence.js';
import { AgentAuditLog } from './kernel/agent-audit.js';
import { registerAgentMethods } from './gateway/methods/agent.js';
import { DshBridge } from './dsh/bridge.js';
import { registerDshMethods } from './gateway/methods/dsh.js';
import { LearningService } from './learning/service.js';
import { registerLearningMethods } from './gateway/methods/learning.js';

interface CliArgs {
  home?: string;
  port?: number;
  echo: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { echo: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--home') {
      const v = argv[i + 1];
      if (!v) throw new Error('--home 需要一个目录参数');
      args.home = v;
      i += 1;
    } else if (a.startsWith('--home=')) {
      args.home = a.slice('--home='.length);
    } else if (a === '--port') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('--port 需要 0–65535 的整数');
      args.port = v;
      i += 1;
    } else if (a.startsWith('--port=')) {
      const v = Number(a.slice('--port='.length));
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('--port 需要 0–65535 的整数');
      args.port = v;
    } else if (a === '--echo') {
      args.echo = true;
    } else if (a === '--version' || a === '-v') {
      args.version = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `petd — 桌宠常驻网关（阶段 1 骨架）

用法: petd [--home <dir>] [--port <n>] [--echo]
  --home <dir>  数据目录（默认 %APPDATA%/dayu-pet/petd，或 PETD_HOME）
  --port <n>    监听端口（默认 0=内核分配）
  --echo        日志同时打到 stdout
  --version     打印版本
  --help        打印帮助`;

/** 审批门自身的方法不走 guard：否则用户规则写成 '*' 时 approval.answer 会被自己拦住 */
const EXEMPT_METHODS = new Set(['approval.answer', 'approval.list', 'hooks.status', 'hooks.list', 'hooks.get']);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const version = readVersion();
  if (args.version) {
    process.stdout.write(`petd ${version} (protocol ${PROTOCOL_VERSION})\n`);
    return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.home) env.PETD_HOME = args.home;
  const paths = resolvePaths(env);
  ensurePaths(paths);
  const { config, created, warnings } = loadConfig(paths.configFile);
  if (args.port !== undefined) config.gateway.port = args.port;

  const logger: Logger = createLogger({
    file: paths.logFile,
    level: config.log.level,
    maxBytes: config.log.maxBytes,
    echo: args.echo,
  });
  if (created) logger.info('已创建默认配置', { file: paths.configFile });
  for (const w of warnings) logger.warn(w);

  const startedAt = systemClock.now();
  const token = loadOrCreateToken(paths.tokenFile);
  const registry = new MethodRegistry();
  const bus = new EventBus(() => systemClock.now());

  // ── 旧版迁移（只读旧目录，一次性）：config.llm / secrets.json / SOUL.md ──
  const legacy = readLegacyImport();
  let configDirty = false;
  if (legacy.config) {
    if (legacy.config.apiBase && config.llm.apiBase === 'https://api.deepseek.com/v1') {
      config.llm.apiBase = legacy.config.apiBase;
      configDirty = true;
    }
    if (legacy.config.model && config.llm.model === 'deepseek-flash') {
      config.llm.model = legacy.config.model;
      configDirty = true;
    }
  }
  if (configDirty) {
    saveConfigAtomic(paths.configFile, config);
    logger.info('已从旧版 config.json 补齐 llm 设置', { apiBase: config.llm.apiBase, model: config.llm.model });
  }
  const secretsFile = path.join(paths.home, 'secrets.json');
  const secrets = loadSecrets(secretsFile);
  if (!secrets.llm.apiKey && legacy.config?.apiKey) {
    secrets.llm.apiKey = legacy.config.apiKey;
    saveSecretsAtomic(secretsFile, secrets);
    logger.info('已从旧版 config.json 迁移 API Key 到 secrets.json（不打印密钥）');
  }
  if (!secrets.llm.apiKey) logger.warn('尚未配置模型 API Key：聊天会返回 E_LLM_AUTH（写入 secrets.json 或设 PETD_LLM_API_KEY）');
  // ── 自我迭代审计：AI 动态文件（.agent.*）的变更流水；只追加，不在写盘白名单里 ──
  const agentAudit = new AgentAuditLog({ home: paths.home, logger });

  const personaStore = new PersonaStore({
    home: paths.home,
    file: config.chat.systemPromptFile,
    legacy: legacy.persona,
    logger,
    audit: agentAudit,
  });
  const seeded = personaStore.ensure();
  if (seeded.createdSoul) {
    logger.info('已播种人格文件', {
      file: personaStore.soulFile,
      source: legacy.persona ? '旧 persona.json' : '内置默认',
      createdState: seeded.createdState,
    });
  }

  // 先发到进程内总线；网关起来后改为经 Gateway.publish 广播给 WS 客户端
  let publishEvent: (event: string, data?: unknown) => void = (event, data) => {
    bus.emit(event, data);
  };

  // ── 工作区记忆：文件式长期记忆 + Git 版本化（形状参考 Cormini，MIT） ──
  const memory = new WorkspaceMemory({ dir: paths.memoryDir });
  const memoryGit = new WorkspaceGit(paths.memoryDir, (msg, data) => logger.warn(msg, data));
  const memoryService = new MemoryService({
    memory,
    git: memoryGit,
    version,
    logger,
    publish: (event, data) => publishEvent(event, data),
  });
  memoryService.ensure();
  logger.info('工作区记忆已就绪', { dir: paths.memoryDir, files: memoryService.status().fileCount });

  // ── 附件存储：blobs/ 下的二进制，内容寻址，不进制版本历史 ──
  const blobs = new BlobStore(memory);
  blobs.ensure();
  logger.info('附件存储已就绪', { dir: path.join(paths.memoryDir, 'blobs'), files: blobs.list().length });

  const store = new ChatStore({ dir: path.join(paths.home, 'sessions'), logger });

  // ── 情绪与状态：心情/好感/精力；启动时按离线时长回落，聊天后小步变化 ──
  const mood = new MoodStore({
    file: path.join(paths.home, 'state', 'mood.json'),
    log: logger,
    moodDecayPerHour: config.mood.moodDecayPerHour,
    energyRecoverPerHour: config.mood.energyRecoverPerHour,
  });
  mood.ensure();
  logger.info('情绪状态已就绪', {
    ...mood.current(),
    enabled: config.mood.enabled,
    chatInjection: config.mood.chatInjection,
    chatNudge: config.mood.chatNudge,
  });

  // ── 提醒：一次性提醒落盘 + 到点广播 reminder.due（不自动发消息，UI/聊天决定怎么提醒） ──
  const reminders = new ReminderStore({
    file: path.join(paths.home, 'state', 'reminders.json'),
    log: logger,
    publish: (event, data) => publishEvent(event, data),
    maxPending: config.reminders.maxPending,
    catchUpHours: config.reminders.catchUpHours,
    keepFiredDays: config.reminders.keepFiredDays,
  });
  const reminderStatus = reminders.ensure();
  logger.info('提醒服务已就绪', {
    pending: reminderStatus.pending,
    nextAt: reminderStatus.nextAt,
    enabled: config.reminders.enabled,
  });

  // ── 技能与插件：技能 = home/skills/<name>/SKILL.md；插件 = home/plugins/<id>/plugin.json ──
  // 插件是声明式的（只贡献技能与 prompt.md，不执行任意代码）；技能清单进系统提示词，正文按需 load_skill。
  const pluginsDir = path.isAbsolute(config.plugins.dir) ? config.plugins.dir : path.join(paths.home, config.plugins.dir);
  const skillsDir = path.isAbsolute(config.skills.dir) ? config.skills.dir : path.join(paths.home, config.skills.dir);
  const pluginStore = new PluginStore({
    dir: pluginsDir,
    stateFile: path.join(paths.home, 'state', 'plugins.json'),
    logger,
    publish: (event, data) => publishEvent(event, data),
  });
  pluginStore.ensure();
  const skillStore = new SkillStore({
    dir: skillsDir,
    promptMaxChars: config.skills.promptMaxChars,
    logger,
    extraRoots: () => (config.plugins.enabled ? pluginStore.enabledSkillRoots() : []),
  });
  skillStore.ensure();
  logger.info('技能与插件已就绪', {
    skills: skillStore.list().length,
    plugins: pluginStore.list().length,
    skillsEnabled: config.skills.enabled,
    pluginsEnabled: config.plugins.enabled,
  });

  const llm = createLlmClient({ config: config.llm, apiKey: secrets.llm.apiKey });

  // ── 电脑操作（CUA）：看屏幕 + 动鼠标键盘；默认关闭；权限门 + 暂停门 + 用户让位 ──
  // 平台不是 Windows 时 enabled 为 false；v1 直接跑在 petd 进程里（koffi），子进程隔离留后续。
  const pauseGate = new PauseGate();
  const permissionBroker = new PermissionBroker({
    logger,
    publish: (event, data) => publishEvent(event, data),
  });
  const cua = new CuaEngine({
    config: config.cua,
    logger,
    ask: (kind, question) => permissionBroker.ask(kind, question),
    pauseGate,
  });
  logger.info('电脑操作已就绪', {
    enabled: cua.enabled,
    control: config.cua.control,
    permission: config.cua.permission,
    platform: process.platform,
  });
  // ── 审批门（hooks）：危险动作先确认；规则存 state/hooks.json ──
  const approvalBroker = new ApprovalBroker({
    publish: (event, data) => publishEvent(event, data),
    timeoutMs: config.hooks.approvalTimeoutMs,
    logger: (msg, data) => logger.info(msg, data),
  });
  const hookStore = new HookStore({
    file: path.join(paths.home, 'state', 'hooks.json'),
    logger: (msg, data) => logger.info(msg, data),
    publish: (event, data) => publishEvent(event, data),
  });
  hookStore.ensure();
  const riskAssessor = new RiskAssessor({
    llm,
    config: () => config.hooks.risk,
    logger: (msg, data) => logger.info(msg, data),
  });
  const hooksService = new HooksService({
    store: hookStore,
    approval: approvalBroker,
    publish: (event, data) => publishEvent(event, data),
    enabled: () => config.hooks.enabled,
    mode: () => config.hooks.mode,
    approvalEnabled: () => config.hooks.approvalEnabled,
    risk: riskAssessor,
    logger: (msg, data) => logger.info(msg, data),
  });
  logger.info('审批门已就绪', {
    enabled: config.hooks.enabled,
    mode: config.hooks.mode,
    approvalEnabled: config.hooks.approvalEnabled,
    riskEnabled: config.hooks.risk.enabled,
    rules: hookStore.list().length,
  });
  // ── 静默活动：大部分时间自己安静待着，只广播 presence.activity 给前端做小动画 ──
  const presence = new PresenceService({
    file: path.join(paths.home, 'state', 'presence.json'),
    config: () => config.presence,
    publish: (event, data) => publishEvent(event, data),
    logger: { debug: (msg, data) => logger.debug(msg, data) },
    idleProvider: () => {
      if (!cua.enabled) return -1;
      try {
        return cua.status().idleMs;
      } catch {
        return -1;
      }
    },
  });
  presence.ensure();
  logger.info('静默活动已就绪', {
    enabled: config.presence.enabled,
    intervalMinutes: config.presence.intervalMinutes,
    quiet: config.presence.quiet,
  });
  // ── DSH 桥：读方向观察桌面 GUI 会话（只读、不花钱）；写方向懒启动私有 SDK runtime ──
  const dsh = new DshBridge({
    config: () => config.dsh,
    home: paths.home,
    logger: {
      debug: (msg, data) => logger.debug(msg, data),
      info: (msg, data) => logger.info(msg, data),
      warn: (msg, data) => logger.warn(msg, data),
      error: (msg, data) => logger.error(msg, data),
    },
    publish: (event, data) => publishEvent(event, data),
  });
  if (config.dsh.enabled && config.dsh.observe) dsh.start();
  logger.info('DSH 桥已就绪', { enabled: config.dsh.enabled, observe: config.dsh.observe });
  // ── 学习闭环：AI 只能写候选（proposals / skills/staging），人批准/灰度/回滚后才生效 ──
  const learning = new LearningService({
    home: paths.home,
    config: () => config.learning,
    logger: {
      debug: (msg, data) => logger.debug(msg, data),
      info: (msg, data) => logger.info(msg, data),
      warn: (msg, data) => logger.warn(msg, data),
      error: (msg, data) => logger.error(msg, data),
    },
    publish: (event, data) => publishEvent(event, data),
    audit: agentAudit,
  });
  learning.ensure();
  logger.info('学习闭环已就绪', {
    enabled: config.learning.enabled,
    requireApproval: config.learning.requireApproval,
    grayPercent: config.learning.grayPercent,
  });
  // 自动化任务在 chat 之后创建（runner 要调 chat.send），这里先声明给 toolbox 用
  let automation: AutomationStore | undefined;
  // ── 语音：Edge 在线神经语音 + 本机 SAPI 兜底；音频随结果回给 UI 直接播放 ──
  const voice = new VoiceService({
    config: config.voice,
    home: paths.home,
    logger,
    publish: (event, data) => publishEvent(event, data),
  });
  logger.info('语音服务已就绪', { engine: config.voice.engine, voice: config.voice.voice, enabled: config.voice.enabled });
  const chat = new ChatService({
    store,
    llm,
    chat: config.chat,
    publish: (event, data) => publishEvent(event, data),
    systemPrompt: () =>
      buildChatSystemPrompt(memory, personaStore.read().content, {
        distilled: config.memory.inject.enabled ? buildDistilledContext(memory, config.memory.inject).text : '',
      }),
    // 情绪只给「行为指导」，不把数字写进提示词；关闭注入时返回空串
    moodPrompt: () => (config.mood.enabled && config.mood.chatInjection ? mood.prompt() : ''),
    // 技能清单/常驻技能正文 + 启用插件的 prompt.md；对应开关关闭时返回空串
    skillsPrompt: () => {
      const parts: string[] = [];
      try {
        if (config.plugins.enabled) {
          const pluginPrompt = pluginStore.prompt();
          if (pluginPrompt) parts.push(pluginPrompt);
        }
        if (config.skills.enabled) {
          const skillPrompt = skillStore.prompt();
          if (skillPrompt) parts.push(skillPrompt);
        }
      } catch {
        return '';
      }
      return parts.join('\n\n');
    },
    // 电脑操作说明段（权限档位/坐标规则/安全边界）；关闭时不注入
    cuaPrompt: () => (cua.enabled ? buildCuaPrompt(cua.status(), config.cua) : ''),
    // 已批准/灰度中的学习结果（偏好/参数/提示词建议）；只作参考，不覆盖安全规则
    learningPrompt: () => learning.promptAdditions(),
    pauseGate,
    cua: { enabled: cua.enabled, onTurnEnded: () => cua.onTurnEnded() },
    cuaIncludeImages: config.cua.includeImages,
    // 聊天后的小步互动：开心一点、更亲近一点、稍微耗点精力（都是很小的量，靠模型评估可另外跑 mood.evaluate）
    onTurnComplete: config.mood.enabled && config.mood.chatNudge
      ? () => {
          const { applied } = mood.adjust({ mood: 0.6, affection: 0.4, energy: -0.2 }, { reason: '聊了一轮天', source: 'chat' });
          if (applied.length > 0) {
            publishEvent('mood.changed', {
              state: mood.current(),
              applied,
              source: 'chat',
              reason: '聊了一轮天',
            });
          }
        }
      : undefined,
    toolbox: () =>
      new MemoryToolbox({
        service: memoryService,
        maxWrites: config.chat.maxToolWrites,
        maxResultChars: config.chat.toolResultChars,
        blobs,
        reminders,
        ...(automation === undefined ? {} : { automation }),
        ...(config.skills.enabled ? { skills: skillStore } : {}),
        ...(config.learning.enabled ? { learning } : {}),
        ...(cua.enabled ? { cua } : {}),
        cuaIncludeImages: config.cua.includeImages,
        guard: async (ctx) => {
          const decision = await hooksService.guard({
            kind: 'tool',
            name: ctx.name,
            ...(ctx.args === undefined ? {} : { args: ctx.args }),
            ...(ctx.sessionId === undefined ? {} : { meta: { sessionId: ctx.sessionId } }),
          });
          return { allowed: decision.allowed, reason: decision.reason };
        },
      }),
    blobs,
    voice,
    autoSpeak: config.voice.autoSpeak,
    // 交接笔记跟着工作区走：写进 handoffs/ 会像普通记忆一样 Git 提交
    handoffIo: {
      readFile: (relPath) => memoryService.read(relPath).content,
      writeFile: (relPath, content) => memoryService.write(relPath, content),
    },
    logger,
  });

  // ── 语音识别：本地 whisper.cpp + 能量 VAD + 唤醒词；autoChat 时把整句接进聊天 ──
  const asr = new AsrService({
    config: config.asr,
    home: paths.home,
    logger,
    publish: (event, data) => publishEvent(event, data),
    onUtterance: (text, wake) => {
      if (!text.trim()) return;
      void (async () => {
        try {
          const sessionId = chat.listSessions()[0]?.id;
          const sent = await chat.send({
            ...(sessionId ? { sessionId } : {}),
            text,
            speak: config.voice.autoSpeak,
          });
          logger.info('语音自动聊天完成', { wake: wake ?? null, sessionId: sent.session.id, chars: sent.assistantMessage.content.length });
        } catch (e) {
          logger.warn('语音自动聊天失败', { error: e instanceof Error ? e.message : String(e) });
        }
      })();
    },
  });
  logger.info('语音识别已就绪', {
    model: config.asr.model,
    binary: asr.status().binary.found,
    enabled: config.asr.enabled,
    wakeEnabled: config.asr.wakeEnabled,
  });

  // ── 自动化 / 自主任务：到点让聊天在专用会话里自己跑一轮（OpenClaw 的 cron 形状） ──
  // 每个任务一个专用会话（标题「自动化 · 任务名」），运行记录落 home/state/automations.json。
  const automationSessionFor = (job: { sessionId?: string; name: string }) => {
    if (job.sessionId) {
      const existing = store.get(job.sessionId);
      if (existing) return existing;
    }
    return chat.createSession(`自动化 · ${job.name}`);
  };
  automation = new AutomationStore({
    file: path.join(paths.home, 'state', 'automations.json'),
    log: logger,
    publish: (event, data) => publishEvent(event, data),
    enabled: () => config.automation.enabled,
    tickSeconds: config.automation.tickSeconds,
    catchUpMinutes: config.automation.catchUpMinutes,
    maxJobs: config.automation.maxJobs,
    maxRunsKept: config.automation.maxRunsKept,
    runTimeoutMs: config.automation.runTimeoutMs,
    runJob: async (job, signal) => {
      const session = automationSessionFor(job);
      const sent = await chat.send({ sessionId: session.id, text: job.prompt, signal, speak: false });
      return {
        output: sent.assistantMessage.content,
        sessionId: session.id,
        usage: {
          ...(sent.reply.usage.promptTokens === undefined ? {} : { promptTokens: sent.reply.usage.promptTokens }),
          ...(sent.reply.usage.completionTokens === undefined ? {} : { completionTokens: sent.reply.usage.completionTokens }),
          ...(sent.reply.usage.totalTokens === undefined ? {} : { totalTokens: sent.reply.usage.totalTokens }),
        },
      };
    },
  });
  const automationReady = automation.ensure();
  logger.info('自动化服务已就绪', {
    enabled: config.automation.enabled,
    jobs: automationReady.jobs,
    nextAt: automationReady.nextAt,
  });

  const gateway = new Gateway({
    host: config.gateway.host,
    port: config.gateway.port,
    token: token.token,
    version,
    startedAt,
    registry,
    bus,
    logger,
    clock: systemClock,
    // 审批门：危险方法（删记忆/删会话/停用插件等）先问用户；审批门自身方法不走规则
    guard: async (ctx) => {
      if (EXEMPT_METHODS.has(ctx.name)) return { allowed: true };
      const decision = await hooksService.guard({
        kind: 'method',
        name: ctx.name,
        ...(ctx.params === undefined || ctx.params === null || typeof ctx.params !== 'object'
          ? {}
          : { args: ctx.params as Record<string, unknown> }),
        meta: {
          ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
          ...(ctx.client === undefined ? {} : { client: { name: ctx.client.name, version: ctx.client.version } }),
        },
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
  });
  publishEvent = (event, data) => gateway.publish(event, data);
  registerHealth(registry, {
    version,
    startedAt,
    pid: process.pid,
    clock: systemClock,
    registry,
    gateway,
    getConfig: () => config,
  });
  registerChatMethods(registry, { chat });
  registerMemoryMethods(registry, {
    memory: memoryService,
    inject: () => buildDistilledContext(memory, config.memory.inject),
  });
  registerBlobMethods(registry, { blobs });
  registerVoiceMethods(registry, { voice });
  registerAsrMethods(registry, { asr });
  registerMoodMethods(registry, {
    store: mood,
    llm,
    chats: store,
    publish: (event, data) => publishEvent(event, data),
    enabled: () => config.mood.enabled,
  });
  registerReminderMethods(registry, {
    store: reminders,
    enabled: () => config.reminders.enabled,
  });
  registerAutomationMethods(registry, {
    store: automation,
    enabled: () => config.automation.enabled,
  });
  registerSkillMethods(registry, { store: skillStore, enabled: () => config.skills.enabled });
  registerPluginMethods(registry, { store: pluginStore, enabled: () => config.plugins.enabled });
  registerCuaMethods(registry, {
    cua,
    answerPermission: (id, accepted) => permissionBroker.answer(id, accepted),
  });
  registerRunMethods(registry, { pauseGate, publish: (event, data) => publishEvent(event, data) });
  registerHooksMethods(registry, {
    store: hookStore,
    approval: approvalBroker,
    service: hooksService,
    config: () => ({
      enabled: config.hooks.enabled,
      mode: config.hooks.mode,
      approvalEnabled: config.hooks.approvalEnabled,
      approvalTimeoutMs: config.hooks.approvalTimeoutMs,
      riskEnabled: config.hooks.risk.enabled && config.hooks.mode === 'smart',
    }),
  });
  registerPresenceMethods(registry, { presence });
  registerAgentMethods(registry, {
    audit: agentAudit,
    publish: (event, data) => publishEvent(event, data),
  });
  registerDshMethods(registry, { bridge: dsh });
  registerLearningMethods(registry, { learning });

  // 人格自演化取「最近经历」：指定会话优先，否则取最近更新的会话；只取最后 20 条
  const recentMessagesFor = (sessionId?: string) => {
    const meta = sessionId
      ? store.list().find((s) => s.id === sessionId)
      : store.list()[0];
    if (!meta) return [];
    const session = store.get(meta.id);
    if (!session) return [];
    return session.messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  };
  registerPersonaMethods(registry, {
    store: personaStore,
    evolve: async ({ sessionId, signal }) =>
      evolvePersona({
        store: personaStore,
        llm,
        recentMessages: () => recentMessagesFor(sessionId),
        ...(signal === undefined ? {} : { signal }),
        logger,
      }),
    publish: (event, data) => publishEvent(event, data),
  });

  const port = await gateway.start();
  const record: GatewayFileRecord = {
    port,
    pid: process.pid,
    version,
    protocol: PROTOCOL_VERSION,
    startedAt,
  };
  writeJsonAtomic(paths.gatewayFile, record);
  gateway.publish('gateway.ready', { port, version });
  process.stdout.write(
    JSON.stringify({ type: 'ready', pid: process.pid, port, home: paths.home, version, protocol: PROTOCOL_VERSION }) + '\n'
  );
  logger.info('petd ready', { port, home: paths.home, version, methods: registry.names().length });

  let exiting = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    logger.info('收到退出信号', { signal, clients: gateway.clientCount });
    const force = setTimeout(() => {
      logger.error('优雅退出超时，强制结束');
      process.exit(1);
    }, 5000);
    force.unref?.();
    try {
      cua.onTurnEnded();
      permissionBroker.cancelAll();
      approvalBroker.cancelAll();
      presence.stop();
      await dsh.stop();
      automation?.stop();
      reminders.stop();
      await gateway.stop();
    } finally {
      removeIfExists(paths.gatewayFile);
      logger.info('petd stopped');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 没有真正的 SIGTERM（child.kill 会直接 TerminateProcess）；
  // 父进程用 ipc 消息请求优雅退出：{ type: 'shutdown' }
  process.on('message', (msg) => {
    if (msg !== null && typeof msg === 'object' && (msg as { type?: unknown }).type === 'shutdown') {
      void shutdown('ipc');
    }
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  process.stderr.write(`petd 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
