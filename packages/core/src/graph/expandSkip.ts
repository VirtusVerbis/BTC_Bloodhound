export const DEFAULT_MIN_EXPAND_SATS = 100_000;
export const SKIPPED_MIN_STATUS = "skipped_min";

export function qualifiesForExpand(inboundSats: number, minExpandSats: number): boolean {
  return minExpandSats <= 0 || inboundSats >= minExpandSats;
}

/** Expand status to write, or undefined to leave the existing row unchanged. */
export function expandStatusToWrite(
  existingStatus: string | undefined,
  inboundSats: number,
  minExpandSats: number,
): string | undefined {
  const qualifies = qualifiesForExpand(inboundSats, minExpandSats);
  if (existingStatus == null || existingStatus === "") {
    return qualifies ? "pending" : SKIPPED_MIN_STATUS;
  }
  if (existingStatus === SKIPPED_MIN_STATUS && qualifies) return "pending";
  return undefined;
}
