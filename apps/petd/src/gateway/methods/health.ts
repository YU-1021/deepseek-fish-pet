/**
 * 健康检查与配置读取：阶段 1 唯一上线的方法组。
 *
 * 只读、幂等、无副作用；health.status 汇总运行态供 pet-ui 的「服务状态」页使用。
 */
import { Type } from '@sinclair/typebox';
import { PROTOCOL_VERSION } from '@petd/protocol';
import type { PetdConfig } from '../../kernel/config.js';
import type { Clock } from '../../kernel/clock.js';
import type { Gateway } from '../server.js';
import type { MethodRegistry } from '../registry.js';

export interface HealthDeps {
  version: string;
  startedAt: number;
  pid: number;
  clock: Clock;
  registry: MethodRegistry;
  gateway: Pick<Gateway, 'port' | 'clientCount'>;
  getConfig: () => PetdConfig;
}

const StatusResult = Type.Object({
  server: Type.Object({
    name: Type.String(),
    version: Type.String(),
    protocol: Type.Integer(),
    pid: Type.Integer(),
    startedAt: Type.Integer(),
    uptimeMs: Type.Integer(),
  }),
  gateway: Type.Object({
    port: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    clients: Type.Integer({ minimum: 0 }),
  }),
  methods: Type.Array(
    Type.Object({
      name: Type.String(),
      scope: Type.String(),
      description: Type.String(),
      timeoutMs: Type.Integer(),
      idempotent: Type.Boolean(),
      dangerous: Type.Boolean(),
    })
  ),
});

export function registerHealth(reg: MethodRegistry, deps: HealthDeps): void {
  reg.register(
    {
      name: 'health.ping',
      scope: 'read',
      description: '存活探测：返回 pong 与服务端时间',
      result: Type.Object({ pong: Type.Boolean(), ts: Type.Integer() }),
    },
    () => ({ pong: true, ts: deps.clock.now() })
  );

  reg.register(
    {
      name: 'health.status',
      scope: 'read',
      description: '运行状态：版本/运行时长/网关端口/客户端数/方法清单',
      result: StatusResult,
    },
    () => ({
      server: {
        name: 'petd',
        version: deps.version,
        protocol: PROTOCOL_VERSION,
        pid: deps.pid,
        startedAt: deps.startedAt,
        uptimeMs: Math.max(0, deps.clock.now() - deps.startedAt),
      },
      gateway: { port: deps.gateway.port, clients: deps.gateway.clientCount },
      methods: deps.registry.summaries(),
    })
  );

  reg.register(
    {
      name: 'config.get',
      scope: 'read',
      description: '读取当前生效配置（不含任何密钥）',
      result: Type.Object({
        version: Type.Integer(),
        gateway: Type.Object({ host: Type.String(), port: Type.Integer() }),
        log: Type.Object({ level: Type.String(), maxBytes: Type.Integer() }),
        llm: Type.Object({
          apiBase: Type.String(),
          model: Type.String(),
          timeoutMs: Type.Integer(),
          temperature: Type.Number(),
          maxTokens: Type.Integer(),
          thinkingDisabled: Type.Boolean(),
        }),
        chat: Type.Object({
          systemPromptFile: Type.String(),
          maxHistoryMessages: Type.Integer(),
          maxHistoryChars: Type.Integer(),
          maxToolRounds: Type.Integer(),
          maxToolWrites: Type.Integer(),
          toolResultChars: Type.Integer(),
          contextMaxTokens: Type.Integer(),
          softRatio: Type.Number(),
          keepRatio: Type.Number(),
          handoffDir: Type.String(),
          handoffNoteMaxChars: Type.Integer(),
          handoffUseLlm: Type.Boolean(),
          handoffSummaryTokens: Type.Integer(),
        }),
        voice: Type.Object({
          enabled: Type.Boolean(),
          engine: Type.String(),
          voice: Type.String(),
          rate: Type.Number(),
          pitch: Type.Number(),
          maxChars: Type.Integer(),
          autoSpeak: Type.Boolean(),
          fallbackToSapi: Type.Boolean(),
        }),
        asr: Type.Object({
          enabled: Type.Boolean(),
          model: Type.String(),
          language: Type.String(),
          useVad: Type.Boolean(),
          vadThreshold: Type.Number(),
          wakeEnabled: Type.Boolean(),
          wakeWords: Type.Array(Type.String()),
          autoChat: Type.Boolean(),
          sampleRate: Type.Integer(),
        }),
        mood: Type.Object({
          enabled: Type.Boolean(),
          chatInjection: Type.Boolean(),
          chatNudge: Type.Boolean(),
          moodDecayPerHour: Type.Number(),
          energyRecoverPerHour: Type.Number(),
        }),
        reminders: Type.Object({
          enabled: Type.Boolean(),
          maxPending: Type.Integer(),
          catchUpHours: Type.Number(),
          keepFiredDays: Type.Number(),
        }),
        automation: Type.Object({
          enabled: Type.Boolean(),
          tickSeconds: Type.Integer(),
          catchUpMinutes: Type.Number(),
          maxJobs: Type.Integer(),
          maxRunsKept: Type.Integer(),
          runTimeoutMs: Type.Integer(),
        }),
        skills: Type.Object({
          enabled: Type.Boolean(),
          dir: Type.String(),
          promptMaxChars: Type.Integer(),
        }),
        plugins: Type.Object({
          enabled: Type.Boolean(),
          dir: Type.String(),
        }),
        cua: Type.Object({
          enabled: Type.Boolean(),
          control: Type.Boolean(),
          permission: Type.String(),
          grantMinutes: Type.Number(),
          skipTerminalAsk: Type.Boolean(),
          screenshot: Type.Object({
            maxWidth: Type.Integer(),
            maxHeight: Type.Integer(),
            quality: Type.Integer(),
            afterAction: Type.Boolean(),
            settleMs: Type.Integer(),
          }),
          userIdleMs: Type.Integer(),
          maxYieldWaitMs: Type.Integer(),
          typeChunkDelayMs: Type.Integer(),
          includeImages: Type.Boolean(),
          selfProtect: Type.Object({
            enabled: Type.Boolean(),
            hints: Type.Array(Type.String()),
            apps: Type.Array(Type.String()),
          }),
        }),
        hooks: Type.Object({
          enabled: Type.Boolean(),
          mode: Type.Union([Type.Literal('rules'), Type.Literal('smart')]),
          approvalEnabled: Type.Boolean(),
          approvalTimeoutMs: Type.Integer(),
          risk: Type.Object({
            enabled: Type.Boolean(),
            timeoutMs: Type.Integer(),
            cacheTtlSeconds: Type.Integer(),
            maxCacheEntries: Type.Integer(),
            maxArgsChars: Type.Integer(),
            fallback: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
          }),
        }),
        presence: Type.Object({
          enabled: Type.Boolean(),
          quiet: Type.Boolean(),
          intervalMinutes: Type.Integer(),
          idleMinutes: Type.Integer(),
          maxPerDay: Type.Integer(),
          nightQuiet: Type.Object({
            enabled: Type.Boolean(),
            start: Type.String(),
            end: Type.String(),
          }),
        }),
        dsh: Type.Object({
          enabled: Type.Boolean(),
          observe: Type.Boolean(),
          exePath: Type.String(),
          cliPath: Type.String(),
          cwd: Type.String(),
          provider: Type.String(),
          model: Type.String(),
          reasoningEffort: Type.String(),
          maxTokens: Type.Integer(),
          approvalPolicy: Type.Union([Type.Literal('reject'), Type.Literal('ask')]),
          askTimeoutMs: Type.Integer(),
          observeIntervalMs: Type.Integer(),
          activeMs: Type.Integer(),
        }),
        learning: Type.Object({
          enabled: Type.Boolean(),
          requireApproval: Type.Boolean(),
          grayPercent: Type.Integer(),
          grayDays: Type.Integer(),
          maxPending: Type.Integer(),
          promptMaxChars: Type.Integer(),
        }),
      }),
    },
    () => {
      const cfg = deps.getConfig();
      return {
        version: cfg.version,
        gateway: { ...cfg.gateway },
        log: { ...cfg.log },
        llm: { ...cfg.llm },
        chat: { ...cfg.chat },
        voice: { ...cfg.voice },
        asr: {
          enabled: cfg.asr.enabled,
          model: cfg.asr.model,
          language: cfg.asr.language,
          useVad: cfg.asr.useVad,
          vadThreshold: cfg.asr.vadThreshold,
          wakeEnabled: cfg.asr.wakeEnabled,
          wakeWords: [...cfg.asr.wakeWords],
          autoChat: cfg.asr.autoChat,
          sampleRate: cfg.asr.sampleRate,
        },
        mood: { ...cfg.mood },
        reminders: { ...cfg.reminders },
        automation: { ...cfg.automation },
        skills: { ...cfg.skills },
        plugins: { ...cfg.plugins },
        cua: {
          ...cfg.cua,
          screenshot: { ...cfg.cua.screenshot },
          selfProtect: {
            ...cfg.cua.selfProtect,
            hints: [...cfg.cua.selfProtect.hints],
            apps: [...cfg.cua.selfProtect.apps],
          },
        },
        hooks: { ...cfg.hooks, risk: { ...cfg.hooks.risk } },
        presence: { ...cfg.presence, nightQuiet: { ...cfg.presence.nightQuiet } },
        dsh: { ...cfg.dsh },
        learning: { ...cfg.learning },
      };
    }
  );
}
