const EXPLORER_BASE = import.meta.env.VITE_EXPLORER_BASE ?? "https://mempool.space";

const BODY_TRUNCATE_LEN = 200;

export const addressUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}`;
export const txUrl = (txid: string) => `${EXPLORER_BASE}/tx/${txid}`;

export function truncateAddress(addr: string, left = 6, right = 6) {
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}

export function satsToBtcNumber(sats: number) {
  return sats / 1e8;
}

export function btcToSats(btc: number) {
  return Math.max(0, Math.round(btc * 1e8));
}

export function satsToBtc(sats: number) {
  return satsToBtcNumber(sats).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function satsToUsd(sats: number, btcUsdPrice: number) {
  return satsToBtcNumber(sats) * btcUsdPrice;
}

export function formatUsd(amount: number) {
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount >= 100 ? 0 : 2,
  });
}

export function formatBtcSpotUsd(price: number) {
  return price.toLocaleString(undefined, {
    maximumFractionDigits: price >= 100 ? 0 : 2,
  });
}

export function isValidIsoDate(iso: string) {
  return !Number.isNaN(new Date(iso).getTime());
}

export function formatUtcDateTime(iso: string): string | null {
  if (!isValidIsoDate(iso)) return null;
  try {
    return (
      new Date(iso).toLocaleString(undefined, {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "medium",
      }) + " UTC"
    );
  } catch {
    return null;
  }
}

export function formatLocalDateTime(iso: string): string | null {
  if (!isValidIsoDate(iso)) return null;
  try {
    const d = new Date(iso);
    const formatted = d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
    const tz = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value;
    return tz ? `${formatted} ${tz}` : formatted;
  } catch {
    return null;
  }
}

export function isHtmlErrorBody(body: string): boolean {
  const trimmed = body.trimStart().slice(0, 200).toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || body.includes("cf-wrapper");
}

export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("+json");
}

function appendRateLimit24h(message: string): string {
  if (message.toLowerCase().includes("please try again in 24 hours")) return message;
  const trimmed = message.trimEnd();
  const sep = trimmed.endsWith(".") ? " " : ". ";
  return `${trimmed}${sep}Please try again in 24 hours.`;
}

export const D1_QUOTA_ERROR_MESSAGE =
  "Database temporarily unavailable. Please try again after midnight UTC.";

type ApiErrorJson = {
  error?: string;
  code?: string;
  retryAfterAt?: string;
};

function parseApiErrorJson(body: string): ApiErrorJson | null {
  try {
    return JSON.parse(body) as ApiErrorJson;
  } catch {
    return null;
  }
}

export function secondsUntilIso(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.ceil(ms / 1000));
}

function truncateBody(body: string): string {
  if (body.length <= BODY_TRUNCATE_LEN) return body;
  return `${body.slice(0, BODY_TRUNCATE_LEN)}…`;
}

export function sanitizeApiErrorBody(
  body: string,
  status: number,
  contentType: string | null,
): string {
  if (isHtmlErrorBody(body)) {
    if (status === 429) {
      return "Site temporarily rate limited by Cloudflare. Please try again in 24 hours.";
    }
    return "Unexpected HTML error from server";
  }

  if (body.trim().length > 0 && !isJsonContentType(contentType)) {
    if (status === 429) {
      return "Rate limit exceeded. Please try again in 24 hours.";
    }
    return `Request failed (${status})`;
  }

  try {
    const parsed = parseApiErrorJson(body);
    if (parsed) {
      if (status === 503 && parsed.code === "d1_quota_exceeded") {
        return D1_QUOTA_ERROR_MESSAGE;
      }
      if (parsed.error) {
        return status === 429 ? appendRateLimit24h(parsed.error) : parsed.error;
      }
    }
  } catch {
    /* fall through */
  }

  if (body.trim().length === 0) {
    return status === 429 ? "Rate limit exceeded. Please try again in 24 hours." : `Request failed (${status})`;
  }

  return truncateBody(body);
}

export class ApiError extends Error {
  status: number;
  body: string;
  retryAfterSec: number | null;
  code?: string;
  retryAfterAt?: string;

  constructor(
    status: number,
    body: string,
    retryAfterSec: number | null = null,
    contentType: string | null = null,
    meta?: { code?: string; retryAfterAt?: string },
  ) {
    super(sanitizeApiErrorBody(body, status, contentType));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
    this.code = meta?.code;
    this.retryAfterAt = meta?.retryAfterAt;
  }
}

function parseRetryAfterSec(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text();
    const retryAfterSec = parseRetryAfterSec(res);
    const parsed = parseApiErrorJson(body);
    if (res.status === 429) {
      const sec = Math.max(1, retryAfterSec ?? 60);
      window.dispatchEvent(
        new CustomEvent("cointrace-rate-limit", { detail: { retryAfterSec: sec } }),
      );
    }
    if (res.status === 503 && parsed?.code === "d1_quota_exceeded") {
      const retryAfterAt = parsed.retryAfterAt;
      const sec =
        retryAfterAt != null
          ? secondsUntilIso(retryAfterAt)
          : Math.max(1, retryAfterSec ?? 60);
      window.dispatchEvent(
        new CustomEvent("cointrace-d1-quota", {
          detail: { retryAfterSec: sec, retryAfterAt: retryAfterAt ?? null },
        }),
      );
    }
    throw new ApiError(
      res.status,
      body,
      retryAfterSec,
      res.headers.get("content-type"),
      parsed?.code || parsed?.retryAfterAt
        ? { code: parsed?.code, retryAfterAt: parsed?.retryAfterAt }
        : undefined,
    );
  }
  return res.json() as Promise<T>;
}
