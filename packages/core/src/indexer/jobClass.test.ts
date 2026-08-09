import { describe, expect, it } from "vitest";
import { jobClassForType, isIngestContinuation, isIngestJobType } from "./jobClass.js";

describe("jobClassForType", () => {
  it("classifies ingest jobs", () => {
    expect(jobClassForType("backfill_hacker_address")).toBe("ingest");
    expect(jobClassForType("audit_hacker_backfill")).toBe("ingest");
    expect(jobClassForType("expand_downstream")).toBe("ingest");
  });

  it("classifies maintenance jobs", () => {
    expect(jobClassForType("poll_hacker_address")).toBe("maint");
    expect(jobClassForType("process_tx")).toBe("maint");
  });

  it("classifies cosmetic jobs", () => {
    expect(jobClassForType("refresh_live_balance")).toBe("cosmetic");
    expect(jobClassForType("refresh_btc_usd_price")).toBe("cosmetic");
  });
});

describe("isIngestJobType", () => {
  it("returns true only for ingest types", () => {
    expect(isIngestJobType("expand_downstream")).toBe(true);
    expect(isIngestJobType("poll_hacker_address")).toBe(false);
  });
});

describe("isIngestContinuation", () => {
  it("returns true when chainCursor is set", () => {
    expect(
      isIngestContinuation(JSON.stringify({ address: "bc1q", chainCursor: "txabc" })),
    ).toBe(true);
  });

  it("returns true when pendingTxids is non-empty", () => {
    expect(
      isIngestContinuation(JSON.stringify({ address: "bc1q", pendingTxids: ["tx1", "tx2"] })),
    ).toBe(true);
  });

  it("returns false for fresh expand payload", () => {
    expect(isIngestContinuation(JSON.stringify({ address: "bc1q", cron: true }))).toBe(false);
  });

  it("returns true when pagesExhausted is false and pagesFetched > 0", () => {
    expect(
      isIngestContinuation(
        JSON.stringify({ address: "bc1q", pagesExhausted: false, pagesFetched: 1 }),
      ),
    ).toBe(true);
  });
});
