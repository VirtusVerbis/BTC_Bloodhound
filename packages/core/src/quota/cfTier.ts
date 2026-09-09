import type { EnvMap } from "../config.js";

export type CfWorkersTier = "free" | "paid";

export type CfTierQuotaDefaults = {
  cronQuotaUtilizationPct: number;
  d1ReadDailyLimit: number;
  d1WriteDailyLimit: number;
  workersRequestDailyLimit: number;
  subrequestLimitPerInvocation: number;
};

export type CfTierQuotaConfig = CfTierQuotaDefaults & {
  tier: CfWorkersTier;
};

/** Built-in pacing defaults per Cloudflare Workers billing tier. */
export const CF_TIER_DEFAULTS: Record<CfWorkersTier, CfTierQuotaDefaults> = {
  free: {
    cronQuotaUtilizationPct: 80,
    d1ReadDailyLimit: 5_000_000,
    d1WriteDailyLimit: 100_000,
    workersRequestDailyLimit: 100_000,
    subrequestLimitPerInvocation: 50,
  },
  paid: {
    cronQuotaUtilizationPct: 100,
    d1ReadDailyLimit: 833_333_333,
    d1WriteDailyLimit: 1_666_666,
    workersRequestDailyLimit: 10_000_000,
    subrequestLimitPerInvocation: 1000,
  },
};

export function parseCfWorkersTier(env: EnvMap): CfWorkersTier {
  const raw = (env.CF_WORKERS_TIER ?? "free").trim().toLowerCase();
  return raw === "paid" ? "paid" : "free";
}

function envIsSet(env: EnvMap, key: string): boolean {
  const v = env[key];
  return v != null && v !== "";
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 100));
}

function resolvePositiveInt(env: EnvMap, key: string, fallback: number): number {
  if (!envIsSet(env, key)) return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function resolveNonNegativeInt(env: EnvMap, key: string, fallback: number): number {
  if (!envIsSet(env, key)) return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function resolveCronQuotaUtilizationPct(env: EnvMap, tier: CfWorkersTier): number {
  if (envIsSet(env, "CRON_QUOTA_UTILIZATION_PCT")) {
    return clampPct(Number(env.CRON_QUOTA_UTILIZATION_PCT));
  }
  const tierKey =
    tier === "paid" ? "CRON_QUOTA_UTILIZATION_PCT_PAID" : "CRON_QUOTA_UTILIZATION_PCT_FREE";
  if (envIsSet(env, tierKey)) {
    return clampPct(Number(env[tierKey]));
  }
  return CF_TIER_DEFAULTS[tier].cronQuotaUtilizationPct;
}

/**
 * Resolve quota pacing settings from env.
 * Order per field: explicit env var → tier-specific cron var (cron pct only) → tier preset.
 */
export function resolveCfTierQuotaConfig(env: EnvMap): CfTierQuotaConfig {
  const tier = parseCfWorkersTier(env);
  const defaults = CF_TIER_DEFAULTS[tier];

  return {
    tier,
    cronQuotaUtilizationPct: resolveCronQuotaUtilizationPct(env, tier),
    d1ReadDailyLimit: resolvePositiveInt(env, "D1_READ_DAILY_LIMIT", defaults.d1ReadDailyLimit),
    d1WriteDailyLimit: resolvePositiveInt(env, "D1_WRITE_DAILY_LIMIT", defaults.d1WriteDailyLimit),
    workersRequestDailyLimit: resolvePositiveInt(
      env,
      "WORKERS_REQUEST_DAILY_LIMIT",
      defaults.workersRequestDailyLimit,
    ),
    subrequestLimitPerInvocation: resolveNonNegativeInt(
      env,
      "SUBREQUEST_LIMIT_PER_INVOCATION",
      defaults.subrequestLimitPerInvocation,
    ),
  };
}
