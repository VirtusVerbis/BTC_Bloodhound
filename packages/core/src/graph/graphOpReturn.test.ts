import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { enrichNodesWithOpReturn } from "./graphOpReturn.js";
import type { GraphNode } from "./builder.js";

describe("enrichNodesWithOpReturn", () => {
  it("sets spend-side OP_RETURN on downstream and rolls up to hacker node", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const hacker = "bc1qhacker_graph";
    const downstream = "bc1qdownstream_graph";

    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });
    await store.upsertAddress({ address: downstream, role: "downstream", hopFromHacker: 1 });

    await store.upsertTransaction({
      txid: "tx_sweep",
      blockHeight: 965783,
      blockTime: "2026-09-06T14:28:56.000Z",
    });
    await store.upsertTransaction({
      txid: "tx_message",
      blockHeight: 965818,
      blockTime: "2026-09-06T16:00:00.000Z",
      opReturnDisplay: "we are whitehats. contact us on chain",
    });

    await store.upsertEdge({
      fromAddress: hacker,
      toAddress: downstream,
      txid: "tx_sweep",
      amountSats: 399_599_999_857,
      blockTime: "2026-09-06T14:28:56.000Z",
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: downstream,
      toAddress: "bc1qvictim_dust",
      txid: "tx_message",
      amountSats: 1_000,
      blockTime: "2026-09-06T16:00:00.000Z",
      direction: "out_from_hacker",
    });

    const nodes: GraphNode[] = [
      {
        id: hacker,
        type: "hacker",
        label: "Hacker",
        role: "hacker",
        address: hacker,
      },
      {
        id: downstream,
        type: "downstream",
        label: "Downstream",
        role: "downstream",
        address: downstream,
      },
    ];

    await enrichNodesWithOpReturn(store, nodes);

    expect(nodes[0].opReturn).toBe("we are whitehats. contact us on chain");
    expect(nodes[0].opReturnLabel).toBeTruthy();
    expect(nodes[1].opReturn).toBe("we are whitehats. contact us on chain");
  });

  it("sets incoming funding OP_RETURN on downstream without own spend", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const hacker = "bc1qhacker_graph_in";
    const downstream = "bc1qdownstream_graph_in";

    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });
    await store.upsertAddress({ address: downstream, role: "downstream", hopFromHacker: 1 });

    await store.upsertTransaction({
      txid: "tx_sweep",
      blockHeight: 965783,
      blockTime: "2026-09-06T14:28:56.000Z",
      opReturnDisplay: "sweep note on wire",
    });

    await store.upsertEdge({
      fromAddress: hacker,
      toAddress: downstream,
      txid: "tx_sweep",
      amountSats: 399_599_999_857,
      blockTime: "2026-09-06T14:28:56.000Z",
      direction: "out_from_hacker",
    });

    const nodes: GraphNode[] = [
      {
        id: hacker,
        type: "hacker",
        label: "Hacker",
        role: "hacker",
        address: hacker,
      },
      {
        id: downstream,
        type: "downstream",
        label: "Downstream",
        role: "downstream",
        address: downstream,
      },
    ];

    await enrichNodesWithOpReturn(store, nodes);

    expect(nodes[1].opReturn).toBe("sweep note on wire");
    expect(nodes[1].opReturnLabel).toBeTruthy();
  });

  it("does not set OP_RETURN on victim graph nodes", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const hacker = "bc1qhacker_graph_victim";
    const downstream = "bc1qdownstream_graph_victim";
    const victim = "bc1qvictim_graph";

    await store.upsertAddress({ address: hacker, role: "hacker", isFlaggedHacker: true });
    await store.upsertAddress({ address: downstream, role: "downstream", hopFromHacker: 1 });
    await store.upsertAddress({ address: victim, role: "victim" });

    await store.upsertTransaction({
      txid: "tx_message",
      blockHeight: 965818,
      blockTime: "2026-09-06T16:00:00.000Z",
      opReturnDisplay: "we are whitehats. contact us on chain",
    });

    await store.upsertEdge({
      fromAddress: downstream,
      toAddress: victim,
      txid: "tx_message",
      amountSats: 1_000,
      blockTime: "2026-09-06T16:00:00.000Z",
      direction: "out_from_hacker",
      edgeKind: "victim_dust",
    });

    const nodes: GraphNode[] = [
      {
        id: hacker,
        type: "hacker",
        label: "Hacker",
        role: "hacker",
        address: hacker,
      },
      {
        id: downstream,
        type: "downstream",
        label: "Downstream",
        role: "downstream",
        address: downstream,
      },
      {
        id: victim,
        type: "victim",
        label: "Victim",
        role: "victim",
        address: victim,
      },
    ];

    await enrichNodesWithOpReturn(store, nodes);

    expect(nodes[1].opReturn).toBe("we are whitehats. contact us on chain");
    expect(nodes[2].opReturn).toBeUndefined();
  });
});
