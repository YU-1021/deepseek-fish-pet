/**
 * 进程内事件总线（阶段 1 最小版）。
 *
 * 阶段 2 会把它替换成 EventBusPort 的实现（可选移植 Cortico WakeBus 的批处理）；
 * 现在只保证：seq 单调、订阅/退订、emit 同步返回事件帧数据、错误不中断其他订阅者。
 */
export interface PetEvent<T = unknown> {
  event: string;
  seq: number;
  ts: number;
  data?: T;
}

export type EventHandler<T = unknown> = (ev: PetEvent<T>) => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private seq = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler);
    return () => this.off(event, handler as EventHandler);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (!set.size) this.handlers.delete(event);
  }

  /** 返回事件信封（含自增 seq），无订阅者也算一次事件 */
  emit<T = unknown>(event: string, data?: T): PetEvent<T> {
    this.seq += 1;
    const ev: PetEvent<T> = { event, seq: this.seq, ts: this.now(), ...(data === undefined ? {} : { data }) };
    const set = this.handlers.get(event);
    if (set) {
      for (const h of [...set]) {
        try {
          h(ev);
        } catch {
          // 单个订阅者异常不影响其它订阅者/事件序号
        }
      }
    }
    return ev;
  }

  listenerCount(event?: string): number {
    if (event) return this.handlers.get(event)?.size ?? 0;
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }

  get currentSeq(): number {
    return this.seq;
  }
}
