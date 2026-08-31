import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";
import { classifyD1Error } from "./d1Quota.js";
import { D1RowMeter, recordD1BatchMeta, recordD1ResultMeta } from "./d1RowMeter.js";
import { Store, type Db, type StoreOptions } from "./store.js";

/** Minimal D1 binding shape (Cloudflare Workers runtime provides the real type). */
export type D1Binding = {
  prepare(query: string): unknown;
  batch?<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec?(query: string): Promise<unknown>;
};

export type D1Db = DrizzleD1Database<typeof schema>;

export type D1SubrequestSink = (count?: number) => void;

export type D1InstrumentationOptions = {
  subrequestSink?: D1SubrequestSink;
  rowMeter?: D1RowMeter;
};

function rethrowIfD1Quota(err: unknown): never {
  const classified = classifyD1Error(err);
  if (classified) throw classified;
  throw err;
}

function afterD1Success(result: unknown, opts: D1InstrumentationOptions): void {
  if (opts.rowMeter) {
    recordD1ResultMeta(result, opts.rowMeter);
  }
}

function wrapBoundStatement(
  bound: Record<string, unknown>,
  opts: D1InstrumentationOptions,
): Record<string, unknown> {
  const wrapTerminal = (name: string) => {
    const fn = bound[name];
    if (typeof fn !== "function") return;
    bound[name] = async (...args: unknown[]) => {
      opts.subrequestSink?.(1);
      try {
        const result = await (fn as (...a: unknown[]) => unknown).apply(bound, args);
        afterD1Success(result, opts);
        return result;
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

function wrapPreparedStatement(stmt: unknown, opts: D1InstrumentationOptions): unknown {
  if (stmt == null || typeof stmt !== "object") return stmt;
  const prepared = stmt as Record<string, unknown>;
  const bindFn = prepared.bind;
  if (typeof bindFn !== "function") return stmt;
  return {
    ...prepared,
    bind(...args: unknown[]) {
      const bound = bindFn.apply(prepared, args) as Record<string, unknown>;
      return wrapBoundStatement(bound, opts);
    },
  };
}

/** Count D1 subrequests (1 per statement execution or batch call) and optional row metering. */
export function instrumentD1Binding(d1: D1Binding, opts: D1InstrumentationOptions | D1SubrequestSink): D1Binding {
  const instrumentation: D1InstrumentationOptions =
    typeof opts === "function" ? { subrequestSink: opts } : opts;

  return {
    prepare(query: string) {
      return wrapPreparedStatement(d1.prepare(query), instrumentation);
    },
    async batch<T = unknown>(statements: unknown[]) {
      instrumentation.subrequestSink?.(1);
      if (!d1.batch) throw new Error("D1 batch not available");
      try {
        const results = await d1.batch<T>(statements);
        if (instrumentation.rowMeter) {
          recordD1BatchMeta(results, instrumentation.rowMeter);
        }
        return results;
      } catch (err) {
        rethrowIfD1Quota(err);
      }
    },
    async exec(query: string) {
      instrumentation.subrequestSink?.(1);
      if (!d1.exec) throw new Error("D1 exec not available");
      try {
        const result = await d1.exec(query);
        afterD1Success(result, instrumentation);
        return result;
      } catch (err) {
        rethrowIfD1Quota(err);
      }
    },
  };
}

/** Create a Store backed by Cloudflare D1 (async drizzle driver). */
export function createD1Store(d1: D1Binding, options?: StoreOptions): Store {
  let storeRef: Store | undefined;
  const instrumented = instrumentD1Binding(d1, {
    subrequestSink: (n) => storeRef?.consumeSubrequests(n ?? 1),
    rowMeter: options?.d1RowMeter,
  });
  const db = drizzle(instrumented as Parameters<typeof drizzle>[0], { schema });
  storeRef = new Store(db as unknown as Db, { ...options, d1: instrumented });
  return storeRef;
}
