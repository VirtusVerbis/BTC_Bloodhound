import { describe, expect, it } from "vitest";
import { diffCalendarYMD, formatHackElapsed, HACK_START_DATE } from "./hackElapsed";

describe("diffCalendarYMD", () => {
  it("counts days within the same month", () => {
    expect(diffCalendarYMD(HACK_START_DATE, new Date(2026, 7, 7))).toEqual({
      years: 0,
      months: 0,
      days: 8,
    });
  });

  it("counts whole months and zero days", () => {
    expect(diffCalendarYMD(HACK_START_DATE, new Date(2026, 7, 30))).toEqual({
      years: 0,
      months: 1,
      days: 0,
    });
  });

  it("counts years, months, and days", () => {
    expect(diffCalendarYMD(HACK_START_DATE, new Date(2027, 9, 15))).toEqual({
      years: 1,
      months: 2,
      days: 15,
    });
  });
});

describe("formatHackElapsed", () => {
  it("formats days only before one month", () => {
    expect(formatHackElapsed(new Date(2026, 7, 7))).toBe(
      "8 Days since July 30, 2026.  BTC was $63,934 USD",
    );
  });

  it("formats months and days", () => {
    expect(formatHackElapsed(new Date(2026, 7, 30))).toBe(
      "1 Month 0 Days since July 30, 2026.  BTC was $63,934 USD",
    );
    expect(formatHackElapsed(new Date(2026, 8, 4))).toBe(
      "1 Month 5 Days since July 30, 2026.  BTC was $63,934 USD",
    );
  });

  it("formats years, months, and days", () => {
    expect(formatHackElapsed(new Date(2027, 9, 15))).toBe(
      "1 Year 2 Months 15 Days since July 30, 2026.  BTC was $63,934 USD",
    );
  });

  it("returns zero days before the anchor date", () => {
    expect(formatHackElapsed(new Date(2026, 6, 29))).toBe(
      "0 Days since July 30, 2026.  BTC was $63,934 USD",
    );
  });

  it("uses singular units when value is 1", () => {
    expect(formatHackElapsed(new Date(2026, 7, 30))).toContain("1 Month");
    expect(formatHackElapsed(new Date(2026, 6, 31))).toBe(
      "1 Day since July 30, 2026.  BTC was $63,934 USD",
    );
  });
});
