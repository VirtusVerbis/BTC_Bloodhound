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

  it("returns null for unrelated errors", () => {
    expect(classifyD1Error(new Error("disk I/O error"))).toBeNull();
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
