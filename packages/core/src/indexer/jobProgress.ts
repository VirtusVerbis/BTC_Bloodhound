export interface IngestProgressSnapshot {
  processedIndex: number;
  headTxid: string | null;
  chainCursor: string | null;
}

export function extractIngestProgress(payloadJson: string): IngestProgressSnapshot | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  const processedIndex = typeof payload.processedIndex === "number" ? payload.processedIndex : 0;
  let headTxid: string | null = null;

  const pendingTxs = payload.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > processedIndex) {
    const entry = pendingTxs[processedIndex] as { txid?: string };
    headTxid = entry?.txid ?? null;
  } else {
    const pendingTxids = payload.pendingTxids;
    if (Array.isArray(pendingTxids) && pendingTxids.length > processedIndex) {
      headTxid = String(pendingTxids[processedIndex]);
    }
  }

  const chainCursor =
    payload.chainCursor != null && payload.chainCursor !== ""
      ? String(payload.chainCursor)
      : null;

  return { processedIndex, headTxid, chainCursor };
}

export function progressUnchanged(
  before: string | null | undefined,
  after: IngestProgressSnapshot,
): boolean {
  if (!before) return false;
  let prev: IngestProgressSnapshot;
  try {
    prev = JSON.parse(before) as IngestProgressSnapshot;
  } catch {
    return false;
  }
  return (
    prev.processedIndex === after.processedIndex &&
    prev.headTxid === after.headTxid &&
    prev.chainCursor === after.chainCursor
  );
}

export function snapshotToJson(snapshot: IngestProgressSnapshot): string {
  return JSON.stringify(snapshot);
}
