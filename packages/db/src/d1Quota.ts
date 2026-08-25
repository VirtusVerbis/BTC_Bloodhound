export type D1QuotaKind = "read" | "write";

/** Thrown when Cloudflare D1 free-tier daily row read/write limit is exceeded. */
export class D1QuotaExceededError extends Error {
  readonly kind: D1QuotaKind;
  readonly retryAt: string;

  constructor(kind: D1QuotaKind, retryAt: string) {
    super(`D1 daily ${kind} limit exceeded; retry after ${retryAt}`);
    this.name = "D1QuotaExceededError";
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

/** Next 00:00 UTC as ISO string (when D1 free-tier daily limits reset). */
export function nextUtcMidnightIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Map Cloudflare D1 quota errors to D1QuotaExceededError.
 * Returns null when the error is not a recognized daily limit message.
 */
export function classifyD1Error(err: unknown): D1QuotaExceededError | null {
  const msg = errorMessage(err);
  if (!msg.includes("free tier daily row")) return null;
  const kind: D1QuotaKind = msg.includes("row write") ? "write" : "read";
  return new D1QuotaExceededError(kind, nextUtcMidnightIso());
}
