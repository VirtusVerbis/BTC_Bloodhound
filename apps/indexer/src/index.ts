import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import {
  addHacker,
  ChainRouter,
  clearQueue,
  JOB_PRIORITY,
  loadConfig,
  normalizeBitcoinAddress,
  removeHacker,
  runIndexerTick,
  runLoadLocalWatchlist,
  runReBackfillHacker,
  runReBackfillHackers,
  runReBackfillHackersWait,
  runReBackfillHackerWait,
  runRebuildHackEdges,
  runRebuildHackEdgesWait,
  runSeedPublicHackers,
} from "@cointrace/core";
import {
  addHackerRemote,
  clearQueueRemote,
  D1WranglerClient,
  removeHackerRemote,
} from "./d1Wrangler.js";

const config = loadConfig();
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "run";
const remote = argv.includes("--remote");

function flagValue(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith("--")) return argv[idx + 1];
  return undefined;
}

function positionalArgs(): string[] {
  return argv.slice(1).filter((a) => !a.startsWith("--"));
}

function openLocalStore(): Store {
  const dbPath = path.resolve(config.databaseUrl.replace("file:", ""));
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const { sqlite, db } = openDatabase(dbPath);
  runMigrations(sqlite);
  return new Store(db);
}

function remoteClient(): D1WranglerClient {
  return new D1WranglerClient({ remote: true });
}

async function main() {
  if (cmd === "seed") {
    const store = openLocalStore();
    await runSeedPublicHackers(store, config.seedFilePath, config.seedDataJson);
    console.log("Seed complete");
    return;
  }
  if (cmd === "load-local") {
    const store = openLocalStore();
    await runLoadLocalWatchlist(store, config.localWatchlistPath, config.localWatchlistDataJson);
    console.log("Local watchlist loaded");
    return;
  }
  if (cmd === "add-hacker") {
    const address = positionalArgs()[0] ?? "";
    const label = flagValue("--label");
    if (!normalizeBitcoinAddress(address)) {
      console.error("Usage: add-hacker <address> [--label ...] [--remote]");
      process.exit(1);
    }
    const result = remote
      ? await addHackerRemote(remoteClient(), { address, label })
      : await addHacker(openLocalStore(), { address, label });
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result,
          target: remote ? "remote-d1" : "local-sqlite",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === "remove-hacker") {
    const address = positionalArgs()[0] ?? "";
    const noPrune = argv.includes("--no-prune");
    if (!normalizeBitcoinAddress(address)) {
      console.error("Usage: remove-hacker <address> [--no-prune] [--remote]");
      process.exit(1);
    }
    const result = remote
      ? await removeHackerRemote(remoteClient(), address, { pruneExclusive: !noPrune })
      : await removeHacker(openLocalStore(), address, { pruneExclusive: !noPrune });
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "clear-queue") {
    const result = remote ? await clearQueueRemote(remoteClient()) : await clearQueue(openLocalStore());
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "re-backfill-hackers") {
    const store = openLocalStore();
    const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs);
    const wait = argv.includes("--wait");
    const fresh = argv.includes("--fresh");
    if (wait) {
      const reclaimed = await store.resetRunningJobs();
      if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
      }
      const n = await runReBackfillHackersWait(store, router, config, { fresh });
      console.log(`Re-backfill finished for ${n} hacker address(es)`);
    } else {
      const n = await runReBackfillHackers(store, { fresh });
      console.log(`Re-backfill queued for ${n} hacker address(es)`);
    }
    return;
  }
  if (cmd === "re-backfill-hacker") {
    const store = openLocalStore();
    const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs);
    const address = normalizeBitcoinAddress(positionalArgs()[0] ?? "");
    if (!address) {
      console.error("Usage: re-backfill-hacker <address> [--wait] [--fresh]");
      process.exit(1);
    }
    const wait = argv.includes("--wait");
    const fresh = argv.includes("--fresh");
    if (wait) {
      const reclaimed = await store.resetRunningJobs();
      if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
      }
      await runReBackfillHackerWait(store, router, config, address, { fresh });
    } else {
      await runReBackfillHacker(store, address);
      await store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
      console.log(`Re-backfill queued for ${address}`);
    }
    return;
  }
  if (cmd === "rebuild-hack-edges") {
    const store = openLocalStore();
    const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs);
    const wait = argv.includes("--wait");
    if (wait) {
      const reclaimed = await store.resetRunningJobs();
      if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
      }
      const n = await runRebuildHackEdgesWait(store, router, config);
      console.log(`Rebuild finished for ${n} transaction(s)`);
    } else {
      const n = await runRebuildHackEdges(store, config);
      console.log(`Rebuild queued for ${n} transaction(s); run indexer to process (rebuild mode auto-activates)`);
    }
    return;
  }
  if (cmd === "run") {
    const store = openLocalStore();
    const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs);
    const reclaimed = await store.resetRunningJobs();
    if (reclaimed > 0) {
      console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
    }
    console.log("Indexer running...");
    let lastCron = 0;
    while (true) {
      const now = Date.now();
      const due = now - lastCron >= config.cronIntervalSec * 1000;
      const { jobsProcessed } = await runIndexerTick(store, router, config, { schedule: due });
      if (due) lastCron = now;
      if (jobsProcessed === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error("Unknown command:", cmd);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
