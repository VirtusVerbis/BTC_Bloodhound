/** Escape a string for SQLite single-quoted literals. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** TypeScript eligibility check mirroring downstreamPollEligibleWhereSql. */
export function isDownstreamPollEligibleAddress(
  role: string,
  expandStatus: string,
  hopFromHacker: number | null | undefined,
  maxDepth: number,
  inboundSats = 0,
  minExpandSats = 0,
): boolean {
  const depth = Math.floor(maxDepth);
  const floor = Math.max(0, Math.floor(minExpandSats));
  return (
    role === "downstream" &&
    (expandStatus === "expanded" || expandStatus === "pending") &&
    hopFromHacker != null &&
    hopFromHacker < depth &&
    (floor <= 0 || Math.max(0, Math.floor(inboundSats)) >= floor)
  );
}

/** WHERE clause for poll-eligible downstream addresses (pending/expanded under max depth). */
export function downstreamPollEligibleWhereSql(
  tableAlias: string,
  maxDepth: number,
  minExpandSats = 0,
): string {
  const depth = Math.floor(maxDepth);
  const floor = Math.max(0, Math.floor(minExpandSats));
  const amountClause =
    floor <= 0
      ? ""
      : `
    AND ${tableAlias}.inbound_sats >= ${floor}`;
  return `${tableAlias}.role = 'downstream'
    AND ${tableAlias}.expand_status IN ('expanded', 'pending')
    AND ${tableAlias}.hop_from_hacker < ${depth}${amountClause}`;
}

/** FROM/JOIN/WHERE for never-polled eligible addresses (no row or last_polled_at IS NULL). */
export function downstreamNeverPolledFromSql(
  maxDepth: number,
  minExpandSats = 0,
): string {
  const depth = Math.floor(maxDepth);
  return `FROM addresses a
LEFT JOIN sync_state s ON s.address = a.address AND s.last_polled_at IS NOT NULL
WHERE ${downstreamPollEligibleWhereSql("a", depth, minExpandSats)}
  AND s.address IS NULL`;
}

/** Never-polled eligible downstream addresses (no sync_state row or last_polled_at IS NULL). */
export function pollDueNeverCountSql(maxDepth: number, minExpandSats = 0): string {
  return `SELECT COUNT(*) AS count
${downstreamNeverPolledFromSql(maxDepth, minExpandSats)}`;
}

/** Stale-polled eligible downstream addresses (last_polled_at <= cutoff). */
export function pollDueStaleCountSql(
  maxDepth: number,
  cutoffIso: string,
  minExpandSats = 0,
): string {
  const depth = Math.floor(maxDepth);
  const cutoff = sqlStringLiteral(cutoffIso);
  return `SELECT COUNT(*) AS count
FROM sync_state s
INNER JOIN addresses a ON a.address = s.address
WHERE s.last_polled_at <= ${cutoff}
  AND ${downstreamPollEligibleWhereSql("a", depth, minExpandSats)}`;
}

/** Eligible downstream addresses that have not been polled after cutoff. */
export function pollDueCountSql(maxDepth: number, cutoffIso: string, minExpandSats = 0): string {
  const never = pollDueNeverCountSql(maxDepth, minExpandSats).replace(
    "SELECT COUNT(*) AS count",
    "SELECT COUNT(*)",
  );
  const stale = pollDueStaleCountSql(maxDepth, cutoffIso, minExpandSats).replace(
    "SELECT COUNT(*) AS count",
    "SELECT COUNT(*)",
  );
  return `SELECT
  (${never})
  +
  (${stale})
AS count`;
}

/** Never-polled downstream addresses (no sync_state row or last_polled_at IS NULL). */
export function listDownstreamNeverPolledSql(
  maxDepth: number,
  limit: number,
  minExpandSats = 0,
): string {
  const depth = Math.floor(maxDepth);
  const cap = Math.max(0, Math.floor(limit));
  return `SELECT a.address
${downstreamNeverPolledFromSql(depth, minExpandSats)}
ORDER BY a.hop_from_hacker ASC
LIMIT ${cap}`;
}

/** Stale-polled downstream addresses (last_polled_at <= cutoff). */
export function listDownstreamStalePolledSql(
  maxDepth: number,
  cutoffIso: string,
  limit: number,
  minExpandSats = 0,
): string {
  const depth = Math.floor(maxDepth);
  const cutoff = sqlStringLiteral(cutoffIso);
  const cap = Math.max(0, Math.floor(limit));
  return `SELECT a.address
FROM sync_state s
INNER JOIN addresses a ON a.address = s.address
WHERE s.last_polled_at <= ${cutoff}
  AND ${downstreamPollEligibleWhereSql("a", depth, minExpandSats)}
ORDER BY s.last_polled_at ASC, a.hop_from_hacker ASC
LIMIT ${cap}`;
}

export function clampPollDueCount(value: number): number {
  const n = Number(value);
  return Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
}
