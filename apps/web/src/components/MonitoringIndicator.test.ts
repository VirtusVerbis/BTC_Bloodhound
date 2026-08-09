import { describe, expect, it } from "vitest";
import { formatJobDuration } from "./MonitoringIndicator";

describe("formatJobDuration", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(formatJobDuration(null)).toBe("—");
    expect(formatJobDuration(123)).toBe("123ms");
    expect(formatJobDuration(1200)).toBe("1.2s");
    expect(formatJobDuration(12_400)).toBe("12s");
    expect(formatJobDuration(185_000)).toBe("3m 05s");
  });
});
