import { describe, expect, it } from "vitest";
import {
  classifyD1Error,
  D1QuotaExceededError,
  nextUtcMidnightIso,
} from "./d1Quota.js";

describe("classifyD1Error", () => {
  it("classifies daily row read limit messages", () => {
    const err = classifyD1Error(
      new Error(
        "Your account has exceeded D1's free tier daily row read limit. Wait until tomorrow (midnight UTC).",
      ),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("read");
    expect(new Date(err!.retryAt).getUTCHours()).toBe(0);
  });

  it("classifies daily row write limit messages", () => {
    const err = classifyD1Error(
      new Error("Your account has exceeded D1's free tier daily row write limit"),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("write");
  });

  it("classifies Drizzle-wrapped daily row read limit messages", () => {
    const err = classifyD1Error(
      new Error("Failed query: select * from hackers", {
        cause: new Error(
          "Your account has exceeded D1's free tier daily row read limit. Wait until tomorrow (midnight UTC).",
        ),
      }),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("read");
  });

  it("classifies Worker-runtime D1 read limit exceeded in cause chain", () => {
    const err = classifyD1Error(
      new Error("Failed query: select 1\nparams: 1", {
        cause: new Error("D1 read limit exceeded"),
      }),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("read");
  });

  it("classifies D1 daily read limit exceeded messages", () => {
    const err = classifyD1Error(
      new Error("D1 daily read limit exceeded; retry after 2026-09-02T00:00:00.000Z"),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("read");
  });

  it("classifies code 7500 write quota messages", () => {
    const err = classifyD1Error(
      new Error("D1 write limit exceeded [code: 7500]"),
    );
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("write");
  });

  it("classifies code 7500 without read/write hint as read", () => {
    const err = classifyD1Error(new Error("APIError code: 7500"));
    expect(err).toBeInstanceOf(D1QuotaExceededError);
    expect(err!.kind).toBe("read");
  });

  it("returns null for unrelated errors", () => {
    expect(classifyD1Error(new Error("disk I/O error"))).toBeNull();
    expect(
      classifyD1Error(
        new Error("D1_ERROR: internal error; reference = v0drihv3e7t48ani04qm85c8"),
      ),
    ).toBeNull();
  });
});

describe("nextUtcMidnightIso", () => {
  it("returns a future UTC midnight", () => {
    const midnight = new Date(nextUtcMidnightIso());
    expect(midnight.getTime()).toBeGreaterThan(Date.now());
    expect(midnight.getUTCHours()).toBe(0);
    expect(midnight.getUTCMinutes()).toBe(0);
  });
});
