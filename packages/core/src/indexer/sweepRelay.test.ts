import { describe, expect, it } from "vitest";
import { detectSweepRelay } from "./sweepRelay.js";

describe("detectSweepRelay", () => {
  const config = {
    sweepRelayMinReceiveRatio: 0.7,
    sweepRelayMinVoutCount: 20,
    sweepRelayMinSpendTargetShare: 0.8,
  };

  it("matches peel relay pattern", () => {
    const receives = Array.from({ length: 18 }, (_, i) => ({
      txid: `r${i}`,
      isSpend: false,
      voutCount: 37,
    }));
    const spends = Array.from({ length: 5 }, (_, i) => ({
      txid: `s${i}`,
      isSpend: true,
      voutCount: 2,
    }));
    const target = "bc1qaccumxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const result = detectSweepRelay(
      {
        entries: [...receives, ...spends],
        spendTargets: [...Array(4).fill(target), "bc1qother"],
      },
      config,
    );
    expect(result.matched).toBe(true);
    expect(result.meta?.primarySweepTarget).toBe(target);
  });

  it("rejects balanced receive/spend mix", () => {
    const result = detectSweepRelay(
      {
        entries: [
          { txid: "a", isSpend: false, voutCount: 30 },
          { txid: "b", isSpend: true, voutCount: 2 },
        ],
        spendTargets: ["bc1q1", "bc1q2"],
      },
      config,
    );
    expect(result.matched).toBe(false);
  });
});
