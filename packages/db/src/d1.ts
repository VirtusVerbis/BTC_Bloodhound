import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";
import { Store, type Db, type StoreOptions } from "./store.js";

/** Minimal D1 binding shape (Cloudflare Workers runtime provides the real type). */
export type D1Binding = {
  prepare(query: string): unknown;
  batch?<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec?(query: string): Promise<unknown>;
};

export type D1Db = DrizzleD1Database<typeof schema>;

/** Create a Store backed by Cloudflare D1 (async drizzle driver). */
export function createD1Store(d1: D1Binding, options?: StoreOptions): Store {
  const db = drizzle(d1 as Parameters<typeof drizzle>[0], { schema });
  // Store awaits all query terminators; D1 returns Promises at runtime.
  return new Store(db as unknown as Db, { ...options, d1 });
}
