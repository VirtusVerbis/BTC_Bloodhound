import { describe, expect, it } from "vitest";
import { assertProductionSecrets, loadConfig, type AppConfig } from "./config.js";

describe("assertProductionSecrets", () => {
  it("requires CORS_ORIGINS in production and does not require ADMIN_TOKEN", () => {
    const base = loadConfig({
      ENVIRONMENT: "production",
      CORS_ORIGINS: "https://example.com",
    });
    expect(() => assertProductionSecrets(base)).not.toThrow();
    expect("adminToken" in base).toBe(false);
    expect("maxGraphOutputs" in base).toBe(false);

    const missingCors: AppConfig = { ...base, corsOriginsFromEnv: false, corsOrigins: [] };
    expect(() => assertProductionSecrets(missingCors)).toThrow(/CORS_ORIGINS/);
  });
});
