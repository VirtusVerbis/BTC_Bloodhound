import { describe, expect, it } from "vitest";
import { escapeLikePattern, normalizeBitcoinAddress } from "./address.js";

describe("normalizeBitcoinAddress", () => {
  it("accepts bech32 and lowercases", () => {
    expect(normalizeBitcoinAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
  });

  it("accepts legacy P2PKH/P2SH shapes", () => {
    expect(normalizeBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    );
  });

  it("rejects SQL-ish junk", () => {
    expect(normalizeBitcoinAddress("'; DROP TABLE addresses;--")).toBeNull();
    expect(normalizeBitcoinAddress("bc1';evil")).toBeNull();
  });
});

describe("escapeLikePattern", () => {
  it("escapes wildcards", () => {
    expect(escapeLikePattern("a%b_c")).toBe("a\\%b\\_c");
  });
});
