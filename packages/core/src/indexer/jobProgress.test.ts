import { describe, expect, it } from "vitest";
import { extractIngestProgress, progressUnchanged } from "./jobProgress.js";

describe("jobProgress", () => {
  it("extracts progress from pendingTxs payload", () => {
    const payload = JSON.stringify({
      processedIndex: 2,
      pendingTxs: [{ txid: "a" }, { txid: "b" }, { txid: "c" }],
      chainCursor: "cursor1",
    });
    const snap = extractIngestProgress(payload);
    expect(snap).toEqual({
      processedIndex: 2,
      headTxid: "c",
      chainCursor: "cursor1",
    });
  });

  it("detects unchanged progress", () => {
    const before = JSON.stringify({ processedIndex: 1, headTxid: "tx2", chainCursor: null });
    const after = { processedIndex: 1, headTxid: "tx2", chainCursor: null };
    expect(progressUnchanged(before, after)).toBe(true);
    expect(progressUnchanged(before, { ...after, processedIndex: 2 })).toBe(false);
  });
});
