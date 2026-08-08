import { createD1Store } from "@cointrace/db/d1";
import {
  assertProductionSecrets,
  ChainRouter,
  loadConfig,
  runIndexerTick,
  type EnvMap,
} from "@cointrace/core";
import { createApp } from "./app.js";

export interface WorkerEnv {
  DB: {
    prepare(query: string): unknown;
    batch?<T = unknown>(statements: unknown[]): Promise<T[]>;
    exec?(query: string): Promise<unknown>;
  };
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  ADMIN_TOKEN?: string;
  CORS_ORIGINS?: string;
  ESPLORA_BASE?: string;
  MEMPOOL_BASE?: string;
  RATE_LIMIT_MS?: string;
  JOBS_PER_TICK?: string;
  SEED_DATA_JSON?: string;
  LOCAL_WATCHLIST_DATA_JSON?: string;
  [key: string]: unknown;
}

function envMap(env: WorkerEnv): EnvMap {
  const map: EnvMap = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") map[k] = v;
  }
  if (!map.ENVIRONMENT) map.ENVIRONMENT = env.ENVIRONMENT ?? "production";
  return map;
}

function build(env: WorkerEnv) {
  const config = loadConfig(envMap(env));
  assertProductionSecrets(config);
  const store = createD1Store(env.DB);
  const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs, {
    sleepOnRateLimit: false,
  });
  const app = createApp(store, config);
  return { config, store, router, app };
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
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
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { app } = build(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }
    if (env.ASSETS) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return withSecurityHeaders(new Response("Not found", { status: 404 }));
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const { store, router, config } = build(env);
    await store.resetRunningJobs();
    await runIndexerTick(store, router, config, { schedule: true });
  },
};

export default worker;
