/** Tracks chain API call budget per job invocation (0 = unlimited). */
export function createChainCallBudget(maxChainCallsPerJob: number) {
  let used = 0;
  const unlimited = maxChainCallsPerJob <= 0;

  return {
    canCall(): boolean {
      return unlimited || used < maxChainCallsPerJob;
    },
    consume(): void {
      if (!unlimited) used++;
    },
    exhausted(): boolean {
      return !unlimited && used >= maxChainCallsPerJob;
    },
    /** Effective per-job tx/process batch size when budget is limited. */
    processBatchLimit(fallback: number): number {
      if (unlimited) return fallback;
      return Math.min(fallback, Math.max(0, maxChainCallsPerJob - used));
    },
  };
}
