import type { Context, Next } from "hono";
import type { Store } from "@cointrace/db";

export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf?.trim()) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip")?.trim() || "unknown";
}

export async function enforceRateLimit(
  store: Store,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  return store.consumeRateLimit(key, limit, windowSec);
}

export function rateLimitResponse(retryAfterSec: number) {
  return {
    body: { error: "rate limit exceeded", retryAfterSec },
    status: 429 as const,
    headers: { "Retry-After": String(Math.max(1, retryAfterSec)) },
  };
}

/** Security headers for API + Worker-served UI responses. */
export async function securityHeadersMiddleware(c: Context, next: Next) {
  await next();
  const res = c.res;
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://mempool.space",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  c.res = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const MAX_JSON_BODY_BYTES = 16_384;

export async function readJsonBodyLimited<T>(c: Context): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const len = c.req.header("content-length");
  if (len != null && Number(len) > MAX_JSON_BODY_BYTES) {
    return { ok: false, error: "payload too large" };
  }
  const text = await c.req.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    return { ok: false, error: "payload too large" };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}
