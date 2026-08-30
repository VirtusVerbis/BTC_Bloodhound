import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { createD1Store, type D1Binding } from "@cointrace/db/d1";
import type { Store } from "@cointrace/db";
import type { AppConfig } from "@cointrace/core";

export interface RemoteProductionStore {
  store: Store;
  dispose: () => Promise<void>;
}

/** Ensure getPlatformProxy reached a populated prod D1, not empty local wrangler state. */
export async function verifyRemoteProductionStore(store: Store): Promise<void> {
  let state: Awaited<ReturnType<Store["getSchedulerState"]>>;
  try {
    state = await store.getSchedulerState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|cron_indexer_paused/i.test(message)) {
      throw new Error(
        "Connected D1 schema mismatch (local wrangler D1 or missing migration). " +
          "Run pnpm db:d1:migrate:remote and set remote = true on [[env.production.d1_databases]].",
        { cause: error },
      );
    }
    throw error;
  }

  if (!state) {
    throw new Error(
      "scheduler_state row missing — connected D1 looks empty/local, not production. " +
        "Ensure [[env.production.d1_databases]] has remote = true in wrangler.toml and run npx wrangler login.",
    );
  }
}

export async function openRemoteProductionStore(config: AppConfig): Promise<RemoteProductionStore> {
  const configPath = path.resolve(process.cwd(), "wrangler.toml");
  const { env, dispose } = await getPlatformProxy({
    configPath,
    environment: "production",
    remoteBindings: true,
    // Avoid persisting proxy state to .wrangler/state (empty local D1).
    persist: false,
  });

  const store = createD1Store(env.DB as D1Binding, {
    maxQueueDepth: config.maxQueueDepth,
    d1BatchSize: config.d1BatchSize,
  });

  await verifyRemoteProductionStore(store);

  return {
    store,
    dispose: async () => {
      await dispose();
    },
  };
}
