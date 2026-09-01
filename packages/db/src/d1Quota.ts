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

function flattenOneLine(message: string): string {
  return message.replace(/\r?\n/g, " ").trim();
}

/** Walk Error.cause chain and flatten messages (matches Drizzle-wrapped D1 failures). */
function flattenErrorText(err: unknown, depth = 0): string {
  const base = err instanceof Error ? err.message : String(err);
  const flattened = flattenOneLine(base);
  if (depth >= 1) return flattened;

  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause == null) return flattened;

  return `${flattened}; cause: ${flattenErrorText(cause, depth + 1)}`;
}

function parseD1QuotaKind(msg: string): D1QuotaKind | null {
  const lower = msg.toLowerCase();
  const isWrite = /row write|write limit exceeded|daily write/.test(lower);
  const isRead = /row read|read limit exceeded|daily read/.test(lower);
  const isQuota =
    /free tier daily row/.test(lower) ||
    /d1 (daily )?(read|write) limit exceeded/.test(lower) ||
    /\[code:\s*7500\]|code:\s*7500/.test(lower);
  if (!isQuota) return null;
  if (isWrite && !isRead) return "write";
  if (isRead && !isWrite) return "read";
  return isWrite ? "write" : "read";
}

/**
 * Map Cloudflare D1 quota errors to D1QuotaExceededError.
 * Returns null when the error is not a recognized daily limit message.
 */
export function classifyD1Error(err: unknown): D1QuotaExceededError | null {
  const kind = parseD1QuotaKind(flattenErrorText(err));
  if (kind == null) return null;
  return new D1QuotaExceededError(kind, nextUtcMidnightIso());
}
