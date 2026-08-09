import { btcToSats, satsToBtcNumber } from "./api";

export const DEFAULT_MAX_VICTIM_NODES = 100;
export const DEFAULT_MAX_DOWNSTREAM_NODES = 100;
export const DEFAULT_MIN_EDGE_SATS = 1000;
export const MAX_GRAPH_NODE_COUNT = 1000;
export const GRAPH_NODE_INPUT_MAX_LENGTH = 6;
export const MIN_SATS_INPUT_MAX_LENGTH = 16;
export const MIN_BTC_INPUT_MAX_LENGTH = 12;

export const MAX_BTC_SUPPLY = 21_000_000;
export const MAX_SATS_SUPPLY = MAX_BTC_SUPPLY * 100_000_000;

export function clampGraphNodeCount(n: number): number {
  return Math.min(MAX_GRAPH_NODE_COUNT, Math.max(1, Math.floor(n)));
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
): void {
  const trimmed = draft.trim();
  const parsed = trimmed === "" ? defaultValue : Math.floor(Number(trimmed));
  const value = clampGraphNodeCount(Number.isFinite(parsed) ? parsed : defaultValue);
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
