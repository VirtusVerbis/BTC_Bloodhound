import { describe, expect, it } from "vitest";
import { isD1TransportError } from "./d1Transport.js";

describe("isD1TransportError", () => {
  it("returns true for D1 internal error with reference", () => {
    const err = new Error("Failed query: select 1", {
      cause: new Error("D1_ERROR: internal error; reference = v0drihv3e7t48ani04qm85c8"),
    });
    expect(isD1TransportError(err)).toBe(true);
  });

  it("returns true for JSON parse failure from miniflare proxy", () => {
    const err = new Error(
      "D1_ERROR: Failed to parse body as JSON, got: Error: internal error; reference = abc",
    );
    expect(isD1TransportError(err)).toBe(true);
  });

  it("returns false for D1 daily quota errors", () => {
    const err = new Error("D1 daily read limit exceeded; retry after 2026-08-31", {
      cause: new Error("free tier daily row read limit exceeded"),
    });
    expect(isD1TransportError(err)).toBe(false);
  });

  it("returns false for schema errors", () => {
    expect(isD1TransportError(new Error("no such table: scheduler_state"))).toBe(false);
  });
});
