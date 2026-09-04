import { truncateAddress } from "./api";
import type { QueueJob, QueueJobClass } from "./queueApi";

export function formatSnapshotAge(elapsedMs: number | null | undefined): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "—";
  if (elapsedMs < 1000) return "just now";
  const totalSec = Math.floor(elapsedMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${String(remMin).padStart(2, "0")}m ago`;
}

export function formatJobTypeLabel(type: string): string {
  return type
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function formatJobDetailLine(job: QueueJob): string {
  const { details, type } = job;
  const parts: string[] = [];

  if (typeof details.address === "string") {
    parts.push(truncateAddress(details.address));
  }
  if (typeof details.txid === "string") {
    parts.push(truncateAddress(details.txid, 8, 8));
  }
  if (details.continuation === true) parts.push("continuation");
  if (details.cron === true) parts.push("cron");
  if (typeof details.pendingTxidsCount === "number" && details.pendingTxidsCount > 0) {
    parts.push(`${details.pendingTxidsCount} tx pending`);
  }
  if (typeof details.processedIndex === "number") {
    const pending =
      typeof details.pendingTxidsCount === "number" ? details.pendingTxidsCount : 0;
    if (pending > 0) {
      parts.push(`progress ${details.processedIndex}/${pending}`);
    } else {
      parts.push(`processed ${details.processedIndex}`);
    }
  }
  if (details.traceEdgesPending === true) parts.push("trace pending");
  if (typeof details.traceEdgeIndex === "number") {
    parts.push(`trace edge ${details.traceEdgeIndex}`);
  }

  if (parts.length === 0) {
    if (type === "sync_coldcardwatch") return "External sync";
    if (type === "sync_vercel_trackers") return "Tracker sync";
    if (type === "refresh_btc_usd_price") return "BTC/USD price";
    return "—";
  }

  return parts.join(" · ");
}

export function jobClassBorderClass(jobClass: QueueJobClass): string {
  switch (jobClass) {
    case "ingest":
      return "queue-job-card--ingest";
    case "cosmetic":
      return "queue-job-card--cosmetic";
    default:
      return "queue-job-card--maint";
  }
}

export function formatRunningElapsed(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < 0) return null;
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`;
  const totalSec = elapsedMs / 1000;
  if (totalSec < 60) {
    const rounded = totalSec >= 10 ? Math.round(totalSec) : Math.round(totalSec * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
