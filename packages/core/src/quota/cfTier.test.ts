import { describe, expect, it } from "vitest";
import {
  CF_TIER_DEFAULTS,
  parseCfWorkersTier,
  resolveCfTierQuotaConfig,
} from "./cfTier.js";

describe("parseCfWorkersTier", () => {
  it("defaults to free", () => {
    expect(parseCfWorkersTier({})).toBe("free");
  });

  it("parses paid", () => {
    expect(parseCfWorkersTier({ CF_WORKERS_TIER: "paid" })).toBe("paid");
  });

  it("falls back to free for unknown values", () => {
    expect(parseCfWorkersTier({ CF_WORKERS_TIER: "enterprise" })).toBe("free");
  });
});

describe("resolveCfTierQuotaConfig", () => {
  it("uses free tier defaults", () => {
    const config = resolveCfTierQuotaConfig({ CF_WORKERS_TIER: "free" });
    expect(config).toEqual({
      tier: "free",
      ...CF_TIER_DEFAULTS.free,
    });
  });

  it("uses paid tier defaults", () => {
    const config = resolveCfTierQuotaConfig({ CF_WORKERS_TIER: "paid" });
    expect(config).toEqual({
      tier: "paid",
      ...CF_TIER_DEFAULTS.paid,
    });
  });

  it("lets CRON_QUOTA_UTILIZATION_PCT override tier cron values", () => {
    const config = resolveCfTierQuotaConfig({
      CF_WORKERS_TIER: "free",
      CRON_QUOTA_UTILIZATION_PCT: "90",
      CRON_QUOTA_UTILIZATION_PCT_FREE: "80",
    });
    expect(config.cronQuotaUtilizationPct).toBe(90);
  });

  it("uses tier-specific cron vars when global override is unset", () => {
    const config = resolveCfTierQuotaConfig({
      CF_WORKERS_TIER: "paid",
      CRON_QUOTA_UTILIZATION_PCT_PAID: "95",
    });
    expect(config.cronQuotaUtilizationPct).toBe(95);
  });

  it("lets explicit D1 limits override tier presets", () => {
    const config = resolveCfTierQuotaConfig({
      CF_WORKERS_TIER: "free",
      D1_WRITE_DAILY_LIMIT: "200000",
    });
    expect(config.d1WriteDailyLimit).toBe(200_000);
  });

  it("lets explicit subrequest limit override tier preset", () => {
    const config = resolveCfTierQuotaConfig({
      CF_WORKERS_TIER: "paid",
      SUBREQUEST_LIMIT_PER_INVOCATION: "0",
    });
    expect(config.subrequestLimitPerInvocation).toBe(0);
  });
});
