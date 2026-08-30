import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn(() => ({
  status: 0,
  stdout: "[]",
  stderr: "",
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const {
  D1WranglerClient,
  pauseCronRemote,
  resumeCronRemote,
  getCronStatusRemote,
} = await import("./d1Wrangler.js");

describe("cron pause remote SQL", () => {
  beforeEach(() => {
    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "[]",
      stderr: "",
    });
  });

  it("pauseCronRemote sets cron_indexer_paused=1", () => {
    const client = new D1WranglerClient({ remote: true });
    pauseCronRemote(client);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    const sql = extractSqlFromSpawn();
    expect(sql).toContain("cron_indexer_paused = 1");
  });

  it("resumeCronRemote sets cron_indexer_paused=0", () => {
    const client = new D1WranglerClient({ remote: true });
    resumeCronRemote(client);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    const sql = extractSqlFromSpawn();
    expect(sql).toContain("cron_indexer_paused = 0");
  });

  it("getCronStatusRemote queries scheduler_state and job counts", () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          {
            results: [
              {
                cron_indexer_paused: 1,
                tick_lease_until: null,
                esplora_retry_after_at: null,
                mempool_retry_after_at: null,
              },
            ],
          },
        ]),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          {
            results: [
              { status: "pending", c: 5 },
              { status: "running", c: 1 },
            ],
          },
        ]),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([{ results: [{ c: 3 }] }]),
        stderr: "",
      });

    const client = new D1WranglerClient({ remote: true });
    const status = getCronStatusRemote(client);
    expect(status.cronIndexerPaused).toBe(true);
    expect(status.pending).toBe(5);
    expect(status.running).toBe(1);
    expect(status.queueDepth).toBe(3);
    expect(status.apiBackoff).toBe("none");
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });
});

function extractSqlFromSpawn(): string {
  if (process.platform === "win32") {
    const [command] = spawnSyncMock.mock.calls[0] as [string];
    return command;
  }
  const [, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
  const commandIdx = args.indexOf("--command");
  return args[commandIdx + 1] ?? "";
}
