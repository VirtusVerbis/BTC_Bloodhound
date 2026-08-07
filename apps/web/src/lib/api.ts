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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}
