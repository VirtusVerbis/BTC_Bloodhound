import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetLoadEnvFileForTests } from "./config.js";

describe("loadEnvFile via loadConfig", () => {
  let tempDir: string | null = null;
  const savedRateLimit = process.env.RATE_LIMIT_MS;
  const savedDotenvPath = process.env.DOTENV_CONFIG_PATH;

  afterEach(() => {
    resetLoadEnvFileForTests();
    if (savedRateLimit === undefined) delete process.env.RATE_LIMIT_MS;
    else process.env.RATE_LIMIT_MS = savedRateLimit;
    if (savedDotenvPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = savedDotenvPath;
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("loads RATE_LIMIT_MS from DOTENV_CONFIG_PATH when using default process.env", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cointrace-env-"));
    const envPath = path.join(tempDir, ".env");
    writeFileSync(envPath, "RATE_LIMIT_MS=9999\n", "utf8");

    delete process.env.RATE_LIMIT_MS;
    process.env.DOTENV_CONFIG_PATH = envPath;
    resetLoadEnvFileForTests();

    const config = loadConfig();
    expect(config.rateLimitMs).toBe(9999);
  });

  it("defaults rateLimitMs to 8000 when env is unset", () => {
    delete process.env.RATE_LIMIT_MS;
    process.env.DOTENV_CONFIG_PATH = path.join(tmpdir(), "nonexistent-cointrace-.env");
    resetLoadEnvFileForTests();

    const config = loadConfig({} as Record<string, string | undefined>);
    expect(config.rateLimitMs).toBe(8000);
  });

  it("loads CHAIN_PRIMARY_PROVIDER mempool when set", () => {
    const config = loadConfig({ CHAIN_PRIMARY_PROVIDER: "mempool" });
    expect(config.chainPrimaryProvider).toBe("mempool");
  });

  it("defaults chainPrimaryProvider to esplora", () => {
    const config = loadConfig({} as Record<string, string | undefined>);
    expect(config.chainPrimaryProvider).toBe("esplora");
  });
});
