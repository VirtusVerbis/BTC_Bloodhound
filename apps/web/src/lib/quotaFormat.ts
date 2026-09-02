/** Compact count for quota usage display (e.g. 4200000 → "4.2M"). */
export function formatQuotaCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (v >= 10_000) {
    const k = v / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return v.toLocaleString("en-US");
}

export type QuotaUsageDisplay = {
  rowsRead: number;
  rowsWritten: number;
  workersRequests: number;
  rowsReadLimit: number;
  rowsWrittenLimit: number;
  workersRequestsLimit: number;
};

export function formatQuotaUsageLine(usage: QuotaUsageDisplay): string {
  return (
    `D1 reads: ${formatQuotaCount(usage.rowsRead)}/${formatQuotaCount(usage.rowsReadLimit)} · ` +
    `D1 writes: ${formatQuotaCount(usage.rowsWritten)}/${formatQuotaCount(usage.rowsWrittenLimit)} · ` +
    `Requests: ${formatQuotaCount(usage.workersRequests)}/${formatQuotaCount(usage.workersRequestsLimit)}`
  );
}
