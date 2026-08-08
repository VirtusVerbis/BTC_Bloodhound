# Cointrace — Coldcard Hack Tracker POC

Track public Coldcard hack consolidation addresses, victim inputs, and downstream flows.

## Quick start (local)

```bash
pnpm install
pnpm -r run build
cp config/settings.example.env .env

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
| `pnpm dev:api` | Hono API server (Node + SQLite) |
| `pnpm dev:web` | Vite dev server |
| `pnpm cf:dev` | Cloudflare Workers + D1 + static UI (local) |
| `pnpm cf:deploy` | Deploy Worker + assets to Cloudflare |
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
2. Copy `.dev.vars.example` → `.dev.vars` and set `ADMIN_TOKEN`
3. Apply migrations: `pnpm db:d1:migrate` (local) / `pnpm db:d1:migrate:remote`
4. Optional — copy existing local data (avoids re-crawl):
   ```bash
   sqlite3 data/cointrace.db "PRAGMA wal_checkpoint(FULL);"
   pnpm db:push-d1          # local D1
   pnpm db:push-d1:remote   # production D1
   ```
5. Set production secret: `npx wrangler secret put ADMIN_TOKEN`
6. Set `CORS_ORIGINS` in `wrangler.toml` `[vars]` to your Worker/Pages URL(s)
7. Deploy: `pnpm cf:deploy`

Production refuses the default `change-me` admin token (`ENVIRONMENT=production`). Cron (`*/1 * * * *`) runs indexer ticks on the Worker.

## Architecture

- **packages/db** — SQLite/D1 schema + Store
- **packages/core** — Esplora/Mempool router, indexer, graph builder, ColdcardWatch sync
- **packages/api** — Hono REST API (Node `server.ts` + Worker `worker.ts`)
- **apps/indexer** — CLI job processor (local)
- **apps/web** — React Flow UI (Vite; served as Worker assets on CF)
