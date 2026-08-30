import { formatErrorMessage } from "./error.js";

/** True for wrangler remote-proxy / Cloudflare D1 transport failures (not schema, not quota). */
export function isD1TransportError(err: unknown): boolean {
  const msg = formatErrorMessage(err);
  if (/free tier daily row|no such table|schema mismatch/i.test(msg)) return false;
  return (
    /D1_ERROR|Failed to parse body as JSON|internal error;\s*reference\s*=/i.test(msg) ||
    /Failed query:/i.test(msg)
  );
}
