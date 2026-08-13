import type { Job } from "@cointrace/db";
import { summarizeJobPayload } from "../ops/queue.js";

function parsePayload(job: Job): Record<string, unknown> {
  try {
    return JSON.parse(job.payloadJson) as Record<string, unknown>;
  } catch {
    return { raw: job.payloadJson };
  }
}

function formatDetailSuffix(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof details.address === "string") parts.push(`address=${details.address}`);
  if (typeof details.txid === "string") parts.push(`txid=${details.txid}`);
  if (details.continuation === true) parts.push("continuation=true");
  if (details.cron === true) parts.push("cron=true");
  if (typeof details.pendingTxidsCount === "number" && details.pendingTxidsCount > 0) {
    parts.push(`pendingTxidsCount=${details.pendingTxidsCount}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function formatJobStartLine(job: Job): string {
  const payload = parsePayload(job);
  const details = summarizeJobPayload(job.type, payload);
  return `[job] start id=${job.id} type=${job.type}${formatDetailSuffix(details)}`;
}

export function logCronDetail(enabled: boolean, message: string): void {
  if (!enabled) return;
  console.log(message);
}

export function logJobFail(job: Job, err: unknown): void {
  const payload = parsePayload(job);
  const details = summarizeJobPayload(job.type, payload);
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[job] fail id=${job.id} type=${job.type}${formatDetailSuffix(details)} error=${message}`,
  );
}
