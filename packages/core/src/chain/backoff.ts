/** Exponential backoff seconds for consecutive provider 429 strikes. */
export function providerBackoffSec(
  strikes: number,
  baseSec: number,
  maxSec: number,
  retryAfterSec?: number,
): number {
  const n = Math.max(1, strikes);
  const exponential = Math.min(maxSec, baseSec * 2 ** (n - 1));
  const fromHeader = retryAfterSec != null && Number.isFinite(retryAfterSec) ? Math.max(0, retryAfterSec) : 0;
  return Math.max(fromHeader, exponential);
}
