import { describe, expect, it } from "vitest";
import { expandStatusToWrite, qualifiesForExpand, SKIPPED_MIN_STATUS } from "./expandSkip.js";

describe("expandSkip", () => {
  it("qualifies when min is zero or inbound meets the floor", () => {
    expect(qualifiesForExpand(1, 0)).toBe(true);
    expect(qualifiesForExpand(50_000, 100_000)).toBe(false);
    expect(qualifiesForExpand(100_000, 100_000)).toBe(true);
  });

  it("writes pending or skipped_min for new addresses", () => {
    expect(expandStatusToWrite(undefined, 50_000, 100_000)).toBe(SKIPPED_MIN_STATUS);
    expect(expandStatusToWrite("", 150_000, 100_000)).toBe("pending");
  });

  it("promotes skipped_min when inbound clears the floor", () => {
    expect(expandStatusToWrite(SKIPPED_MIN_STATUS, 50_000, 100_000)).toBeUndefined();
    expect(expandStatusToWrite(SKIPPED_MIN_STATUS, 150_000, 100_000)).toBe("pending");
  });

  it("does not overwrite in-flight or done statuses", () => {
    for (const status of ["pending", "queued", "expanding", "expanded", "max_depth", "backfilling"]) {
      expect(expandStatusToWrite(status, 50_000, 100_000)).toBeUndefined();
      expect(expandStatusToWrite(status, 150_000, 100_000)).toBeUndefined();
    }
  });
});
