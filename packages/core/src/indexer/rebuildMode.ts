import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";

export function isRebuildActive(store: Store, config: AppConfig): boolean {
  if (config.indexerRebuildMode) return true;
  return store.countActiveJobs("process_tx") > 0;
}

export function processTxPriority(store: Store, config: AppConfig): number {
  if (isRebuildActive(store, config)) {
    return config.processTxRebuildPriority;
  }
  return JOB_PRIORITY.PROCESS_TX;
}
