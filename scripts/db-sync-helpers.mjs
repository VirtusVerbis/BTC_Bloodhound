/**
 * Pure helpers for push/pull checkpoint math (unit-tested).
 */
export function computeProgressPct(completed, total) {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((completed / total) * 100));
}

export function batchesToSkip(completedIds, batchIds) {
  const done = new Set(completedIds);
  return batchIds.filter((id) => !done.has(id));
}

export function splitSqlStatements(sql) {
  const out = [];
  let cur = "";
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      cur += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        cur += sql[++i];
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function nextImportIndex(manifestNext, total) {
  if (manifestNext == null || manifestNext < 0) return 0;
  if (manifestNext > total) return 0;
  return manifestNext;
}
