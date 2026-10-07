import { describe, expect, it } from "vitest";
import { formatSourceLabel } from "../lib/hackerGroups";
import { monitoredSiteHasPollError } from "./aboutContent";

describe("monitoredSiteHasPollError", () => {
  const sources = [
    { source: "coldcard_sweep_watch", lastError: "ColdcardSweepWatch wave3 fetch failed: 500" },
    { source: "coldcard_hack_tracker", lastError: null },
    { source: "bitquery_coldcard", lastError: "" },
  ];

  it("shows the badge only when the mapped source has lastError", () => {
    expect(monitoredSiteHasPollError("coldcard-watch.vercel.app", sources)).toBe(true);
    expect(monitoredSiteHasPollError("coldcard-hack-tracker.vercel.app", sources)).toBe(false);
    expect(monitoredSiteHasPollError("coldcardwatch.com", sources)).toBe(false);
    expect(monitoredSiteHasPollError("bitquery.io", sources)).toBe(false);
    expect(monitoredSiteHasPollError("bitquery.io", undefined)).toBe(false);
  });

  it("labels the Bitquery sync row", () => {
    expect(formatSourceLabel("bitquery_coldcard")).toBe("Bitquery Coldcard Hack");
  });
});
