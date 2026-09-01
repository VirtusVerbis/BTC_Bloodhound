import { describe, expect, it } from "vitest";
import { formatHoursMinutesCountdown, formatJobDuration } from "./MonitoringIndicator";

describe("formatHoursMinutesCountdown", () => {
  it("formats seconds as HH:MM:SS", () => {
    expect(formatHoursMinutesCountdown(17841)).toBe("04:57:21");
    expect(formatHoursMinutesCountdown(3600)).toBe("01:00:00");
    expect(formatHoursMinutesCountdown(90)).toBe("00:01:30");
  });

  it("returns 00:00:00 for empty or non-positive values", () => {
    expect(formatHoursMinutesCountdown(null)).toBe("00:00:00");
    expect(formatHoursMinutesCountdown(0)).toBe("00:00:00");
  });
});

describe("formatJobDuration", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(formatJobDuration(null)).toBe("—");
    expect(formatJobDuration(123)).toBe("123ms");
    expect(formatJobDuration(1200)).toBe("1.2s");
    expect(formatJobDuration(12_400)).toBe("12s");
    expect(formatJobDuration(185_000)).toBe("3m 05s");
  });
});
