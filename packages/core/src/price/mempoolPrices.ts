import { instrumentedFetch, type SubrequestSink } from "../subrequest/instrumentedFetch.js";

export function mempoolPricesUrl(mempoolBase: string): string {
  return `${mempoolBase.replace(/\/$/, "")}/v1/prices`;
}

export async function fetchMempoolBtcUsd(
  mempoolBase: string,
  sink?: SubrequestSink,
): Promise<{ usd: number; at: string }> {
  const res = await instrumentedFetch(
    mempoolPricesUrl(mempoolBase),
    {
      headers: { "User-Agent": "cointrace-indexer/1.0", Accept: "application/json" },
    },
    sink,
  );
  if (!res.ok) throw new Error(`Mempool prices fetch failed: ${res.status}`);

  const body = (await res.json()) as { time?: number; USD?: number };
  const usd = body.USD;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error("Mempool prices response missing valid USD field");
  }

  const at =
    typeof body.time === "number" && Number.isFinite(body.time)
      ? new Date(body.time * 1000).toISOString()
      : new Date().toISOString();

  return { usd: Math.round(usd), at };
}
