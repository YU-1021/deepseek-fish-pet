/**
 * 时钟：真实时间与单调时间分开，测试可注入。
 */
export interface Clock {
  now(): number;
  mono(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
};

export function uptimeMs(clock: Clock, startedAtMono: number): number {
  return Math.max(0, clock.mono() - startedAtMono);
}
