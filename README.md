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
| `node apps/indexer/dist/index.js pause-cron [--remote]` | Set `cron_indexer_paused=1` so Worker cron skips indexer ticks (no redeploy) |
| `node apps/indexer/dist/index.js resume-cron [--remote]` | Clear cron pause; Worker cron resumes indexer ticks |
| `node apps/indexer/dist/index.js cron-status [--remote]` | Print pause flag, tick lease, queue depth, pending/running counts, API backoff |

Bitcoin addresses are validated with checksum decoding (`bitcoinjs-lib`) at ingest and via the API. Scrapers use regex only as finders; invalid candidates are dropped before insert/enqueue.

### Remote indexer sidecar (prod D1 drain)

When Cloudflare Workers Free CPU limits stall cron ingest, run the indexer locally against **production D1** while cron is paused. The public HTTP API (`fetch`) keeps serving reads; only `scheduled()` indexer ticks are disabled.

**Prerequisites:** `npx wrangler login` (same Cloudflare account as prod). Apply migration `0018_cron_indexer_paused` on prod D1 (`pnpm db:d1:migrate:remote`). Production D1 uses `remote = true` on `[[env.production.d1_databases]]` so `getPlatformProxy` proxies to prod (not empty local `.wrangler` D1).

**Playbook:**

```bash
pnpm -r run build
node apps/indexer/dist/index.js pause-cron --remote
node apps/indexer/dist/index.js cron-status --remote   # verify cron_indexer_paused=1
node apps/indexer/dist/index.js run --remote           # Ctrl+C to stop
node apps/indexer/dist/index.js resume-cron --remote
```

`run --remote` loads `config/sidecar.env` by default (see `config/sidecar.env.example`). Tuned defaults: `RATE_LIMIT_MS=6500`, `BACKFILL_TXS_PER_JOB=10`, `JOBS_PER_TICK=3`, `CRON_INTERVAL_SEC=300`, `MAX_CHAIN_CALLS_PER_JOB=5`. Sidecar allows up to **3** paired light jobs per tick when `SUBREQUEST_LIMIT_PER_INVOCATION=0` (prod cron stays capped at 2). Verbose logging uses **sidecar** color mode: white `[sidecar]` lines; `[job]`/`[cron]` lines use prod cron label colors with highlighted progress fields (`pendingTxidsCount`, `processedIndex`, `progress`, `pagesFetched`, `apiBackoff`). A **30s heartbeat** reports `queue`, `pending`, `running`, and `apiBackoff`. Pass `--no-job-details` / `--no-log-color` to disable. Refuses to start unless cron is paused (unless `--allow-cron-active`). After changing `sidecar.env`, restart the sidecar and watch `apiBackoff` in heartbeats; roll `RATE_LIMIT_MS` back to `8000` on any 429.

While `cron_indexer_paused=1`, production `/api/config` returns `hackersPollMs: 60000` so the hacker dropdown **"Last activity"** group refreshes every **1 minute** (requires Worker + web deploy). After `resume-cron --remote`, polling returns to **1 hour** automatically. Refresh the browser tab after pausing/resuming cron to pick up the new interval immediately.

`/api/hackers` returns the stored top-N (`RECENT_HACKERS_LIMIT`, default `5`) hackers by last graph-ingest timestamp with no age cutoff.

Esplora/Mempool 429 backoff is stored in prod `scheduler_state` (`esplora_retry_after_at`, `mempool_retry_after_at`) — shared with cron when you resume. Sidecar uses `sleepOnRateLimit: true` so ticks wait on provider pacing instead of failing immediately.

**Do not** run sidecar while cron is actively ticking (default guard). **Do not** enqueue ops jobs during sidecar without understanding overlap.

Transient D1 errors during tick or lease cleanup are logged (with underlying `cause` when available) and retried on the next tick. On wrangler remote-proxy transport failures, the sidecar auto-reopens prod D1 (`dispose` + reconnect) without a manual restart — **never during an active tick** (deferred to tick `finally`). Dispose/open each time out at 30s. A tick watchdog (~`TICK_BUDGET_MS` + 10s lease skew + 30s) abandons hung ticks, reconnects, and reclaims orphaned `running` jobs. If reconnect keeps failing, logs show `[sidecar] remote D1 reconnect failed` with exponential backoff (5s–60s); restart `run --remote` and check `cron-status --remote` as a last resort.

### Dev & deploy

| Command | Description |
|---------|-------------|
| `pnpm dev:api` | Hono API server (Node + SQLite) |
| `pnpm dev:web` | Vite dev server |
| `pnpm cf:dev` | Cloudflare Workers + D1 + static UI (local wrangler dev) |
| `pnpm cf:deploy` | Deploy Worker + assets to Cloudflare (`--env production`) |
| `pnpm db:pull-d1:remote` | **Preferred sync:** prod D1 → local SQLite snapshot (resumable import). After prod schema migrations, run this to refresh local schema + data. |
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

Fair scheduling keeps graph ingest ahead of maintenance work. Cloudflare cron runs with `sleepOnRateLimit: false` (Workers cannot sleep between chain calls); pacing is enforced via global `RATE_LIMIT_MS` spacing and `MAX_CHAIN_CALLS_PER_JOB`. Production sets `MAX_CHAIN_CALLS_PER_JOB=1` so each job makes at most one Esplora/Mempool call, saving progress, and enqueuing a continuation when more work remains (fetch page and process tx run on separate cron ticks). Local CLI indexer defaults to `MAX_CHAIN_CALLS_PER_JOB=0` (unlimited per job) and uses in-process sleep between calls. Configurable `JOBS_PER_TICK` (production `1`) and `TICK_BUDGET_MS` (default `50000`). A D1 tick lease prevents overlapping crons from interrupting in-flight work.

**Workers Free subrequest budget:** Cloudflare Free allows **50 subrequests per cron invocation** (each D1 `prepare().run()` / `.all()` / `.first()`, each `d1.batch()`, and each outbound `fetch()` attempt including retries). Cron `subreq=` telemetry counts **all** D1 and fetch usage during the tick via central instrumentation on the D1 binding and `instrumentedFetch`. Production `[env.production.vars]` sets `SUBREQUEST_LIMIT_PER_INVOCATION=50`, reserves subrequests for the schedule phase (`SCHEDULE_SUBREQUEST_RESERVE`), and chunks graph/sync work via `MAX_SUBREQUESTS_PER_JOB`, `MAX_EDGES_PER_JOB`, `D1_BATCH_SIZE`, and `SYNC_ADDRESSES_PER_JOB`. Trace apply and source sync use continuation job payloads (`traceEdgeIndex`, `traceEdgesFlat`, batched sync payloads). **After deploy**, observe real `sched=` / `work=` percentiles in `wrangler tail` for ~20 ticks before lowering `SCHEDULE_SUBREQUEST_RESERVE` (e.g. 38 → 15–20). `stop=subreq` means the tick budget was exhausted; `stop=jobs_cap` means `JOBS_PER_TICK` was reached with budget remaining. Workers Paid defaults to 10,000 subrequests per invocation.

**Workers Free CPU limits:** Cron also hits a separate **CPU time** cap (~10 ms per invocation on Free). Subrequest chunking does **not** prevent `Exceeded CPU Limit` kills. Three independent budgets apply: **CPU** (sync graph work), **subrequests** (D1 + fetch count), and **wall-clock** (`TICK_BUDGET_MS`). Production CPU tuning in `wrangler.toml`:

| Var | Role |
|-----|------|
| `MAX_EDGES_PER_JOB` | Edges applied per job chunk (production `3`) |
| `MAX_GRAPH_EDGES_PER_TX` | Cap fanout edge computation per tx (production `50`) |
| `MAX_SUBREQUESTS_PER_JOB` | D1/fetch cap per job (production `6`) |
| `JOB_CPU_GUARD_MS` | Cumulative sync-CPU budget per job; early continuation (production `7`) |
| `RECENT_HACKERS_LIMIT` | Top N hacker addresses in global recent-activity cache (default `5`) |

**Validate in `wrangler tail`:** healthy ticks end with `[cron] tick done`; jobs show `[job] done continued=true traceEdge=X/Y edgesApplied=N` on fanout traces. Missing `[cron] tick done` after `[job] start` indicates a hard CPU kill mid-job. Optional `[job] done … cpuGuard=1` means the job stopped early via `JOB_CPU_GUARD_MS` and enqueued a continuation.

**CPU tuning playbook** (if kills persist after deploy): (1) lower `MAX_EDGES_PER_JOB` (e.g. 3 → 2), (2) lower `MAX_GRAPH_EDGES_PER_TX` (e.g. 50 → 30), (3) adjust `JOB_CPU_GUARD_MS` down if guard trips too late or up if jobs stop too early. Workers Free caps throughput; these settings maximize what a single cron Worker can do without a Paid plan or external processor.

- **Reserved ingest slot:** each tick runs a pending `backfill_hacker_address`, `audit_hacker_backfill`, or `expand_downstream` job before polls/balance/price (continuation jobs preferred; includes partial trace apply via `traceEdgeIndex`).
- **Enqueue caps (per cron tick):** code defaults are `CRAWL_ENQUEUE_PER_CRON=3`, `DOWNSTREAM_POLL_ENQUEUE_PER_CRON=2`, `POLL_HACKER_ENQUEUE_PER_CRON=1` (round-robin). **Production (Workers Free)** pins lower caps in `wrangler.toml` `[env.production.vars]`: `CRAWL_ENQUEUE_PER_CRON=1`, `DOWNSTREAM_POLL_ENQUEUE_PER_CRON=1`, `HACKER_MAINTENANCE_EVERY_N_CRONS=40`, `BALANCE_REFRESH_INTERVAL_SEC=900`, `DOWNSTREAM_POLL_INTERVAL_SEC=1200`.
- **Poll gating:** `poll_hacker_address` only enqueues when `backfill_complete=1`.
- **Priority tiers:** backfill/expand > polls > sync > balance/USD price.
- **Overlap safety:** `RUNNING_JOB_STALE_MS` (default `120000`) only reclaims stale running jobs; active tick holds `scheduler_state.tick_lease_until`.
- **Cron debug logging:** set `INDEXER_JOB_DETAILS=1` (Worker env / wrangler.toml) or run local indexer with `--job-details` to emit `[cron] tick start`, `[cron] schedule done`, `[job] start`, and `[cron] tick done` in `wrangler tail`. Off by default. `[job] done`, `[job] fail`, and `[job] defer` are always logged. Schedule/tick lines include subrequest budget telemetry when `SUBREQUEST_LIMIT_PER_INVOCATION > 0`: `subreq=used/limit`, `sched=` (schedule phase), `work=` (job phase), `rem=`, `stop=` (`idle` \| `deadline` \| `subreq` \| `jobs_cap`), plus schedule flags `skipNonCritical`, `crawlEnq`, `pollEnq`, `maint`, `btc`. `[job] done` adds `workSubreq=`, `continued=`, `traceEdge=index/total`, and `edgesApplied=` when chunking applies. `[job] fail` and gated `[job] start` include `attempts`, `processedIndex`, `pendingTxidsCount`, abbreviated `chainCursor`, and (for expand/backfill) `traceEdgeIndex` / `traceEdgesPending` when present. For internal rate-limit gates, `[job] fail` also includes `reason=pacing` (global `RATE_LIMIT_MS` spacing; APIs fine) or `reason=provider-backoff` (both Esplora/Mempool in 429 backoff). HTTP 429 from a provider has no `reason=` field.
- **Log colorization:** set `INDEXER_LOG_COLOR=1` (Worker env / wrangler.toml) or run local indexer with `--log-color` to ANSI-colorize log prefixes and key labels in `wrangler tail`. Existing labels: `id=`, `type=`, `address=`, `continuation=`, `error=`, `attempts=`, `reason=`, `duration=`, `queue=`, `pendingTxidsCount=`, `processedIndex=`, `chainCursor=`, `pagesExhausted=`. Subrequest/chunking labels (each a distinct non-white color): `subreq=`, `sched=`, `work=`, `rem=`, `stop=`, `processed=`, `ms=`, `skipNonCritical=`, `crawlEnq=`, `pollEnq=`, `maint=`, `btc=`, `traceEdge=`, `edgesApplied=`, `workSubreq=`, `continued=`, `cpuGuard=`, `traceEdgeIndex=`, `traceEdgesPending=`.
- **Rate-limit defer:** ingest jobs (`backfill_hacker_address`, `audit_hacker_backfill`, `expand_downstream`) that fail repeatedly with `RateLimitNotReadyError` (`reason=pacing` or `reason=provider-backoff`) are deferred after `JOB_DEFER_AFTER_ATTEMPTS` (default `20`) failures: `run_after` is pushed out by `JOB_DEFER_SEC` (default `86400` = 24h), `attempts` resets to `0`, and the cron picks another eligible job. Below the threshold, the job is re-queued with a short `retryAt` as today.
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
