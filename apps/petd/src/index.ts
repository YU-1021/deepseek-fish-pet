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
import { ChatStore } from './chat/store.js';
import { ChatService } from './chat/service.js';
import { PersonaStore } from './persona/store.js';
import { evolvePersona } from './persona/evolve.js';
import { readLegacyImport } from './chat/legacy.js';
import { createLlmClient } from './llm/client.js';

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
  const personaStore = new PersonaStore({
    home: paths.home,
    file: config.chat.systemPromptFile,
    legacy: legacy.persona,
    logger,
  });
  const seeded = personaStore.ensure();
  if (seeded.createdSoul) {
    logger.info('已播种人格文件', {
      file: personaStore.soulFile,
      source: legacy.persona ? '旧 persona.json' : '内置默认',
      createdState: seeded.createdState,
    });
  }

  const store = new ChatStore({ dir: path.join(paths.home, 'sessions'), logger });
  const llm = createLlmClient({ config: config.llm, apiKey: secrets.llm.apiKey });
  // 先发到进程内总线；网关起来后改为经 Gateway.publish 广播给 WS 客户端
  let publishEvent: (event: string, data?: unknown) => void = (event, data) => {
    bus.emit(event, data);
  };
  const chat = new ChatService({
    store,
    llm,
    chat: config.chat,
    publish: (event, data) => publishEvent(event, data),
    systemPrompt: () => personaStore.read().content,
    logger,
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
