import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("consumeRateLimit", () => {
  it("allows requests under the limit", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const r1 = await store.consumeRateLimit("test-key", 3, 60);
    const r2 = await store.consumeRateLimit("test-key", 3, 60);
    const r3 = await store.consumeRateLimit("test-key", 3, 60);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  it("denies when limit exceeded in window", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.consumeRateLimit("burst", 2, 60);
    await store.consumeRateLimit("burst", 2, 60);
    const denied = await store.consumeRateLimit("burst", 2, 60);

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.consumeRateLimit("a", 1, 60);
    const b = await store.consumeRateLimit("b", 1, 60);

    expect(b.allowed).toBe(true);
  });
});
