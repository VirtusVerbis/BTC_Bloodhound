import { describe, expect, it } from "vitest";
import {
  batchesToSkip,
  computeProgressPct,
  nextImportIndex,
  splitSqlStatements,
} from "../../../../scripts/db-sync-helpers.mjs";

describe("db-sync-helpers", () => {
  it("computeProgressPct", () => {
    expect(computeProgressPct(0, 10)).toBe(0);
    expect(computeProgressPct(5, 10)).toBe(50);
    expect(computeProgressPct(10, 10)).toBe(100);
    expect(computeProgressPct(0, 0)).toBe(100);
  });

  it("batchesToSkip resumes from completed ids", () => {
    expect(batchesToSkip(["a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "d"]);
    expect(batchesToSkip([], ["a"])).toEqual(["a"]);
  });

  it("splitSqlStatements respects quotes", () => {
    const stmts = splitSqlStatements("INSERT INTO t VALUES ('a;b'); DELETE FROM t;");
    expect(stmts.map((s) => s.trim())).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "DELETE FROM t",
    ]);
  });

  it("nextImportIndex clamps", () => {
    expect(nextImportIndex(5, 10)).toBe(5);
    expect(nextImportIndex(99, 10)).toBe(0);
    expect(nextImportIndex(-1, 10)).toBe(0);
  });
});
