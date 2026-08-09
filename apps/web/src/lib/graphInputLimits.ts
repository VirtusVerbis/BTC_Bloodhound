import { btcToSats, satsToBtcNumber } from "./api";

export const DEFAULT_MAX_VICTIM_NODES = 100;
export const DEFAULT_MAX_DOWNSTREAM_NODES = 100;
export const DEFAULT_MIN_EDGE_SATS = 1000;
/** Fallback when /api/config has not loaded yet. */
export const DEFAULT_MAX_GRAPH_NODE_CAP = 10000;
export const MIN_SATS_INPUT_MAX_LENGTH = 16;
export const MIN_BTC_INPUT_MAX_LENGTH = 12;

export const MAX_BTC_SUPPLY = 21_000_000;
export const MAX_SATS_SUPPLY = MAX_BTC_SUPPLY * 100_000_000;

export function graphNodeInputMaxLength(maxCap: number): number {
  return Math.max(1, String(Math.floor(maxCap)).length);
}

export function clampGraphNodeCount(n: number, maxCap = DEFAULT_MAX_GRAPH_NODE_CAP): number {
  const cap = Math.max(1, Math.floor(maxCap));
  return Math.min(cap, Math.max(1, Math.floor(n)));
}

export function clampMinEdgeSats(sats: number): number {
  return Math.min(MAX_SATS_SUPPLY, Math.max(0, Math.floor(sats)));
}

export function formatMinAmountDraft(sats: number, unit: "sats" | "btc"): string {
  return unit === "sats" ? String(sats) : String(satsToBtcNumber(sats));
}

export function commitGraphNodeDraft(
  draft: string,
  defaultValue: number,
  setCommitted: (n: number) => void,
  setDraft: (s: string) => void,
  maxCap = DEFAULT_MAX_GRAPH_NODE_CAP,
): void {
  const trimmed = draft.trim();
  const parsed = trimmed === "" ? defaultValue : Math.floor(Number(trimmed));
  const value = clampGraphNodeCount(Number.isFinite(parsed) ? parsed : defaultValue, maxCap);
  setCommitted(value);
  setDraft(String(value));
}

export function commitMinAmountDraft(
  draft: string,
  unit: "sats" | "btc",
  defaultSats: number,
  setMinEdgeSats: (n: number) => void,
  setDraft: (s: string) => void,
): void {
  const trimmed = draft.trim();
  let sats: number;
  if (trimmed === "") {
    sats = defaultSats;
  } else if (unit === "sats") {
    const parsed = Math.floor(Number(trimmed));
    sats = clampMinEdgeSats(Number.isFinite(parsed) ? parsed : defaultSats);
  } else {
    const parsed = Number(trimmed);
    sats = clampMinEdgeSats(
      Number.isFinite(parsed) && parsed > 0 ? btcToSats(parsed) : defaultSats,
    );
  }
  setMinEdgeSats(sats);
  setDraft(formatMinAmountDraft(sats, unit));
}
