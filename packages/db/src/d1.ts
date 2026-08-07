/**
 * D1 adapter stub — use same SQL as SQLite Store when deploying to Cloudflare Workers.
 * Replace better-sqlite3 with env.DB (D1Database) via drizzle-orm/d1.
 */
export type D1Binding = unknown;

export function createD1Store(_db: D1Binding) {
  throw new Error("D1 adapter: implement with drizzle-orm/d1 when deploying to Cloudflare");
}
