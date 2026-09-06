import { describe, expect, it, vi } from "vitest";
import {
  confirmUnknownHackerSource,
  formatKnownHackerSourcesList,
  isKnownHackerSource,
  resolveHackerSourceFlag,
} from "./hackerSourcePrompt.js";

describe("hackerSourcePrompt", () => {
  it("resolveHackerSourceFlag defaults to ops", () => {
    expect(resolveHackerSourceFlag()).toBe("ops");
    expect(resolveHackerSourceFlag("")).toBe("ops");
    expect(resolveHackerSourceFlag("   ")).toBe("ops");
  });

  it("resolveHackerSourceFlag trims custom values", () => {
    expect(resolveHackerSourceFlag(" admin ")).toBe("admin");
    expect(resolveHackerSourceFlag("partner_feed")).toBe("partner_feed");
  });

  it("isKnownHackerSource recognizes known categories", () => {
    expect(isKnownHackerSource("ops")).toBe(true);
    expect(isKnownHackerSource("admin")).toBe(true);
    expect(isKnownHackerSource("coldcard_hack_tracker")).toBe(true);
    expect(isKnownHackerSource("partner_feed")).toBe(false);
  });

  it("formatKnownHackerSourcesList includes known keys", () => {
    const list = formatKnownHackerSourcesList();
    expect(list).toContain("Known hacker source categories:");
    expect(list).toContain("ops");
    expect(list).toContain("Ops CLI");
  });

  it("confirmUnknownHackerSource returns false for non-tty", async () => {
    const logWarn = vi.fn();
    const result = await confirmUnknownHackerSource({
      source: "custom",
      ask: vi.fn(),
      isTty: false,
      logWarn,
    });
    expect(result).toBe(false);
    expect(logWarn).toHaveBeenCalled();
  });

  it("confirmUnknownHackerSource accepts y", async () => {
    const result = await confirmUnknownHackerSource({
      source: "custom",
      ask: vi.fn().mockResolvedValue("y"),
      isTty: true,
      logWarn: vi.fn(),
    });
    expect(result).toBe(true);
  });

  it("confirmUnknownHackerSource rejects empty answer", async () => {
    const result = await confirmUnknownHackerSource({
      source: "custom",
      ask: vi.fn().mockResolvedValue(""),
      isTty: true,
      logWarn: vi.fn(),
    });
    expect(result).toBe(false);
  });
});
