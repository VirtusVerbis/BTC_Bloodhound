import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetLoadEnvFileForTests } from "./config.js";
import { resolveHackersPollMs } from "./hackersPoll.js";

describe("resolveHackersPollMs", () => {
  it("returns sidecar interval when cron is paused", () => {
    const config = loadConfig({
      HACKERS_POLL_MS: "3600000",
      HACKERS_POLL_MS_SIDECAR: "60000",
    });
    expect(resolveHackersPollMs(config, true)).toBe(60_000);
  });

  it("returns prod interval when cron is active", () => {
    const config = loadConfig({
      HACKERS_POLL_MS: "3600000",
      HACKERS_POLL_MS_SIDECAR: "60000",
    });
    expect(resolveHackersPollMs(config, false)).toBe(3_600_000);
  });
});

describe("hackersPollMsSidecar config", () => {
  afterEach(() => {
    resetLoadEnvFileForTests();
    delete process.env.HACKERS_POLL_MS_SIDECAR;
  });

  it("defaults hackersPollMsSidecar to 60000", () => {
    const config = loadConfig({});
    expect(config.hackersPollMsSidecar).toBe(60_000);
  });

  it("loads HACKERS_POLL_MS_SIDECAR from env", () => {
    const config = loadConfig({ HACKERS_POLL_MS_SIDECAR: "90000" });
    expect(config.hackersPollMsSidecar).toBe(90_000);
  });

  it("floors hackersPollMsSidecar at 60000", () => {
    const config = loadConfig({ HACKERS_POLL_MS_SIDECAR: "1000" });
    expect(config.hackersPollMsSidecar).toBe(60_000);
  });
});
