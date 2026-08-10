import { address, networks } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { escapeLikePattern, normalizeBitcoinAddress } from "./address.js";
import { INVALID_VECTORS, VALID_MAINNET_VECTORS, validVectorByLabel } from "./addressVectors.js";

describe("normalizeBitcoinAddress", () => {
  describe.each(VALID_MAINNET_VECTORS)("$label ($source)", ({ input, expected }) => {
    it("accepts known-valid mainnet address", () => {
      expect(normalizeBitcoinAddress(input)).toBe(expected);
    });
  });

  describe.each(INVALID_VECTORS)("$label", ({ input }) => {
    it("rejects known-invalid address", () => {
      expect(normalizeBitcoinAddress(input)).toBeNull();
    });
  });

  it("taproot toOutputScript works with ECC initialized", () => {
    const taproot = validVectorByLabel("P2TR bc1p");
    expect(() => address.toOutputScript(taproot.input, networks.bitcoin)).not.toThrow();
  });
});

describe("escapeLikePattern", () => {
  it("escapes wildcards", () => {
    expect(escapeLikePattern("a%b_c")).toBe("a\\%b\\_c");
  });
});
