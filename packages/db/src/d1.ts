import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";
import { classifyD1Error } from "./d1Quota.js";
import { Store, type Db, type StoreOptions } from "./store.js";

/** Minimal D1 binding shape (Cloudflare Workers runtime provides the real type). */
export type D1Binding = {
  prepare(query: string): unknown;
  batch?<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec?(query: string): Promise<unknown>;
};

export type D1Db = DrizzleD1Database<typeof schema>;

export type D1SubrequestSink = (count?: number) => void;

function rethrowIfD1Quota(err: unknown): never {
  const classified = classifyD1Error(err);
  if (classified) throw classified;
  throw err;
}

function wrapBoundStatement(bound: Record<string, unknown>, sink: D1SubrequestSink): Record<string, unknown> {
  const wrapTerminal = (name: string) => {
    const fn = bound[name];
    if (typeof fn !== "function") return;
    bound[name] = async (...args: unknown[]) => {
      sink(1);
      try {
        return await (fn as (...a: unknown[]) => unknown).apply(bound, args);
      } catch (err) {
        rethrowIfD1Quota(err);
      }
    };
  };
  wrapTerminal("run");
  wrapTerminal("all");
  wrapTerminal("first");
  wrapTerminal("raw");
  return bound;
}

function wrapPreparedStatement(stmt: unknown, sink: D1SubrequestSink): unknown {
  if (stmt == null || typeof stmt !== "object") return stmt;
  const prepared = stmt as Record<string, unknown>;
  const bindFn = prepared.bind;
  if (typeof bindFn !== "function") return stmt;
  return {
    ...prepared,
    bind(...args: unknown[]) {
      const bound = bindFn.apply(prepared, args) as Record<string, unknown>;
      return wrapBoundStatement(bound, sink);
    },
  };
}

/** Count D1 subrequests (1 per statement execution or batch call). */
export function instrumentD1Binding(d1: D1Binding, sink: D1SubrequestSink): D1Binding {
  return {
    prepare(query: string) {
      return wrapPreparedStatement(d1.prepare(query), sink);
    },
    async batch<T = unknown>(statements: unknown[]) {
      sink(1);
      if (!d1.batch) throw new Error("D1 batch not available");
      try {
        return await d1.batch<T>(statements);
      } catch (err) {
        rethrowIfD1Quota(err);
      }
    },
    async exec(query: string) {
      sink(1);
      if (!d1.exec) throw new Error("D1 exec not available");
      try {
        return await d1.exec(query);
      } catch (err) {
        rethrowIfD1Quota(err);
      }
    },
  };
}

/** Create a Store backed by Cloudflare D1 (async drizzle driver). */
export function createD1Store(d1: D1Binding, options?: StoreOptions): Store {
  let storeRef: Store | undefined;
  const instrumented = instrumentD1Binding(d1, (n) => storeRef?.consumeSubrequests(n ?? 1));
  const db = drizzle(instrumented as Parameters<typeof drizzle>[0], { schema });
  storeRef = new Store(db as unknown as Db, { ...options, d1: instrumented });
  return storeRef;
}
