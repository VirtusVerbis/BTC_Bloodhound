const EXPLORER_BASE = import.meta.env.VITE_EXPLORER_BASE ?? "https://mempool.space";

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

export class ApiError extends Error {
  status: number;
  body: string;
  retryAfterSec: number | null;

  constructor(status: number, body: string, retryAfterSec: number | null = null) {
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* keep raw body */
    }
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
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
    const retryAfterSec = parseRetryAfterSec(res);
    if (res.status === 429) {
      const sec = Math.max(1, retryAfterSec ?? 60);
      window.dispatchEvent(
        new CustomEvent("cointrace-rate-limit", { detail: { retryAfterSec: sec } }),
      );
    }
    throw new ApiError(res.status, await res.text(), retryAfterSec);
  }
  return res.json() as Promise<T>;
}
