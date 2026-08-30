import type { AppConfig } from "./config.js";

/** Client /api/hackers poll interval: faster while cron is paused (sidecar drain). */
export function resolveHackersPollMs(config: AppConfig, cronIndexerPaused: boolean): number {
  return cronIndexerPaused ? config.hackersPollMsSidecar : config.hackersPollMs;
}
