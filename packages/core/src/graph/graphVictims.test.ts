import { describe, expect, it } from "vitest";
import { filterDownstreamEdgesExcludingVictims } from "./graphVictims.js";

describe("filterDownstreamEdgesExcludingVictims", () => {
  it("removes edges targeting known victims", () => {
    const victimSet = new Set(["bc1qvictim"]);
    const edges = [
      { toAddress: "bc1qvictim", amountSats: 1000 },
      { toAddress: "bc1qdownstream", amountSats: 5000 },
    ];
    expect(filterDownstreamEdgesExcludingVictims(edges, victimSet)).toEqual([
      { toAddress: "bc1qdownstream", amountSats: 5000 },
    ]);
  });

  it("returns all edges when victim set is empty", () => {
    const edges = [{ toAddress: "bc1qvictim", amountSats: 1000 }];
    expect(filterDownstreamEdgesExcludingVictims(edges, new Set())).toEqual(edges);
  });
});
