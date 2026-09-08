import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";
import { transactions } from "./schema.js";
import { eq } from "drizzle-orm";

describe("upsertTransaction", () => {
  let store: Store;
  let db: ReturnType<typeof openDatabase>["db"];

  beforeEach(() => {
    const opened = openDatabase(":memory:");
    runMigrations(opened.sqlite);
    db = opened.db;
    store = new Store(db);
  });

  it("preserves existing readable op_return on conflict", async () => {
    await store.upsertTransaction({
      txid: "abc123",
      opReturnDisplay: "hello",
      blockHeight: 100,
    });
    await store.upsertTransaction({
      txid: "abc123",
      opReturnDisplay: "replaced",
      blockHeight: 101,
    });

    const row = await db.select().from(transactions).where(eq(transactions.txid, "abc123")).get();
    expect(row?.opReturnDisplay).toBe("hello");
    expect(row?.blockHeight).toBe(101);
  });

  it("fills op_return when existing value is empty", async () => {
    await store.upsertTransaction({ txid: "abc123", opReturnDisplay: "" });
    await store.upsertTransaction({ txid: "abc123", opReturnDisplay: "filled" });

    const row = await db.select().from(transactions).where(eq(transactions.txid, "abc123")).get();
    expect(row?.opReturnDisplay).toBe("filled");
  });
});
