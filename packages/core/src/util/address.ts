/** Normalize/validate Bitcoin mainnet addresses used by the API. Returns null if invalid. */
export function normalizeBitcoinAddress(raw: string): string | null {
  const a = raw.trim();
  if (!a || a.length > 90) return null;
  if (/^bc1[a-z0-9]{25,87}$/i.test(a)) return a.toLowerCase();
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) return a;
  return null;
}

/** Escape LIKE wildcards so user search cannot broaden matches unintentionally. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
