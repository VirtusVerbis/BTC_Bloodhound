import { openDatabase, runMigrations } from "./index.js";
import path from "node:path";

const dbPath = process.env.DATABASE_URL?.replace("file:", "") ?? path.join(process.cwd(), "data", "cointrace.db");
const { sqlite } = openDatabase(dbPath);
runMigrations(sqlite);
console.log("Migrations applied:", dbPath);
