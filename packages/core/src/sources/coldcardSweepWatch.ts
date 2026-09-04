import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { insertAddressIfMissing } from "./insertIfMissing.js";
import { instrumentedFetch, type SubrequestSink } from "../subrequest/instrumentedFetch.js";
import type { JobSubrequestBudget } from "../indexer/subrequestBudget.js";

export interface ColdcardSweepWatchData {
  collectors: string[];
  vaults: string[];
  contentHash: string;
}

function dedupeNormalized(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const normalized = normalizeBitcoinAddress(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export async function fetchColdcardSweepWatch(
  base: string,
  sink?: SubrequestSink,
): Promise<ColdcardSweepWatchData> {
  const headers = { "User-Agent": "cointrace-indexer/1.0" };

  const waveRes = await instrumentedFetch(
    `${base}/wave3.js`,
    { headers: { ...headers, Accept: "*/*" } },
    sink,
  );
  if (!waveRes.ok) throw new Error(`ColdcardSweepWatch wave3 fetch failed: ${waveRes.status}`);
  const waveBody = await waveRes.text();
  const waveJson = waveBody.replace(/^\s*window\.WAVE3\s*=\s*/, "").trim().replace(/;$/, "");
  const wave = JSON.parse(waveJson) as { vaults?: Array<[string, number]> };
  const vaults = dedupeNormalized((wave.vaults ?? []).map(([addr]) => addr));

  const homeRes = await instrumentedFetch(
    `${base}/`,
    { headers: { ...headers, Accept: "text/html" } },
    sink,
  );
  if (!homeRes.ok) throw new Error(`ColdcardSweepWatch homepage fetch failed: ${homeRes.status}`);
  const html = await homeRes.text();

  const bc1Regex = /bc1[a-z0-9]{25,87}/gi;
  const collectorSection = html.match(/Where the money is[\s\S]{0,8000}/i)?.[0] ?? html.slice(0, 12000);
  const collectors = dedupeNormalized(collectorSection.match(bc1Regex) ?? []);

  const contentHash = await sha256Hex([...collectors, ...vaults].sort().join("\n"));

  return {
    collectors,
    vaults: vaults.filter((v) => !collectors.includes(v)),
    contentHash,
  };
}

export interface ColdcardSweepWatchBatchPayload {
  contentHash: string;
  collectors?: string[];
  vaults?: string[];
  finalize?: boolean;
  lastAddressCount?: number;
  chunkIndex?: number;
  chunkTotal?: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function enqueueColdcardSweepWatchBatchJobs(
  store: Store,
  data: ColdcardSweepWatchData,
  perJob: number,
): Promise<void> {
  const jobs: ColdcardSweepWatchBatchPayload[] = [];
  for (const chunk of chunkArray(data.collectors, perJob)) {
    jobs.push({ contentHash: data.contentHash, collectors: chunk });
  }
  for (const chunk of chunkArray(data.vaults, perJob)) {
    jobs.push({ contentHash: data.contentHash, vaults: chunk });
  }
  if (jobs.length === 0) {
    await store.upsertSourceSync("coldcard_sweep_watch", {
      lastAddressCount: data.collectors.length + data.vaults.length,
      lastContentHash: data.contentHash,
    });
    return;
  }
  const last = jobs[jobs.length - 1]!;
  last.finalize = true;
  last.lastAddressCount = data.collectors.length + data.vaults.length;
  for (let i = 0; i < jobs.length; i++) {
    await store.enqueueJob(
      "sync_vercel_trackers",
      {
        source: "coldcard_sweep_watch",
        ...jobs[i],
        chunkIndex: i + 1,
        chunkTotal: jobs.length,
      } as unknown as Record<string, unknown>,
      JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
    );
  }
}

export async function applyColdcardSweepWatchSyncBatch(
  store: Store,
  payload: ColdcardSweepWatchBatchPayload,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<number> {
  let inserted = 0;

  const collectors = payload.collectors ?? [];
  for (let i = 0; i < collectors.length; i++) {
    if (opts?.jobSubreq?.exhausted()) {
      const remainingCollectors = collectors.slice(i);
      const remainingVaults = payload.vaults ?? [];
      if (remainingCollectors.length > 0 || remainingVaults.length > 0) {
        await store.enqueueJob(
          "sync_vercel_trackers",
          {
            source: "coldcard_sweep_watch",
            contentHash: payload.contentHash,
            collectors: remainingCollectors,
            vaults: remainingVaults,
            finalize: payload.finalize,
            lastAddressCount: payload.lastAddressCount,
            chunkIndex: payload.chunkIndex,
            chunkTotal: payload.chunkTotal,
          } as unknown as Record<string, unknown>,
          JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
        );
      }
      return inserted;
    }
    const address = collectors[i]!;
    const added = await insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_sweep_watch",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    }
  }

  if ((payload.vaults?.length ?? 0) > 0) {
    const rows = payload.vaults ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (opts?.jobSubreq?.exhausted()) {
        await store.enqueueJob(
          "sync_vercel_trackers",
          {
            source: "coldcard_sweep_watch",
            contentHash: payload.contentHash,
            vaults: rows.slice(i),
            finalize: payload.finalize,
            lastAddressCount: payload.lastAddressCount,
            chunkIndex: payload.chunkIndex,
            chunkTotal: payload.chunkTotal,
          } as unknown as Record<string, unknown>,
          JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
        );
        return inserted;
      }
      const address = rows[i]!;
      if (
        await insertAddressIfMissing(store, address, {
          role: "victim",
          source: "coldcard_sweep_watch",
        })
      ) {
        inserted++;
      }
    }
  }

  if (payload.finalize) {
    await store.upsertSourceSync("coldcard_sweep_watch", {
      lastAddressCount: payload.lastAddressCount ?? 0,
      lastContentHash: payload.contentHash,
    });
  }

  return inserted;
}

export async function applyColdcardSweepWatchSync(store: Store, data: ColdcardSweepWatchData): Promise<number> {
  let inserted = 0;

  for (const address of data.collectors) {
    const added = await insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_sweep_watch",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    }
  }

  for (const address of data.vaults) {
    if (
      await insertAddressIfMissing(store, address, {
        role: "victim",
        source: "coldcard_sweep_watch",
      })
    ) {
      inserted++;
    }
  }

  await store.upsertSourceSync("coldcard_sweep_watch", {
    lastAddressCount: data.collectors.length + data.vaults.length,
    lastContentHash: data.contentHash,
  });

  return inserted;
}
