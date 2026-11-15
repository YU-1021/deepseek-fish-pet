/**
 * 方法注册表：declare + register，统一参数校验。
 *
 * 命名约束：domain.action（至少一个点），全小写蛇形/点分；重复注册直接抛错（启动期崩溃胜过运行期静默覆盖）。
 */
import type { ErrorBody, MethodDescriptor, MethodHandler, MethodScope, MethodSummary } from '@petd/protocol';
import { assertParams, PetdError } from '@petd/protocol';

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface RegisteredMethod {
  descriptor: MethodDescriptor;
  handler: MethodHandler;
}

export class MethodRegistry {
  private readonly map = new Map<string, RegisteredMethod>();

  register<P extends import('@sinclair/typebox').TSchema | undefined>(
    descriptor: MethodDescriptor<P>,
    handler: MethodHandler
  ): void {
    if (!NAME_RE.test(descriptor.name)) {
      throw new Error(`方法名不合法（应为 domain.action）：${descriptor.name}`);
    }
    if (this.map.has(descriptor.name)) {
      throw new Error(`方法重复注册：${descriptor.name}`);
    }
    this.map.set(descriptor.name, { descriptor: descriptor as MethodDescriptor, handler });
  }

  get(name: string): RegisteredMethod | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  names(): string[] {
    return [...this.map.keys()].sort();
  }

  summaries(): MethodSummary[] {
    return [...this.map.values()]
      .map(({ descriptor }) => ({
        name: descriptor.name,
        scope: descriptor.scope,
        description: descriptor.description,
        timeoutMs: descriptor.timeoutMs ?? 15000,
        idempotent: descriptor.idempotent !== false,
        dangerous: descriptor.dangerous === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 返回 null=通过，否则结构化参数错误 */
  validate(name: string, params: unknown): ErrorBody | null {
    const m = this.map.get(name);
    if (!m) return null; // 由调用方先判断方法是否存在
    return assertParams(m.descriptor.params, params);
  }

  scopeOf(name: string): MethodScope | undefined {
    return this.map.get(name)?.descriptor.scope;
  }

  requireMethod(name: string): RegisteredMethod {
    const m = this.map.get(name);
    if (!m) throw new PetdError('E_UNKNOWN_METHOD', `方法不存在：${name}`);
    return m;
  }
}
