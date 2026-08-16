/** Tracks cumulative sync CPU time (performance.now) against a per-job budget. */
export interface CpuGuard {
  run<T>(fn: () => T): T;
  exceeded(): boolean;
  tripped(): boolean;
}

export function createCpuGuard(maxMs: number): CpuGuard {
  const cap = Math.max(0, maxMs);
  let used = 0;
  let trippedFlag = false;

  return {
    run<T>(fn: () => T): T {
      if (cap <= 0) return fn();
      const t0 = performance.now();
      const result = fn();
      used += performance.now() - t0;
      if (used >= cap) trippedFlag = true;
      return result;
    },
    exceeded(): boolean {
      return cap > 0 && used >= cap;
    },
    tripped(): boolean {
      return trippedFlag;
    },
  };
}

export function createCpuGuardFromConfig(maxMs: number): CpuGuard | undefined {
  return maxMs > 0 ? createCpuGuard(maxMs) : undefined;
}
