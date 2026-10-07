import type { Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { sha256Hex } from "../util/hash.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { ingestSourceHackerIfMissing } from "./sourceDelta.js";
import { instrumentedFetch, type SubrequestSink } from "../subrequest/instrumentedFetch.js";
import type { JobSubrequestBudget } from "../indexer/subrequestBudget.js";

export const BITQUERY_COLDCARD_SOURCE = "bitquery_coldcard";

export interface BitqueryColdcardData {
  addresses: string[];
  contentHash: string;
}

export function isBitqueryAttackerControlled(classification: string): boolean {
  return classification.trim().toLowerCase().startsWith("attacker-controlled");
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseBitqueryColdcardCsv(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    dataLines.push(line);
  }
  if (dataLines.length === 0) {
    throw new Error("Bitquery CSV missing address and classification columns");
  }
  const headers = splitCsvLine(dataLines[0]!).map((h) => h.trim().toLowerCase());
  const addressIdx = headers.indexOf("address");
  const classIdx = headers.indexOf("classification");
  if (addressIdx < 0 || classIdx < 0) {
    throw new Error("Bitquery CSV missing address and classification columns");
  }

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const line of dataLines.slice(1)) {
    const cols = splitCsvLine(line);
    const classification = cols[classIdx] ?? "";
    if (!isBitqueryAttackerControlled(classification)) continue;
    const normalized = normalizeBitcoinAddress(cols[addressIdx] ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(normalized);
  }
  addresses.sort();
  return addresses;
}

export function bitqueryColdcardContentHash(addresses: string[]): Promise<string> {
  return sha256Hex(addresses.join("\n"));
}

export async function fetchBitqueryColdcard(
  csvUrl: string,
  sink?: SubrequestSink,
): Promise<BitqueryColdcardData> {
  const res = await instrumentedFetch(
    csvUrl,
    {
      headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "text/csv" },
    },
    sink,
  );
  if (!res.ok) throw new Error(`Bitquery Coldcard CSV fetch failed: ${res.status}`);
  const addresses = parseBitqueryColdcardCsv(await res.text());
  const contentHash = await bitqueryColdcardContentHash(addresses);
  return { addresses, contentHash };
}

export interface BitqueryColdcardBatchPayload {
  contentHash: string;
  addresses?: string[];
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

export async function enqueueBitqueryColdcardBatchJobs(
  store: Store,
  data: BitqueryColdcardData,
  perJob: number,
  lastAddressCount?: number,
): Promise<void> {
  const addressCount = lastAddressCount ?? data.addresses.length;
  const chunks = chunkArray(data.addresses, perJob);
  if (chunks.length === 0) {
    await store.upsertSourceSync(BITQUERY_COLDCARD_SOURCE, {
      lastAddressCount: addressCount,
      lastContentHash: data.contentHash,
    });
    return;
  }
  for (let i = 0; i < chunks.length; i++) {
    const finalize = i === chunks.length - 1;
    await store.enqueueJob(
      "sync_bitquery_coldcard",
      {
        contentHash: data.contentHash,
        addresses: chunks[i],
        finalize,
        lastAddressCount: addressCount,
        chunkIndex: i + 1,
        chunkTotal: chunks.length,
      },
      JOB_PRIORITY.SYNC_BITQUERY_COLDCARD,
    );
  }
}

export async function applyBitqueryColdcardSyncBatch(
  store: Store,
  payload: BitqueryColdcardBatchPayload,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<number> {
  let inserted = 0;
  const addresses = payload.addresses ?? [];
  for (let i = 0; i < addresses.length; i++) {
    if (opts?.jobSubreq?.exhausted()) {
      const remaining = addresses.slice(i);
      if (remaining.length > 0) {
        await store.enqueueJob(
          "sync_bitquery_coldcard",
          {
            contentHash: payload.contentHash,
            addresses: remaining,
            finalize: payload.finalize,
            lastAddressCount: payload.lastAddressCount,
            chunkIndex: payload.chunkIndex,
            chunkTotal: payload.chunkTotal,
          },
          JOB_PRIORITY.SYNC_BITQUERY_COLDCARD,
        );
      }
      return inserted;
    }
    const address = addresses[i]!;
    if (await ingestSourceHackerIfMissing(store, address, BITQUERY_COLDCARD_SOURCE)) inserted++;
  }
  if (payload.finalize) {
    await store.upsertSourceSync(BITQUERY_COLDCARD_SOURCE, {
      lastAddressCount: payload.lastAddressCount ?? payload.addresses?.length ?? 0,
      lastContentHash: payload.contentHash,
    });
  }
  return inserted;
}
