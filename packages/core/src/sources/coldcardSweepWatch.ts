import { createHash } from "node:crypto";
import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { insertAddressIfMissing } from "./insertIfMissing.js";

export interface ColdcardSweepWatchData {
  collectors: string[];
  vaults: string[];
  contentHash: string;
}

export async function fetchColdcardSweepWatch(base: string): Promise<ColdcardSweepWatchData> {
  const headers = { "User-Agent": "cointrace-indexer/1.0" };

  const waveRes = await fetch(`${base}/wave3.js`, { headers: { ...headers, Accept: "*/*" } });
  if (!waveRes.ok) throw new Error(`ColdcardSweepWatch wave3 fetch failed: ${waveRes.status}`);
  const waveBody = await waveRes.text();
  const waveJson = waveBody.replace(/^\s*window\.WAVE3\s*=\s*/, "").trim().replace(/;$/, "");
  const wave = JSON.parse(waveJson) as { vaults?: Array<[string, number]> };
  const vaults = [...new Set((wave.vaults ?? []).map(([addr]) => addr.toLowerCase()))];

  const homeRes = await fetch(`${base}/`, { headers: { ...headers, Accept: "text/html" } });
  if (!homeRes.ok) throw new Error(`ColdcardSweepWatch homepage fetch failed: ${homeRes.status}`);
  const html = await homeRes.text();

  const bc1Regex = /bc1[a-z0-9]{25,87}/gi;
  const collectorSection = html.match(/Where the money is[\s\S]{0,8000}/i)?.[0] ?? html.slice(0, 12000);
  const collectors = [
    ...new Set((collectorSection.match(bc1Regex) ?? []).map((a) => a.toLowerCase())),
  ];

  const contentHash = createHash("sha256")
    .update([...collectors, ...vaults].sort().join("\n"))
    .digest("hex");

  return {
    collectors,
    vaults: vaults.filter((v) => !collectors.includes(v)),
    contentHash,
  };
}

export function applyColdcardSweepWatchSync(store: Store, data: ColdcardSweepWatchData): number {
  let inserted = 0;

  for (const address of data.collectors) {
    const added = insertAddressIfMissing(store, address, {
      role: "hacker",
      isFlaggedHacker: true,
      source: "coldcard_sweep_watch",
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    if (added) {
      inserted++;
      store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
    }
  }

  for (const address of data.vaults) {
    if (
      insertAddressIfMissing(store, address, {
        role: "victim",
        source: "coldcard_sweep_watch",
      })
    ) {
      inserted++;
    }
  }

  store.upsertSourceSync("coldcard_sweep_watch", {
    lastAddressCount: data.collectors.length + data.vaults.length,
    lastContentHash: data.contentHash,
  });

  return inserted;
}
