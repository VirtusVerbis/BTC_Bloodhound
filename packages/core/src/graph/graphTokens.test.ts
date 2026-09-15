import { describe, expect, it } from "vitest";
import { decodeL2Cursor, encodeL2Cursor } from "./graphTokens.js";

describe("L2 cursor", () => {
  it("round-trips empty toAddress and loadedFromParent", () => {
    const encoded = encodeL2Cursor({
      parentIndex: 3,
      amountSats: 0,
      toAddress: "",
      loadedFromParent: 12,
    });
    expect(decodeL2Cursor(encoded)).toEqual({
      parentIndex: 3,
      amountSats: 0,
      toAddress: "",
      loadedFromParent: 12,
    });
  });

  it("defaults loadedFromParent when omitted", () => {
    const encoded = encodeL2Cursor({
      parentIndex: 1,
      amountSats: 500,
      toAddress: "bc1qchild",
    });
    expect(decodeL2Cursor(encoded)).toEqual({
      parentIndex: 1,
      amountSats: 500,
      toAddress: "bc1qchild",
      loadedFromParent: 0,
    });
  });
});
