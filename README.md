# Cointrace — Coldcard Hack Tracker POC

Track public Coldcard hack consolidation addresses, victim inputs, and downstream flows.

## Quick start (local)

```bash
pnpm install
pnpm -r run build
cp config/settings.example.env .env

Indexer and the Node API load `.env` automatically on startup (`RATE_LIMIT_MS=8000` in the template — slower Esplora pacing, fewer 429s). Shell exports still override `.env` values. Optional: `DOTENV_CONFIG_PATH=/path/to/.env`.

# Seed hacker addresses + start API
pnpm --filter @cointrace/indexer seed
pnpm dev:api

# In another terminal: indexer + web UI
pnpm --filter @cointrace/indexer run
pnpm dev:web
```

- API: http://localhost:8787
- Web: http://localhost:5173

## Commands

| Command | Description |
|---------|-------------|
| `pnpm --filter @cointrace/indexer seed` | Load `config/watchlist.seed.json` |
| `pnpm --filter @cointrace/indexer load-local` | Merge `config/watchlist.local.json` |
| `pnpm --filter @cointrace/indexer run` | Background indexer (cron + job queue) |

### Hacker backfill (stop indexer before `--wait`)

| Command | Description |
|---------|-------------|
| `node apps/indexer/dist/index.js re-backfill-hacker <addr> [--wait] [--fresh]` | One hacker: resume by default; `--wait` blocks until done; `--fresh` resets cursor |
| `node apps/indexer/dist/index.js re-backfill-hackers [--wait] [--fresh]` | All hackers: skips complete unless `--fresh`; queue mode enqueues jobs without wiping resumable cursors |

Queue mode requires the indexer (`run`) to process jobs. `--wait` runs synchronously per hacker (same resume/429 behavior as singular `--wait`).

### Indexer job scheduling

Fair scheduling keeps graph ingest ahead of maintenance work while `JOBS_PER_TICK=1` (CF free-tier friendly):

- **Reserved ingest slot:** each tick runs a pending `backfill_hacker_address`, `audit_hacker_backfill`, or `expand_downstream` job before polls/balance/price (continuation jobs preferred).
- **Enqueue caps (per cron tick):** `POLL_HACKER_ENQUEUE_PER_CRON=1` (round-robin), `CRAWL_ENQUEUE_PER_CRON=3`, `DOWNSTREAM_POLL_ENQUEUE_PER_CRON=2`.
- **Poll gating:** `poll_hacker_address` only enqueues when `backfill_complete=1`.
- **Priority tiers:** backfill/expand > polls > sync > balance/USD price.

| `pnpm dev:api` | Hono API server (Node + SQLite) |
| `pnpm dev:web` | Vite dev server |
| `pnpm cf:dev` | Cloudflare Workers + D1 + static UI (local) |
| `pnpm cf:deploy` | Deploy Worker + assets to Cloudflare (`--env production`) |
| `pnpm db:push-d1` | Copy local SQLite → local D1 |
| `pnpm db:push-d1:remote` | Copy local SQLite → remote D1 |

## Docker (self-host)

```bash
pnpm -r run build
cd docker && docker compose up --build
```

Web: http://localhost:8080

## Cloudflare

Dual hosting: same codebase runs on Node+SQLite locally and Workers+D1 remotely.

1. Create a D1 database: `npx wrangler d1 create cointrace` and set `database_id` in `wrangler.toml`
2. Copy `.dev.vars.example` → `.dev.vars` and set `ADMIN_TOKEN` (`RATE_LIMIT_MS=8000` is in `wrangler.toml` and the example file)
3. Apply migrations: `pnpm db:d1:migrate` (local) / `pnpm db:d1:migrate:remote`
4. Optional — copy existing local data (avoids re-crawl):
   ```bash
   sqlite3 data/cointrace.db "PRAGMA wal_checkpoint(FULL);"
   pnpm db:push-d1          # local D1
   pnpm db:push-d1:remote   # production D1
   ```
5. Set production secret: `npx wrangler secret put ADMIN_TOKEN --env production` (never put secrets in `[vars]` or git)
6. Set `CORS_ORIGINS` under `[env.production.vars]` in `wrangler.toml` to your Worker URL(s). `ENVIRONMENT=production` is already pinned there (`pnpm cf:deploy` uses `--env production`).
7. Set the same `database_id` on both top-level and `[[env.production.d1_databases]]`.
8. Deploy: `pnpm cf:deploy` (Worker name: `cointrace-production`; `[env.production.vars]` includes `RATE_LIMIT_MS=8000`)
9. Cloudflare dashboard (defense-in-depth): enable Bot Fight Mode and/or rate-limiting rules for the Worker hostname; optionally WAF managed rules if available on your plan

### Security notes (public deploy)

- Public read APIs power the SPA; writes (`POST /api/expand`, admin) are rate-limited / authenticated.
- **CSRF tokens are N/A** without cookie sessions; CORS allowlist + rate limits are the controls.
- App-level per-IP rate limits (expand, GET, graph, admin) apply **only when `ENVIRONMENT=production`**. Local Node and `pnpm cf:dev` skip them (global expand active-job cap still applies). See `EXPAND_*`, `GET_*`, `GRAPH_*`, `ADMIN_*` env knobs.
- Graph UI poll interval comes from `GET /api/config` (`graphPollMs`: **30s** non-production, **120s** production). The client caches recent `/api/graph` responses by query key (instant revisit via dropdown/Page Down); concurrent misses for the same key share one in-flight request. Only the poll interval revalidates from the network.
- Production refuses `ADMIN_TOKEN=change-me` and requires explicit `CORS_ORIGINS` (`assertProductionSecrets`).
- Before deploy: `pnpm audit` (or `npx pnpm@9.15.0 audit`).
- SQL: Store uses parameterized Drizzle queries; addresses are validated at the API boundary; no raw SQL from request strings.

Cron (`*/1 * * * *`) runs indexer ticks on the Worker.

## Architecture

- **packages/db** — SQLite/D1 schema + Store
- **packages/core** — Esplora/Mempool router, indexer, graph builder, ColdcardWatch sync
- **packages/api** — Hono REST API (Node `server.ts` + Worker `worker.ts`)
- **apps/indexer** — CLI job processor (local)
- **apps/web** — React Flow UI (Vite; served as Worker assets on CF)
