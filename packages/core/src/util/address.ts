import { initEccLib, address, networks } from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";

initEccLib(ecc);

/** Normalize/validate Bitcoin mainnet addresses used by the API. Returns null if invalid. */
export function normalizeBitcoinAddress(raw: string): string | null {
  const a = raw.trim();
  if (!a || a.length > 90) return null;
  try {
    address.toOutputScript(a, networks.bitcoin);
    return a.startsWith("bc1") || a.startsWith("BC1") ? a.toLowerCase() : a;
  } catch {
    return null;
  }
}

/** Escape LIKE wildcards so user search cannot broaden matches unintentionally. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
