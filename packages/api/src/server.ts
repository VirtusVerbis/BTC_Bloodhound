import { serve } from "@hono/node-server";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { assertProductionSecrets, loadConfig } from "@cointrace/core";
import { createApp } from "./app.js";

const config = loadConfig();
assertProductionSecrets(config);
const dbPath = path.resolve(config.databaseUrl.replace("file:", ""));
mkdirSync(path.dirname(dbPath), { recursive: true });
const { sqlite, db } = openDatabase(dbPath);
runMigrations(sqlite);

const store = new Store(db);
const app = createApp(store, config);

const port = Number(process.env.PORT ?? 8787);
console.log(`Cointrace API listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
