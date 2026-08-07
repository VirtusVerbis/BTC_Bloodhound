import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import {
  ChainRouter,
  loadConfig,
  processJobs,
  runLoadLocalWatchlist,
  runSeedPublicHackers,
  scheduleDownstreamCrawl,
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
    await runSeedPublicHackers(store, config.seedFilePath);
    console.log("Seed complete");
    return;
  }
  if (cmd === "load-local") {
    await runLoadLocalWatchlist(store, config.localWatchlistPath);
    console.log("Local watchlist loaded");
    return;
  }
  if (cmd === "run") {
    console.log("Indexer running...");
    let lastCron = 0;
    while (true) {
      const now = Date.now();
      if (now - lastCron >= config.cronIntervalSec * 1000) {
        scheduleDownstreamCrawl(store, config);
        lastCron = now;
      }
      const n = await processJobs(store, router, config);
      if (n === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error("Unknown command:", cmd);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
