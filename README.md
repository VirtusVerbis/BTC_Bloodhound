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
| `pnpm dev:api` | Hono API server |
| `pnpm dev:web` | Vite dev server |

## Docker (self-host)

```bash
pnpm -r run build
cd docker && docker compose up --build
```

Web: http://localhost:8080

## Cloudflare (later)

See `wrangler.toml` for D1 + Worker + Cron stubs. Export SQLite and import to D1 when ready.

## Architecture

- **packages/db** — SQLite schema + Store
- **packages/core** — Esplora/Mempool router, indexer, graph builder, ColdcardWatch sync
- **packages/api** — Hono REST API
- **apps/indexer** — CLI job processor
- **apps/web** — React Flow UI

## Phase 6 TODO

- Evaluate 3D graph view
- Mempool WebSocket for faster polling
- Optional self-hosted Esplora profile
