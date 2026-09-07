import { describe, expect, it } from "vitest";
import { JOB_PRIORITY } from "../config.js";
import { expandOpsFields, resolveExpandJobPriority } from "./expandPriority.js";

describe("expandPriority", () => {
  it("returns CRON_EXPAND when ops is absent", () => {
    expect(resolveExpandJobPriority({ address: "bc1qtest" })).toBe(JOB_PRIORITY.CRON_EXPAND);
  });

  it("returns CRON_EXPAND when ops is true but opsPriority missing", () => {
    expect(resolveExpandJobPriority({ address: "bc1qtest", ops: true })).toBe(JOB_PRIORITY.CRON_EXPAND);
  });

  it("returns opsPriority when ops is true and opsPriority is valid", () => {
    expect(resolveExpandJobPriority({ address: "bc1qtest", ops: true, opsPriority: 11 })).toBe(11);
  });

  it("ignores invalid opsPriority", () => {
    expect(resolveExpandJobPriority({ address: "bc1qtest", ops: true, opsPriority: 0 })).toBe(
      JOB_PRIORITY.CRON_EXPAND,
    );
    expect(expandOpsFields({ address: "bc1qtest", ops: true, opsPriority: 0 })).toEqual({ ops: true });
  });

  it("expandOpsFields returns ops and opsPriority when valid", () => {
    expect(expandOpsFields({ ops: true, opsPriority: 11 })).toEqual({ ops: true, opsPriority: 11 });
  });
});
