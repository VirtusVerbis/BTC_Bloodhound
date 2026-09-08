import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";

export async function isRebuildActive(
  store: Store,
  config: AppConfig,
  processTxCount?: number,
): Promise<boolean> {
  if (config.indexerRebuildMode) return true;
  const count = processTxCount ?? (await store.countActiveJobs("process_tx"));
  return count > 0;
}

export async function processTxPriority(store: Store, config: AppConfig): Promise<number> {
  if (await isRebuildActive(store, config)) {
    return config.processTxRebuildPriority;
  }
  return JOB_PRIORITY.PROCESS_TX;
}
