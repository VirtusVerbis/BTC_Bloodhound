import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";

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

export async function fetchColdcardWatch(base: string): Promise<ColdcardWatchData> {
  const res = await fetch(`${base}/`, {
    headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "text/html" },
  });
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
    const listRes = await fetch(`${base}/addresses`, {
      headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "text/html" },
    });
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

export async function applyColdcardWatchSync(store: Store, data: ColdcardWatchData): Promise<void> {
  for (const address of data.collectors) {
    const existing = await store.getAddress(address);
    await store.upsertAddress({
      address,
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcardwatch",
      hopFromHacker: 0,
      expandStatus: existing ? existing.expandStatus : "pending",
    });
    if (!existing) {
      await store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
    } else if (!(await store.hasPendingJob("poll_hacker_address", address))) {
      await store.enqueueJob("poll_hacker_address", { address }, JOB_PRIORITY.POLL_HACKER);
    }
  }

  for (const address of data.victims) {
    await store.upsertAddress({ address, role: "victim", source: "coldcardwatch" });
  }

  for (const address of data.downstream) {
    const existing = await store.getAddress(address);
    await store.upsertAddress({
      address,
      role: "downstream",
      source: "coldcardwatch",
      expandStatus: "pending",
    });
    if (!existing) {
      await store.enqueueJob("expand_downstream", { address, cron: true }, JOB_PRIORITY.CRON_EXPAND);
    }
  }

  await store.upsertSourceSync("coldcardwatch", {
    lastAddressCount: data.collectors.length + data.victims.length,
    lastContentHash: data.contentHash,
  });
}
