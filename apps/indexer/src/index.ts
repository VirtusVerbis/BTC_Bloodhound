import path from "node:path";
import { mkdirSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import {
  addHacker,
  buildBackfillJobPayload,
  ChainRouter,
  bumpExpandDownstream,
  clearQueue,
  enqueueExpandDownstream,
  defaultPriorityForJobType,
  hasResumableBackfillState,
  JOB_PRIORITY,
  listQueue,
  loadConfig,
  normalizeBitcoinAddress,
  pruneInvalidAddresses,
  removeHacker,
  repairVictimRoles,
  runIndexerTick,
  runLoadLocalWatchlist,
  runMaintenanceCli,
  formatMaintenanceCliLine,
  runReBackfillHacker,
  runReBackfillHackers,
  runReBackfillHackersWait,
  runReBackfillHackerWait,
  runRebuildHackEdges,
  runRebuildHackEdgesWait,
  runSeedPublicHackers,
  TICK_LEASE_SKEW_MS,
  type ListQueueResult,
  type QueueStatusFilter,
} from "@cointrace/core";
import {
  addHackerRemote,
  D1WranglerClient,
  getCronStatusRemote,
  listQueueRemote,
  pauseCronRemote,
  pruneInvalidAddressesRemote,
  reBackfillHackerRemote,
  removeHackerRemote,
  repairVictimRolesRemote,
  resumeCronRemote,
} from "./d1Wrangler.js";
import { openRemoteProductionStore } from "./remotePlatform.js";
import { runRemoteSidecar } from "./runRemote.js";
import { formatCronStatusSummary, readCronStatusFromStore } from "./sidecarLog.js";
import {
  confirmUnknownHackerSource,
  isKnownHackerSource,
  resolveHackerSourceFlag,
} from "./hackerSourcePrompt.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "run";
const remote = argv.includes("--remote");

if (cmd === "run" && remote && !process.env.DOTENV_CONFIG_PATH?.trim()) {
  process.env.DOTENV_CONFIG_PATH = path.resolve(process.cwd(), "config/sidecar.env");
}

const config = loadConfig();

function flagValue(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith("--")) return argv[idx + 1];
  return undefined;
}

function positionalArgs(): string[] {
  return argv.slice(1).filter((a) => !a.startsWith("--"));
}

function printQueueSummary(
  result: ListQueueResult,
  meta: { target: string; status: string },
): void {
  const { summary } = result;
  const statusParts = Object.entries(summary.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}=${count}`);
  console.log(`target=${meta.target}  status=${meta.status}  total=${summary.total}`);
  if (statusParts.length > 0) {
    console.log(statusParts.join("  "));
  }
  console.log("");

  const rows = Object.entries(summary.byType)
    .map(([type, count]) => ({ type, count, priority: defaultPriorityForJobType(type) }))
    .sort((a, b) => b.priority - a.priority || a.type.localeCompare(b.type));
  const typeWidth = Math.max(4, ...rows.map((r) => r.type.length), "TOTAL".length);
  const priWidth = Math.max(3, ...rows.map((r) => String(r.priority).length));
  const countWidth = Math.max(5, ...rows.map((r) => String(r.count).length), String(summary.total).length);
  console.log(`${"type".padEnd(typeWidth)}  ${"pri".padStart(priWidth)}  ${"count".padStart(countWidth)}`);
  console.log(`${"-".repeat(typeWidth)}  ${"-".repeat(priWidth)}  ${"-".repeat(countWidth)}`);
  for (const row of rows) {
    console.log(
      `${row.type.padEnd(typeWidth)}  ${String(row.priority).padStart(priWidth)}  ${String(row.count).padStart(countWidth)}`,
    );
  }
  console.log(`${"TOTAL".padEnd(typeWidth)}  ${"".padStart(priWidth)}  ${String(summary.total).padStart(countWidth)}`);

  if (result.nextCron) {
    console.log("");
    console.log(JSON.stringify(result.nextCron, null, 2));
  }
}

function openLocalStore(): Store {
  const dbPath = path.resolve(config.databaseUrl.replace("file:", ""));
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const { sqlite, db } = openDatabase(dbPath);
  runMigrations(sqlite);
  return new Store(db, { maxQueueDepth: config.maxQueueDepth });
}

function openChainRouter(store: Store): ChainRouter {
  return new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs, {
    primaryProvider: config.chainPrimaryProvider,
    backoff: {
      rateLimitMs: config.rateLimitMs,
      apiThresholdBaseSec: config.apiThresholdBaseSec,
      apiThresholdMaxSec: config.apiThresholdMaxSec,
    },
  });
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
    const yes = argv.includes("--yes");
    const source = resolveHackerSourceFlag(flagValue("--source"));
    if (!normalizeBitcoinAddress(address)) {
      console.error("Usage: add-hacker <address> [--label ...] [--source ...] [--yes] [--remote]");
      process.exit(1);
    }
    if (!isKnownHackerSource(source) && !yes) {
      const rl = readline.createInterface({ input, output });
      try {
        const confirmed = await confirmUnknownHackerSource({
          source,
          ask: (question) => rl.question(question),
          isTty: Boolean(input.isTTY && output.isTTY),
          logWarn: (message) => console.error(message),
        });
        if (!confirmed) process.exit(1);
      } finally {
        rl.close();
      }
    }
    const result = remote
      ? await addHackerRemote(remoteClient(), { address, label, source })
      : await addHacker(openLocalStore(), { address, label, source });
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
    let result;
    if (remote) {
      const { store, dispose } = await openRemoteProductionStore(config);
      try {
        result = await clearQueue(store);
      } finally {
        await dispose();
      }
    } else {
      result = await clearQueue(openLocalStore());
    }
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "enqueue-expand") {
    const address = positionalArgs()[0] ?? "";
    const priorityRaw = flagValue("--priority");
    const priority = priorityRaw != null ? Number(priorityRaw) : undefined;
    if (!normalizeBitcoinAddress(address)) {
      console.error("Usage: enqueue-expand <address> [--priority N] [--remote]");
      process.exit(1);
    }
    if (priorityRaw != null && (!Number.isFinite(priority) || priority! < 1)) {
      console.error("Invalid --priority (must be a positive number)");
      process.exit(1);
    }
    let result;
    if (remote) {
      const { store, dispose } = await openRemoteProductionStore(config);
      try {
        result = await enqueueExpandDownstream(store, { address, priority });
      } finally {
        await dispose();
      }
    } else {
      result = await enqueueExpandDownstream(openLocalStore(), { address, priority });
    }
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "bump-expand") {
    const address = positionalArgs()[0] ?? "";
    const priorityRaw = flagValue("--priority");
    const priority = priorityRaw != null ? Number(priorityRaw) : undefined;
    if (!normalizeBitcoinAddress(address)) {
      console.error("Usage: bump-expand <address> [--priority N] [--remote]");
      process.exit(1);
    }
    if (priorityRaw != null && (!Number.isFinite(priority) || priority! < 1)) {
      console.error("Invalid --priority (must be a positive number)");
      process.exit(1);
    }
    let result;
    if (remote) {
      const { store, dispose } = await openRemoteProductionStore(config);
      try {
        result = await bumpExpandDownstream(store, { address, priority });
      } finally {
        await dispose();
      }
    } else {
      result = await bumpExpandDownstream(openLocalStore(), { address, priority });
    }
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "list-queue") {
    const statusRaw = flagValue("--status") ?? "active";
    const validStatuses: QueueStatusFilter[] = ["active", "pending", "running", "all"];
    const summaryOnly = argv.includes("--summary");
    if (!validStatuses.includes(statusRaw as QueueStatusFilter)) {
      console.error(
        "Usage: list-queue [--remote] [--status active|pending|running|all] [--type <jobType>] [--limit N] [--summary] [--next-cron]",
      );
      process.exit(1);
    }
    const type = flagValue("--type");
    const limitRaw = flagValue("--limit");
    const limit = summaryOnly ? 0 : limitRaw != null ? Number(limitRaw) : undefined;
    if (!summaryOnly && limitRaw != null && (!Number.isFinite(limit) || limit! < 1)) {
      console.error("Invalid --limit (must be a positive number)");
      process.exit(1);
    }
    const opts = {
      status: statusRaw as QueueStatusFilter,
      type,
      limit,
      nextCron: argv.includes("--next-cron"),
    };
    const target = remote ? "remote-d1" : "local-sqlite";
    try {
      const result = remote
        ? await listQueueRemote(remoteClient(), config, opts)
        : await listQueue(openLocalStore(), config, opts);
      if (summaryOnly) {
        printQueueSummary(result, { target, status: statusRaw });
      } else {
        console.log(JSON.stringify({ ...result, target }, null, 2));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    }
    return;
  }
  if (cmd === "prune-invalid-addresses") {
    const dryRun = argv.includes("--dry-run");
    const result = remote
      ? await pruneInvalidAddressesRemote(remoteClient(), { dryRun })
      : await pruneInvalidAddresses(openLocalStore(), { dryRun });
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "repair-victim-roles") {
    const dryRun = argv.includes("--dry-run");
    const address = flagValue("--address");
    const result = remote
      ? await repairVictimRolesRemote(remoteClient(), { address, dryRun })
      : await repairVictimRoles(openLocalStore(), { address, dryRun });
    console.log(
      JSON.stringify({ ok: true, ...result, target: remote ? "remote-d1" : "local-sqlite" }, null, 2),
    );
    return;
  }
  if (cmd === "pause-cron") {
    if (remote) {
      const client = remoteClient();
      pauseCronRemote(client);
      console.log(formatCronStatusSummary(getCronStatusRemote(client)));
    } else {
      const store = openLocalStore();
      await store.setCronIndexerPaused(true);
      console.log(formatCronStatusSummary(await readCronStatusFromStore(store)));
    }
    return;
  }
  if (cmd === "resume-cron") {
    if (remote) {
      const client = remoteClient();
      resumeCronRemote(client);
      console.log(formatCronStatusSummary(getCronStatusRemote(client)));
    } else {
      const store = openLocalStore();
      await store.setCronIndexerPaused(false);
      console.log(formatCronStatusSummary(await readCronStatusFromStore(store)));
    }
    return;
  }
  if (cmd === "cron-status") {
    if (remote) {
      console.log(formatCronStatusSummary(getCronStatusRemote(remoteClient())));
    } else {
      console.log(formatCronStatusSummary(await readCronStatusFromStore(openLocalStore())));
    }
    return;
  }
  if (cmd === "run-maintenance") {
    const dryRun = argv.includes("--dry-run");
    const yes = argv.includes("--yes");
    const forceWithCron = argv.includes("--force-with-cron");
    const statusOnly = argv.includes("--status");
    const target = remote ? "remote-d1" : "local-sqlite";

    async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
      if (remote) {
        const { store, dispose } = await openRemoteProductionStore(config);
        try {
          return await fn(store);
        } finally {
          await dispose();
        }
      }
      return fn(openLocalStore());
    }

    if (remote && !dryRun && !statusOnly && !forceWithCron) {
      const cronPaused = getCronStatusRemote(remoteClient()).cronIndexerPaused;
      if (!cronPaused) {
        console.error(
          "Remote maintenance requires cron to be paused. Run: node apps/indexer/dist/index.js pause-cron --remote",
        );
        console.error("Or pass --force-with-cron to override (not recommended).");
        process.exit(1);
      }
    }

    if (remote && !dryRun && !statusOnly && !yes) {
      console.error("Reminder: back up prod D1 before running maintenance on remote.");
      console.error(
        '  npx wrangler d1 export cointrace --remote --env production --output "backups/d1-export-remote-<timestamp>.sql"',
      );
      const rl = readline.createInterface({ input, output });
      try {
        const answer = await rl.question("Proceed with maintenance on remote prod D1? [y/N] ");
        if (!/^y(es)?$/i.test(answer.trim())) process.exit(1);
      } finally {
        rl.close();
      }
    }

    console.log(
      `maintenance config: enabled=${config.jobPruneEnabled} retention_days=${config.jobDoneRetentionDays} interval_days=${config.jobPruneIntervalDays} rate_limit_inactive_days=${config.rateLimitPruneInactiveDays}`,
    );

    if (statusOnly) {
      const payload = await withStore(async (store) => {
        const scheduler = await store.getSchedulerState();
        const estimate = await store.estimateMaintenanceWork({
          jobDoneRetentionDays: config.jobDoneRetentionDays,
          rateLimitPruneInactiveDays: config.rateLimitPruneInactiveDays,
        });
        return {
          target,
          maintenance: store.buildMaintenanceStatus(scheduler, {
            jobPruneEnabled: config.jobPruneEnabled,
            jobDoneRetentionDays: config.jobDoneRetentionDays,
            jobPruneIntervalDays: config.jobPruneIntervalDays,
          }),
          estimate,
        };
      });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (!config.jobPruneEnabled) {
      console.error("JOB_PRUNE_ENABLED is disabled (JOB_PRUNE_ENABLED=0). Nothing to run.");
      process.exit(1);
    }

    const controller = new AbortController();
    let sigintCount = 0;
    const onSigint = () => {
      sigintCount++;
      if (sigintCount === 1) {
        console.error("\nAbort requested — finishing current batch…");
        controller.abort();
      }
    };
    process.on("SIGINT", onSigint);

    let lastLine = "";
    const result = await withStore(async (store) =>
      runMaintenanceCli(store, config, {
        dryRun,
        tickMs: config.tickBudgetMs,
        signal: controller.signal,
        onProgress: (progress) => {
          const line = formatMaintenanceCliLine(progress);
          if (line !== lastLine) {
            process.stdout.write(`\r${line.padEnd(100)}`);
            lastLine = line;
          }
        },
      }),
    );

    process.off("SIGINT", onSigint);
    process.stdout.write("\n");

    const payload = {
      ok: result.ok,
      target,
      dryRun,
      aborted: result.aborted,
      complete: result.complete,
      iterations: result.iterations,
      session: result.session,
      lastPhase: result.lastPhase,
    };
    console.log(JSON.stringify(payload, null, 2));

    if (result.aborted) {
      console.error("Aborted — re-run the same command to resume.");
      process.exit(130);
    }
    return;
  }
  if (cmd === "re-backfill-hackers") {
    const store = openLocalStore();
    const router = openChainRouter(store);
    const wait = argv.includes("--wait");
    const fresh = argv.includes("--fresh");
    if (wait) {
      const { reclaimed } = await store.resetRunningJobs();
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
    const address = normalizeBitcoinAddress(positionalArgs()[0] ?? "");
    if (!address) {
      console.error("Usage: re-backfill-hacker <address> [--wait] [--fresh] [--remote]");
      process.exit(1);
    }
    const wait = argv.includes("--wait");
    const fresh = argv.includes("--fresh");
    if (remote && wait) {
      console.error(
        "re-backfill-hacker --wait is not supported with --remote. Use pause-cron --remote, run --remote, then resume-cron --remote.",
      );
      process.exit(1);
    }
    if (remote) {
      const result = await reBackfillHackerRemote(remoteClient(), { address, fresh });
      console.log(JSON.stringify({ ok: true, ...result, target: "remote-d1" }, null, 2));
      return;
    }
    const store = openLocalStore();
    const router = openChainRouter(store);
    if (wait) {
      const { reclaimed } = await store.resetRunningJobs();
      if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
      }
      await runReBackfillHackerWait(store, router, config, address, { fresh });
    } else {
      const saved = await store.getBackfillState(address);
      if (!fresh && saved?.backfillComplete) {
        console.log(`Backfill already complete for ${address}; use --fresh to restart`);
        return;
      }
      let payload: Record<string, unknown>;
      if (fresh) {
        await runReBackfillHacker(store, address);
        payload = { address };
      } else if (hasResumableBackfillState(saved)) {
        payload = await buildBackfillJobPayload(store, address);
        await store.setExpandStatus(address, "backfilling");
      } else {
        await runReBackfillHacker(store, address);
        payload = { address };
      }
      await store.enqueueJob("backfill_hacker_address", payload, JOB_PRIORITY.BACKFILL_HACKER);
      console.log(`Re-backfill queued for ${address}`);
    }
    return;
  }
  if (cmd === "rebuild-hack-edges") {
    const store = openLocalStore();
    const router = openChainRouter(store);
    const wait = argv.includes("--wait");
    if (wait) {
      const { reclaimed } = await store.resetRunningJobs();
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
    if (remote) {
      await runRemoteSidecar(config, argv);
      return;
    }
    const store = openLocalStore();
    const router = openChainRouter(store);
    const jobDetails = argv.includes("--job-details") || config.indexerJobDetails;
    const logColor = argv.includes("--log-color") || config.indexerLogColor;
    const { reclaimed } = await store.resetRunningJobs(config.runningJobStaleMs, {
      jobReclaimDeferAfter: config.jobReclaimDeferAfter,
      jobReclaimDeferSec: config.jobReclaimDeferSec,
    });
    if (reclaimed > 0) {
      console.log(`Reclaimed ${reclaimed} orphaned running job(s) to pending`);
    }
    console.log("Indexer running...");
    let lastCron = 0;
    while (true) {
      const leaseMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS;
      const acquired = await store.tryAcquireTickLease(leaseMs);
      if (!acquired) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      try {
        const now = Date.now();
        const due = now - lastCron >= config.cronIntervalSec * 1000;
        const { jobsProcessed } = await runIndexerTick(store, router, config, {
          schedule: due,
          jobDetails,
          logColor,
        });
        if (due) lastCron = now;
        if (jobsProcessed === 0) await new Promise((r) => setTimeout(r, 1000));
      } finally {
        await store.clearTickLease();
      }
    }
  }
  console.error("Unknown command:", cmd);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
