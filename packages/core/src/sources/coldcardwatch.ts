import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { instrumentedFetch, type SubrequestSink } from "../subrequest/instrumentedFetch.js";
import type { JobSubrequestBudget } from "../indexer/subrequestBudget.js";

export interface ColdcardWatchData {
  collectors: string[];
  victims: string[];
  downstream: string[];
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

export async function fetchColdcardWatch(base: string, sink?: SubrequestSink): Promise<ColdcardWatchData> {
  const res = await instrumentedFetch(
    `${base}/`,
    {
      headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "text/html" },
    },
    sink,
  );
  if (!res.ok) throw new Error(`ColdcardWatch fetch failed: ${res.status}`);
  const html = await res.text();

  const downstream: string[] = [];

  const bc1Regex = /bc1[a-z0-9]{25,87}/gi;
  const allMatches = html.match(bc1Regex) ?? [];
  const unique = dedupeNormalized(allMatches);

  const collectorSection = html.match(/Where the money is[\s\S]{0,8000}/i)?.[0] ?? html.slice(0, 12000);
  const collectors = dedupeNormalized(collectorSection.match(bc1Regex) ?? []);

  let victims: string[] = [];
  try {
    const listRes = await instrumentedFetch(
      `${base}/addresses`,
      {
        headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "text/html" },
      },
      sink,
    );
    if (listRes.ok) {
      const listHtml = await listRes.text();
      victims = dedupeNormalized(listHtml.match(bc1Regex) ?? []);
    }
  } catch {
    // fallback: use unique from main page minus collectors
  }

  if (victims.length === 0) {
    victims = unique.filter((v) => !collectors.includes(v));
  }

  const contentHash = await sha256Hex([...collectors, ...victims].sort().join("\n"));

  return {
    collectors,
    victims: victims.filter((v) => !collectors.includes(v)),
    downstream: dedupeNormalized(downstream),
    contentHash,
  };
}

export interface ColdcardWatchBatchPayload {
  contentHash: string;
  collectors?: string[];
  victims?: string[];
  downstream?: string[];
  finalize?: boolean;
  lastAddressCount?: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function enqueueColdcardWatchBatchJobs(
  store: Store,
  data: ColdcardWatchData,
  perJob: number,
): Promise<void> {
  const jobs: ColdcardWatchBatchPayload[] = [];
  for (const chunk of chunkArray(data.collectors, perJob)) {
    jobs.push({ contentHash: data.contentHash, collectors: chunk });
  }
  for (const chunk of chunkArray(data.victims, perJob)) {
    jobs.push({ contentHash: data.contentHash, victims: chunk });
  }
  for (const chunk of chunkArray(data.downstream, perJob)) {
    jobs.push({ contentHash: data.contentHash, downstream: chunk });
  }
  if (jobs.length === 0) {
    await store.upsertSourceSync("coldcardwatch", {
      lastAddressCount: data.collectors.length + data.victims.length,
      lastContentHash: data.contentHash,
    });
    return;
  }
  const last = jobs[jobs.length - 1]!;
  last.finalize = true;
  last.lastAddressCount = data.collectors.length + data.victims.length;
  for (const payload of jobs) {
    await store.enqueueJob(
      "sync_coldcardwatch",
      payload as unknown as Record<string, unknown>,
      JOB_PRIORITY.SYNC_COLDCARDWATCH,
    );
  }
}

export async function applyColdcardWatchSyncBatch(
  store: Store,
  payload: ColdcardWatchBatchPayload,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<void> {
  const collectors = payload.collectors ?? [];
  for (let i = 0; i < collectors.length; i++) {
    if (opts?.jobSubreq?.exhausted()) {
      await store.enqueueJob(
        "sync_coldcardwatch",
        {
          contentHash: payload.contentHash,
          collectors: collectors.slice(i),
          victims: payload.victims,
          downstream: payload.downstream,
          finalize: payload.finalize,
          lastAddressCount: payload.lastAddressCount,
        } as unknown as Record<string, unknown>,
        JOB_PRIORITY.SYNC_COLDCARDWATCH,
      );
      return;
    }
    const address = collectors[i]!;
    const inserted = await store.insertAddressIfMissing({
      address,
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcardwatch",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (!inserted) {
      await store.upsertAddress({
        address,
        role: "hacker",
        isFlaggedHacker: true,
        source: "coldcardwatch",
        hopFromHacker: 0,
      });
    }
    if (inserted) {
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    } else {
      await store.enqueueJobIfAbsent(
        "poll_hacker_address",
        { address },
        JOB_PRIORITY.POLL_HACKER,
        undefined,
        { address },
      );
    }
  }

  const victims = payload.victims ?? [];
  if (victims.length > 0) {
    if (opts?.jobSubreq?.exhausted()) {
      await store.enqueueJob(
        "sync_coldcardwatch",
        {
          contentHash: payload.contentHash,
          victims,
          downstream: payload.downstream,
          finalize: payload.finalize,
          lastAddressCount: payload.lastAddressCount,
        } as unknown as Record<string, unknown>,
        JOB_PRIORITY.SYNC_COLDCARDWATCH,
      );
      return;
    }
    await store.upsertAddressesBatch(
      victims.map((address) => ({
        address,
        role: "victim",
        source: "coldcardwatch",
      })),
    );
  }

  const downstream = payload.downstream ?? [];
  for (let i = 0; i < downstream.length; i++) {
    if (opts?.jobSubreq?.exhausted()) {
      await store.enqueueJob(
        "sync_coldcardwatch",
        {
          contentHash: payload.contentHash,
          downstream: downstream.slice(i),
          finalize: payload.finalize,
          lastAddressCount: payload.lastAddressCount,
        } as unknown as Record<string, unknown>,
        JOB_PRIORITY.SYNC_COLDCARDWATCH,
      );
      return;
    }
    const address = downstream[i]!;
    const inserted = await store.insertAddressIfMissing({
      address,
      role: "downstream",
      source: "coldcardwatch",
      expandStatus: "pending",
    });
    if (inserted) {
      await store.enqueueJobIfAbsent(
        "expand_downstream",
        { address, cron: true },
        JOB_PRIORITY.CRON_EXPAND,
        undefined,
        { address },
      );
    }
  }

  if (payload.finalize) {
    await store.upsertSourceSync("coldcardwatch", {
      lastAddressCount: payload.lastAddressCount ?? 0,
      lastContentHash: payload.contentHash,
    });
  }
}

export async function applyColdcardWatchSync(store: Store, data: ColdcardWatchData): Promise<void> {
  for (const address of data.collectors) {
    const inserted = await store.insertAddressIfMissing({
      address,
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcardwatch",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (!inserted) {
      await store.upsertAddress({
        address,
        role: "hacker",
        isFlaggedHacker: true,
        source: "coldcardwatch",
        hopFromHacker: 0,
      });
    }
    if (inserted) {
      await store.enqueueJobIfAbsent(
        "backfill_hacker_address",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { address },
      );
    } else {
      await store.enqueueJobIfAbsent(
        "poll_hacker_address",
        { address },
        JOB_PRIORITY.POLL_HACKER,
        undefined,
        { address },
      );
    }
  }

  for (const address of data.victims) {
    await store.upsertAddress({ address, role: "victim", source: "coldcardwatch" });
  }

  for (const address of data.downstream) {
    const inserted = await store.insertAddressIfMissing({
      address,
      role: "downstream",
      source: "coldcardwatch",
      expandStatus: "pending",
    });
    if (inserted) {
      await store.enqueueJobIfAbsent(
        "expand_downstream",
        { address, cron: true },
        JOB_PRIORITY.CRON_EXPAND,
        undefined,
        { address },
      );
    }
  }

  await store.upsertSourceSync("coldcardwatch", {
    lastAddressCount: data.collectors.length + data.victims.length,
    lastContentHash: data.contentHash,
  });
}
