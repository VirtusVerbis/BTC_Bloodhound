# Cointrace — Coldcard Hack Tracker POC

Track public Coldcard hack consolidation addresses, victim inputs, and downstream flows.

Build:
npx pnpm@9.15.0 -r run build

Deploy:
npx wrangler deploy --env production

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
| `node apps/indexer/dist/index.js add-hacker <addr> [--label …] [--remote]` | Upsert flagged hacker (`source=ops`) + enqueue backfill |
| `node apps/indexer/dist/index.js remove-hacker <addr> [--no-prune] [--remote]` | Soft-unflag; prune exclusive victims/downstream by default |
| `node apps/indexer/dist/index.js clear-queue [--remote]` | Delete pending/running jobs only (queue depth → 0) |

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
| `pnpm db:pull-d1:remote` | **Preferred sync:** prod D1 → local SQLite snapshot (resumable import) |
| `pnpm db:pull-d1` | Local wrangler D1 → local SQLite |
| `pnpm db:push-d1` | Bootstrap only: local SQLite → local D1 (resumable batches) |
| `pnpm db:push-d1:remote` | **Danger:** local SQLite → prod D1 (bootstrap/DR only; `--clear` wipes prod) |

## Docker (self-host)

```bash
pnpm -r run build
cd docker && docker compose up --build
```

Web: http://localhost:8080

## Cloudflare

Dual hosting: same codebase runs on Node+SQLite locally and Workers+D1 remotely.

**After go-live, production D1 is the source of truth.** Day-to-day changes use the indexer ops CLI with `--remote`. Refresh a local analysis snapshot with `pnpm db:pull-d1:remote`. Do **not** use `db:push-d1:remote` as normal sync — `--clear` can wipe prod with a stale laptop DB.

1. Create a D1 database: `npx wrangler d1 create cointrace` and set `database_id` in `wrangler.toml`
2. Copy `.dev.vars.example` → `.dev.vars` (`RATE_LIMIT_MS=8000` is in `wrangler.toml` and the example file)
3. Apply migrations: `pnpm db:d1:migrate` (local) / `pnpm db:d1:migrate:remote`
4. Optional bootstrap — copy existing local data once (avoids re-crawl):
   ```bash
   sqlite3 data/cointrace.db "PRAGMA wal_checkpoint(FULL);"
   pnpm db:push-d1          # local D1
   pnpm db:push-d1:remote   # production D1 (first-time / disaster recovery only)
   ```
   Push is batched and resumable with live `Push N%` progress. Re-run the same command to resume from checkpoint. Prefer avoiding `--clear` on resume.
5. Set `CORS_ORIGINS` under `[env.production.vars]` in `wrangler.toml` to your Worker URL(s). `ENVIRONMENT=production` is already pinned there (`pnpm cf:deploy` uses `--env production`).
6. Set the same `database_id` on both top-level and `[[env.production.d1_databases]]`.
7. Deploy: `pnpm cf:deploy` (Worker name: `cointrace-production`; `[env.production.vars]` includes `RATE_LIMIT_MS=8000`)
8. Cloudflare dashboard (defense-in-depth): enable Bot Fight Mode and/or rate-limiting rules for the Worker hostname; optionally WAF managed rules if available on your plan

### Ops CLI (no public admin HTTP)

```bash
# Against production D1 (preferred once live)
node apps/indexer/dist/index.js add-hacker <addr> --label "…" --remote
node apps/indexer/dist/index.js remove-hacker <addr> --remote
node apps/indexer/dist/index.js clear-queue --remote   # before/after JOB_PRIORITY changes; then let cron re-enqueue

# Local SQLite (default)
node apps/indexer/dist/index.js add-hacker <addr>
```

Pull prod for local analysis (export is all-or-nothing; SQL→SQLite import is resumable with `Import N%`):

```bash
pnpm db:pull-d1:remote
# Interrupted import: node scripts/d1-to-sqlite.mjs --remote --skip-export
```

### Security notes (public deploy)

- Public read APIs power the SPA; downstream crawl is indexer/cron-only (no public expand HTTP). Hacker add/remove is CLI-only (no admin HTTP).
- **CSRF tokens are N/A** without cookie sessions; CORS allowlist + rate limits are the controls.
- App-level per-IP rate limits (GET, graph) apply **only when `ENVIRONMENT=production`**. Local Node and `pnpm cf:dev` skip them. See `GET_*`, `GRAPH_*` env knobs.
- Graph UI poll interval comes from `GET /api/config` (`graphPollMs`: **30s** non-production, **120s** production). The client caches recent `/api/graph` responses by query key (instant revisit via dropdown/Page Down); concurrent misses for the same key share one in-flight request. Only the poll interval revalidates from the network.
- Production requires explicit `CORS_ORIGINS` (`assertProductionSecrets`).
- Before deploy: `pnpm audit` (or `npx pnpm@9.15.0 audit`).
- SQL: Store uses parameterized Drizzle queries; addresses are validated at the API/CLI boundary; remote ops SQL is generated from validated inputs (never hand-typed by the operator).

Cron (`*/1 * * * *`) runs indexer ticks on the Worker.

## Architecture

- **packages/db** — SQLite/D1 schema + Store
- **packages/core** — Esplora/Mempool router, indexer, graph builder, ColdcardWatch sync
- **packages/api** — Hono REST API (Node `server.ts` + Worker `worker.ts`)
- **apps/indexer** — CLI job processor (local)
- **apps/web** — React Flow UI (Vite; served as Worker assets on CF)
