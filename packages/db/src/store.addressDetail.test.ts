import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("getAddressDetail", () => {
  it("returns relatedTxs, outgoingEdgeCount, totalSent, and hack timing from batched tx lookup", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const victim = "bc1qvictim";
    const hacker = "bc1qhacker";
    const downstream = "bc1qdownstream";

    await store.upsertAddress({ address: victim, role: "victim", source: "derived" });
    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });
    await store.upsertAddress({ address: downstream, role: "downstream", hopFromHacker: 1 });

    await store.upsertTransaction({
      txid: "tx_in",
      blockHeight: 100,
      blockTime: "2020-01-02T00:00:00.000Z",
    });
    await store.upsertTransaction({
      txid: "tx_out",
      blockHeight: 200,
      blockTime: "2020-02-02T00:00:00.000Z",
    });
    await store.upsertTransaction({
      txid: "tx_out2",
      blockHeight: 150,
      blockTime: "2020-01-15T00:00:00.000Z",
    });

    await store.upsertEdge({
      fromAddress: victim,
      toAddress: hacker,
      txid: "tx_in",
      amountSats: 1_000_000,
      blockTime: "2020-01-02T00:00:00.000Z",
      direction: "in_to_hacker",
    });
    await store.upsertEdge({
      fromAddress: victim,
      toAddress: downstream,
      txid: "tx_out",
      amountSats: 500_000,
      blockTime: "2020-02-02T00:00:00.000Z",
      direction: "out",
    });
    await store.upsertEdge({
      fromAddress: victim,
      toAddress: downstream,
      txid: "tx_out2",
      amountSats: 250_000,
      blockTime: "2020-01-15T00:00:00.000Z",
      direction: "out",
    });

    const detail = await store.getAddressDetail(victim);
    expect(detail).not.toBeNull();
    expect(detail!.relatedTxs).toHaveLength(3);
    expect(detail!.relatedTxsTotal).toBe(3);
    expect(detail!.outgoingEdgeCount).toBe(3);
    expect(detail!.totalSent).toBe(1_750_000);
    expect(detail!.relatedTxs.filter((t) => t.direction === "out")).toHaveLength(3);
    expect(detail!.relatedTxs[0]?.txid).toBe("tx_out");
    expect(detail!.hackOccurredAt).toBe("2020-01-02T00:00:00.000Z");
    expect(detail!.hackBlockHeight).toBe(100);
  });

  it("falls back to edge block_time when transaction row is missing", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const victim = "bc1qvictim2";
    const hacker = "bc1qhacker2";

    await store.upsertAddress({ address: victim, role: "victim" });
    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });

    await store.upsertEdge({
      fromAddress: victim,
      toAddress: hacker,
      txid: "tx_missing_row",
      amountSats: 100,
      blockTime: "2019-06-01T12:00:00.000Z",
      direction: "in_to_hacker",
    });

    const detail = await store.getAddressDetail(victim);
    expect(detail!.relatedTxs).toHaveLength(1);
    expect(detail!.relatedTxsTotal).toBe(1);
    expect(detail!.relatedTxs[0]?.blockTime).toBe("2019-06-01T12:00:00.000Z");
    expect(detail!.outgoingEdgeCount).toBe(1);
    expect(detail!.hackOccurredAt).toBe("2019-06-01T12:00:00.000Z");
    expect(detail!.hackBlockHeight).toBeNull();
  });

  it("caps relatedTxs at 50 while aggregates reflect all edges", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const hacker = "bc1qhacker_many";
    const victimPrefix = "bc1qvictim_";

    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });

    await store.upsertTransaction({
      txid: "tx_earliest",
      blockHeight: 50,
      blockTime: "2018-01-01T00:00:00.000Z",
    });

    for (let i = 0; i < 60; i++) {
      const victim = `${victimPrefix}${i}`;
      const txid = `tx_victim_${i}`;
      const blockTime = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
      const amountSats = (i + 1) * 10_000;

      await store.upsertAddress({ address: victim, role: "victim" });
      await store.upsertTransaction({
        txid,
        blockHeight: 100 + i,
        blockTime,
      });
      await store.upsertEdge({
        fromAddress: victim,
        toAddress: hacker,
        txid,
        amountSats,
        blockTime,
        direction: "in_to_hacker",
      });
    }

    await store.upsertEdge({
      fromAddress: hacker,
      toAddress: "bc1qdownstream_out",
      txid: "tx_earliest",
      amountSats: 500,
      blockTime: "2018-01-01T00:00:00.000Z",
      direction: "out_from_hacker",
    });
    await store.upsertAddress({ address: "bc1qdownstream_out", role: "downstream", hopFromHacker: 1 });

    const detail = await store.getAddressDetail(hacker);
    expect(detail).not.toBeNull();
    expect(detail!.relatedTxs).toHaveLength(50);
    expect(detail!.relatedTxsTotal).toBe(61);
    expect(detail!.outgoingEdgeCount).toBe(1);
    expect(detail!.totalSent).toBe(500);
    expect(detail!.relatedTxs[0]?.txid).toBe("tx_victim_59");
    expect(detail!.hackOccurredAt).toBe("2018-01-01T00:00:00.000Z");
    expect(detail!.hackBlockHeight).toBe(50);
  });

  it("returns OP_RETURN from canonical hack tx", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const victim = "bc1qvictim_op";
    const hacker = "bc1qhacker_op";

    await store.upsertAddress({ address: victim, role: "victim" });
    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });

    await store.upsertTransaction({
      txid: "tx_op",
      blockHeight: 100,
      blockTime: "2020-01-02T00:00:00.000Z",
      opReturnDisplay: "ransom note",
    });

    await store.upsertEdge({
      fromAddress: victim,
      toAddress: hacker,
      txid: "tx_op",
      amountSats: 1_000_000,
      blockTime: "2020-01-02T00:00:00.000Z",
      direction: "in_to_hacker",
    });

    const detail = await store.getAddressDetail(victim);
    expect(detail!.opReturn).toBe("ransom note");
    expect(detail!.hackTxid).toBe("tx_op");
  });
});
