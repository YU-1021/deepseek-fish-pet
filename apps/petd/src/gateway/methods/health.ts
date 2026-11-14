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
      }),
    },
    () => {
      const cfg = deps.getConfig();
      return { version: cfg.version, gateway: { ...cfg.gateway }, log: { ...cfg.log } };
    }
  );
}
