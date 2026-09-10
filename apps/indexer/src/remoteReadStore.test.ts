import { describe, expect, it, vi } from "vitest";
import { RemoteReadStore } from "./remoteReadStore.js";
import type { D1WranglerClient } from "./d1Wrangler.js";

function mockClient(queryImpl: (sql: string) => unknown[]): D1WranglerClient {
  return { query: vi.fn(queryImpl) } as unknown as D1WranglerClient;
}

describe("RemoteReadStore.listHackersCached", () => {
  it("reads fresh cache JSON without listHackers SQL", async () => {
    const cacheAt = new Date().toISOString();
    const cacheJson = JSON.stringify([
      {
        address: "bc1qcached",
        role: "hacker",
        label: null,
        source: "admin",
        isFlaggedHacker: true,
        totalReceivedSats: 100,
        liveBalanceSats: null,
        liveBalanceAt: null,
        lastGraphActivityAt: null,
      },
    ]);
    const client = mockClient((sql) => {
      if (sql.includes("FROM scheduler_state")) {
        return [
          {
            id: 1,
            flagged_hackers_cache_json: cacheJson,
            flagged_hackers_cache_at: cacheAt,
          },
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new RemoteReadStore(client);

    const rows = await store.listHackersCached();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe("bc1qcached");
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to listHackers SQL when cache is stale", async () => {
    const client = mockClient((sql) => {
      if (sql.includes("FROM scheduler_state")) {
        return [
          {
            id: 1,
            flagged_hackers_cache_json: "[]",
            flagged_hackers_cache_at: "2020-01-01T00:00:00.000Z",
          },
        ];
      }
      if (sql.includes("FROM addresses WHERE is_flagged_hacker = 1")) {
        return [
          {
            address: "bc1qsql",
            role: "hacker",
            label: null,
            source: "admin",
            is_flagged_hacker: 1,
            total_received_sats: 50,
            live_balance_sats: null,
            live_balance_at: null,
            last_graph_activity_at: null,
          },
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new RemoteReadStore(client);

    const rows = await store.listHackersCached();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe("bc1qsql");
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe("RemoteReadStore.getSyncSnapshot", () => {
  it("returns null", async () => {
    const client = mockClient(() => {
      throw new Error("unexpected query");
    });
    const store = new RemoteReadStore(client);

    const snapshot = await store.getSyncSnapshot({
      maxCrawlDepth: 5,
      downstreamPollIntervalSec: 600,
    });
    expect(snapshot).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("RemoteReadStore.getDownstreamMonitorStatsCached", () => {
  it("returns tree and poll-due counts from cached scheduler_state", async () => {
    const client = mockClient((sql) => {
      if (sql.includes("downstream_tree_count")) {
        return [{ downstream_tree_count: 10, downstream_tree_max_depth: 5 }];
      }
      if (sql.includes("downstream_poll_due_count")) {
        return [
          {
            downstream_poll_due_count: 3,
            downstream_poll_due_at: new Date().toISOString(),
            downstream_poll_max_depth: 5,
            downstream_poll_interval_sec: 600,
            monitor_snapshot_dirty: 0,
          },
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new RemoteReadStore(client);

    const stats = await store.getDownstreamMonitorStatsCached(5, 600, { minExpandSats: 0 });
    expect(stats).toEqual({ treeNodeCount: 10, downstreamPollDueCount: 3 });
  });
});
