# Bitcoin Bloodhound - Coldcard Hack Visual Tracker

Track public Coldcard hack consolidation addresses, victim inputs, and downstream flows.

**Local build:** `pnpm install && pnpm -r run build`

**Remote deploy:** `pnpm cf:deploy` (`npx wrangler deploy --env production`)

## Hosting modes

Same codebase, two deployments:

| Mode | Stack | When to use |
|------|-------|-------------|
| **Local** | Node API + SQLite + local indexer process + Vite dev server (or Docker) | Development, analysis snapshots, self-host |
| **Remote** | Cloudflare Worker + D1 + static UI; indexer runs on Worker cron | Production ([bitcoinbloodhound.com](https://www.bitcoinbloodhound.com)) |

### Local

- **API:** Node + SQLite (`pnpm dev:api`)
- **Indexer:** background CLI (`pnpm --filter @cointrace/indexer run`)
- **Web:** Vite dev server (`pnpm dev:web`) or Docker (`docker compose`)
- **Ops CLI:** omit `--remote` (targets local SQLite via `DATABASE_URL`)
- **DB sync:** pull prod snapshot for analysis with `pnpm db:pull-d1:remote`

### Remote

- **Deploy:** `pnpm cf:deploy` → Worker + D1 + bundled web UI
- **Indexer:** Cloudflare cron (`*/1 * * * *`) on the Worker — no separate indexer process
- **Ops CLI:** add `--remote` for live prod changes (add/remove hacker, clear-queue, etc.)
- **Source of truth:** production D1; use `pnpm db:pull-d1:remote` (not `db:push-d1:remote`) for normal local refresh

**Security (remote):** public read APIs only — hacker add/remove is CLI-only (no admin HTTP). Production requires explicit `CORS_ORIGINS`; per-IP rate limits apply when `ENVIRONMENT=production`. Run `pnpm audit` before deploy.

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
| `pnpm --filter @cointrace/indexer run` | Background indexer (cron + job queue); add `--job-details` for verbose cron/job tracing; add `--log-color` for ANSI-colored log labels |
| `node apps/indexer/dist/index.js add-hacker <addr> [--label …] [--remote]` | Upsert flagged hacker (`source=ops`) + enqueue backfill |
| `node apps/indexer/dist/index.js remove-hacker <addr> [--no-prune] [--remote]` | Soft-unflag; prune exclusive victims/downstream by default |
| `node apps/indexer/dist/index.js clear-queue [--remote]` | Delete pending/running jobs only (queue depth → 0) |
| `node apps/indexer/dist/index.js list-queue [--remote] [--status active\|pending\|running\|all] [--type <jobType>] [--limit N] [--summary] [--next-cron]` | Read-only queue audit (JSON by default; `--summary` prints ASCII type counts sorted by priority high→low) |
| `node apps/indexer/dist/index.js prune-invalid-addresses [--remote] [--dry-run]` | Scan all address roles; remove rows that fail mainnet checksum validation |

Bitcoin addresses are validated with checksum decoding (`bitcoinjs-lib`) at ingest and via the API. Scrapers use regex only as finders; invalid candidates are dropped before insert/enqueue.

### Dev & deploy

| Command | Description |
|---------|-------------|
| `pnpm dev:api` | Hono API server (Node + SQLite) |
| `pnpm dev:web` | Vite dev server |
| `pnpm cf:dev` | Cloudflare Workers + D1 + static UI (local wrangler dev) |
| `pnpm cf:deploy` | Deploy Worker + assets to Cloudflare (`--env production`) |
| `pnpm db:pull-d1:remote` | **Preferred sync:** prod D1 → local SQLite snapshot (resumable import) |
| `pnpm db:pull-d1` | Local wrangler D1 → local SQLite |
| `pnpm db:push-d1` | Bootstrap only: local SQLite → local D1 (resumable batches) |
| `pnpm db:push-d1:remote` | **Danger:** local SQLite → prod D1 (bootstrap/DR only; `--clear` wipes prod) |

### Invalid address cleanup (prod)

After building, preview then remove checksum-invalid rows (all roles — hackers, victims, downstream):

```powershell
npx pnpm@9.15.0 --filter @cointrace/core --filter @cointrace/indexer run build
node apps/indexer/dist/index.js prune-invalid-addresses --remote --dry-run
node apps/indexer/dist/index.js prune-invalid-addresses --remote
node apps/indexer/dist/index.js clear-queue --remote   # optional: reset stale jobs
node apps/indexer/dist/index.js list-queue --remote --type backfill_hacker_address
```

Local SQLite: omit `--remote` and set `DATABASE_URL` if needed.

Deploy the Worker after merge so cron ingest uses the new validation gates.

### Hacker backfill (stop indexer before `--wait`)

| Command | Description |
|---------|-------------|
| `node apps/indexer/dist/index.js re-backfill-hacker <addr> [--wait] [--fresh]` | One hacker: resume by default; `--wait` blocks until done; `--fresh` resets cursor |
| `node apps/indexer/dist/index.js re-backfill-hackers [--wait] [--fresh]` | All hackers: skips complete unless `--fresh`; queue mode enqueues jobs without wiping resumable cursors |

Queue mode requires the indexer (`run`) to process jobs. `--wait` runs synchronously per hacker (same resume/429 behavior as singular `--wait`).

### Indexer job scheduling

Fair scheduling keeps graph ingest ahead of maintenance work. Cloudflare cron uses in-tick pacing (`sleepOnRateLimit`) with configurable `JOBS_PER_TICK` (production `3`) and `TICK_BUDGET_MS` (default `50000`). A D1 tick lease prevents overlapping crons from interrupting in-flight work.

- **Reserved ingest slot:** each tick runs a pending `backfill_hacker_address`, `audit_hacker_backfill`, or `expand_downstream` job before polls/balance/price (continuation jobs preferred).
- **Enqueue caps (per cron tick):** code defaults are `CRAWL_ENQUEUE_PER_CRON=3`, `DOWNSTREAM_POLL_ENQUEUE_PER_CRON=2`, `POLL_HACKER_ENQUEUE_PER_CRON=1` (round-robin). **Production Phase 1 (queue drain)** pins lower caps in `wrangler.toml` `[env.production.vars]`: `CRAWL_ENQUEUE_PER_CRON=1`, `DOWNSTREAM_POLL_ENQUEUE_PER_CRON=1`, `HACKER_MAINTENANCE_EVERY_N_CRONS=20`, `BALANCE_REFRESH_INTERVAL_SEC=900`, `DOWNSTREAM_POLL_INTERVAL_SEC=1200`.
- **Poll gating:** `poll_hacker_address` only enqueues when `backfill_complete=1`.
- **Priority tiers:** backfill/expand > polls > sync > balance/USD price.
- **Overlap safety:** `RUNNING_JOB_STALE_MS` (default `120000`) only reclaims stale running jobs; active tick holds `scheduler_state.tick_lease_until`.
- **Cron debug logging:** set `INDEXER_JOB_DETAILS=1` (Worker env / wrangler.toml) or run local indexer with `--job-details` to emit `[cron] tick start`, `[cron] schedule done`, `[job] start`, and `[cron] tick done` in `wrangler tail`. Off by default. `[job] done`, `[job] fail`, and `[job] defer` are always logged. `[job] fail` and gated `[job] start` include `attempts`, `processedIndex`, `pendingTxidsCount`, and abbreviated `chainCursor` when present.
- **Log colorization:** set `INDEXER_LOG_COLOR=1` (Worker env / wrangler.toml) or run local indexer with `--log-color` to ANSI-colorize log prefixes and key labels (`id=`, `type=`, `address=`, `continuation=`, `error=`, `attempts=`, `duration=`, `queue=`) in `wrangler tail`.
- **Rate-limit defer:** ingest jobs (`backfill_hacker_address`, `audit_hacker_backfill`, `expand_downstream`) that fail repeatedly with `Rate limit not ready` are deferred after `JOB_DEFER_AFTER_ATTEMPTS` (default `20`) failures: `run_after` is pushed out by `JOB_DEFER_SEC` (default `86400` = 24h), `attempts` resets to `0`, and the cron picks another eligible job. Below the threshold, the job is re-queued with a short `retryAt` as today.
- **Phase 2 (steady-state):** when backlog is stable, relax production caps toward `CRAWL_ENQUEUE_PER_CRON=2`, `HACKER_MAINTENANCE_EVERY_N_CRONS=10`, `BALANCE_REFRESH_INTERVAL_SEC=600`, `DOWNSTREAM_POLL_INTERVAL_SEC=600`.

## Docker (self-host)

```bash
pnpm -r run build
cd docker && docker compose up --build
```

Web: http://localhost:8080

## Architecture

- **packages/db** — SQLite/D1 schema + Store
- **packages/core** — Esplora/Mempool router, indexer, graph builder, ColdcardWatch sync
- **packages/api** — Hono REST API (Node `server.ts` + Worker `worker.ts`)
- **apps/indexer** — CLI job processor (local)
- **apps/web** — React Flow UI (Vite locally; static assets on Worker in remote deploy)
