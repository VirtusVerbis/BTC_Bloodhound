/** Escape a string for SQLite single-quoted literals. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** WHERE clause for poll-eligible downstream addresses (pending/expanded under max depth). */
export function downstreamPollEligibleWhereSql(tableAlias: string, maxDepth: number): string {
  const depth = Math.floor(maxDepth);
  return `${tableAlias}.role = 'downstream'
    AND ${tableAlias}.expand_status IN ('expanded', 'pending')
    AND ${tableAlias}.hop_from_hacker < ${depth}`;
}

/** Full scalar query: eligible count minus recently-polled count. */
export function pollDueCountSql(maxDepth: number, cutoffIso: string): string {
  const depth = Math.floor(maxDepth);
  const cutoff = sqlStringLiteral(cutoffIso);
  return `SELECT MAX(0, (
    (SELECT COUNT(*) FROM addresses
     WHERE ${downstreamPollEligibleWhereSql("addresses", depth)})
    -
    (SELECT COUNT(*) FROM addresses a
     INNER JOIN sync_state s ON s.address = a.address
     WHERE ${downstreamPollEligibleWhereSql("a", depth)}
       AND s.last_polled_at > ${cutoff})
  )) AS count`;
}

/** Never-polled downstream addresses (no sync_state row or last_polled_at IS NULL). */
export function listDownstreamNeverPolledSql(maxDepth: number, limit: number): string {
  const depth = Math.floor(maxDepth);
  const cap = Math.max(0, Math.floor(limit));
  return `SELECT a.address
FROM addresses a
WHERE ${downstreamPollEligibleWhereSql("a", depth)}
  AND NOT EXISTS (
    SELECT 1 FROM sync_state s
    WHERE s.address = a.address AND s.last_polled_at IS NOT NULL
  )
ORDER BY a.hop_from_hacker ASC
LIMIT ${cap}`;
}

/** Stale-polled downstream addresses (last_polled_at <= cutoff). */
export function listDownstreamStalePolledSql(
  maxDepth: number,
  cutoffIso: string,
  limit: number,
): string {
  const depth = Math.floor(maxDepth);
  const cutoff = sqlStringLiteral(cutoffIso);
  const cap = Math.max(0, Math.floor(limit));
  return `SELECT a.address
FROM sync_state s
INNER JOIN addresses a ON a.address = s.address
WHERE s.last_polled_at <= ${cutoff}
  AND ${downstreamPollEligibleWhereSql("a", depth)}
ORDER BY s.last_polled_at ASC, a.hop_from_hacker ASC
LIMIT ${cap}`;
}

export function clampPollDueCount(value: number): number {
  const n = Number(value);
  return Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
}
