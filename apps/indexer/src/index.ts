import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import {
  ChainRouter,
  JOB_PRIORITY,
  loadConfig,
  normalizeBitcoinAddress,
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

const config = loadConfig();
const dbPath = path.resolve(config.databaseUrl.replace("file:", ""));
mkdirSync(path.dirname(dbPath), { recursive: true });
const { sqlite, db } = openDatabase(dbPath);
runMigrations(sqlite);
const store = new Store(db);
const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs);

const cmd = process.argv[2] ?? "run";

async function main() {
  if (cmd === "seed") {
    await runSeedPublicHackers(store, config.seedFilePath, config.seedDataJson);
    console.log("Seed complete");
    return;
  }
  if (cmd === "load-local") {
    await runLoadLocalWatchlist(store, config.localWatchlistPath, config.localWatchlistDataJson);
    console.log("Local watchlist loaded");
    return;
  }
  if (cmd === "re-backfill-hackers") {
    const wait = process.argv.includes("--wait");
    const fresh = process.argv.includes("--fresh");
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
    const address = normalizeBitcoinAddress(process.argv[3] ?? "");
    if (!address) {
      console.error("Usage: re-backfill-hacker <address> [--wait] [--fresh]");
      process.exit(1);
    }
    const wait = process.argv.includes("--wait");
    const fresh = process.argv.includes("--fresh");
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
    const wait = process.argv.includes("--wait");
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
