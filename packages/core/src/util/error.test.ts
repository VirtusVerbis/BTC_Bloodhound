import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "./error.js";

describe("formatErrorMessage", () => {
  it("returns plain Error message unchanged", () => {
    expect(formatErrorMessage(new Error("429 Too Many Requests"))).toBe("429 Too Many Requests");
  });

  it("appends cause message for wrapped errors", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(formatErrorMessage(err)).toBe("outer; cause: inner");
  });

  it("flattens multiline messages to one line", () => {
    const err = new Error("Failed query: select 1\nparams: 1", {
      cause: new Error("D1 read limit exceeded"),
    });
    expect(formatErrorMessage(err)).toBe(
      "Failed query: select 1 params: 1; cause: D1 read limit exceeded",
    );
  });

  it("does not recurse beyond one cause level", () => {
    const err = new Error("outer", {
      cause: new Error("middle", { cause: new Error("deep") }),
    });
    expect(formatErrorMessage(err)).toBe("outer; cause: middle");
  });

  it("stringifies non-Error values", () => {
    expect(formatErrorMessage("disk I/O error")).toBe("disk I/O error");
  });
});
