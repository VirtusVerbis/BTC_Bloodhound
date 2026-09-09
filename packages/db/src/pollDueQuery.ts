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

export function clampPollDueCount(value: number): number {
  const n = Number(value);
  return Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
}
