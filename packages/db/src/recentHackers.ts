export interface RecentHackerEntry {
  address: string;
  at: string;
  victims: number;
  downstream: number;
}

export interface RecentHackerActivityDelta {
  victims?: number;
  downstream?: number;
  at?: string;
}

export function parseRecentHackersJson(raw: string | null | undefined): RecentHackerEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentHackerEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const address = typeof row.address === "string" ? row.address : "";
      const at = typeof row.at === "string" ? row.at : "";
      if (!address || !at) continue;
      const victims = Number(row.victims);
      const downstream = Number(row.downstream);
      out.push({
        address,
        at,
        victims: Number.isFinite(victims) && victims > 0 ? Math.floor(victims) : 0,
        downstream: Number.isFinite(downstream) && downstream > 0 ? Math.floor(downstream) : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function mergeRecentHackerActivity(
  existing: RecentHackerEntry[],
  updates: Map<string, RecentHackerActivityDelta>,
  limit: number,
): RecentHackerEntry[] {
  const cap = Math.max(1, Math.floor(limit));
  const byAddress = new Map<string, RecentHackerEntry>();
  for (const entry of existing) {
    byAddress.set(entry.address, { ...entry });
  }

  for (const [address, delta] of updates) {
    if (!address) continue;
    const prev = byAddress.get(address);
    const atCandidates = [prev?.at, delta.at].filter((v): v is string => Boolean(v));
    const at =
      atCandidates.length === 0
        ? new Date().toISOString()
        : atCandidates.reduce((max, cur) => (cur > max ? cur : max));
    const victims = (prev?.victims ?? 0) + (delta.victims ?? 0);
    const downstream = (prev?.downstream ?? 0) + (delta.downstream ?? 0);
    byAddress.set(address, { address, at, victims, downstream });
  }

  return [...byAddress.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, cap);
}

export function recentHackersEqual(a: RecentHackerEntry[], b: RecentHackerEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.address !== right.address ||
      left.at !== right.at ||
      left.victims !== right.victims ||
      left.downstream !== right.downstream
    ) {
      return false;
    }
  }
  return true;
}

export function serializeRecentHackers(entries: RecentHackerEntry[]): string {
  return JSON.stringify(entries);
}
