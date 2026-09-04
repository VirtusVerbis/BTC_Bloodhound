import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { D1WranglerClient } from "./d1Wrangler.js";
import { reBackfillHackerRemote } from "./d1Wrangler.js";

const VALID_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function mockClient(queryImpl: (...args: unknown[]) => unknown[]) {
  const execute = vi.fn();
  const executeFile = vi.fn(() => []);
  const query = vi.fn(queryImpl);
  const client = {
    execute,
    executeFile,
    query,
  } as unknown as D1WranglerClient;
  return { client, execute, executeFile, query };
}

describe("reBackfillHackerRemote", () => {
  it("fresh resets state and enqueues backfill job", async () => {
    let writtenSql = "";
    const execute = vi.fn();
    const executeFile = vi.fn((filePath: string) => {
      writtenSql = fs.readFileSync(filePath, "utf8");
      return [];
    });
    const query = vi
      .fn()
      .mockReturnValueOnce([{ is_flagged_hacker: 1 }])
      .mockReturnValueOnce([{ backfill_complete: 1, backfill_state_json: null }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ ok: 1 }]);

    const client = {
      execute,
      executeFile,
      query,
    } as unknown as D1WranglerClient;

    const result = await reBackfillHackerRemote(client, { address: VALID_ADDRESS, fresh: true });

    expect(execute).not.toHaveBeenCalled();
    expect(executeFile).toHaveBeenCalledOnce();
    expect(writtenSql).toContain("expand_status = 'pending'");
    expect(writtenSql).toContain("backfill_complete = 0");
    expect(writtenSql).toContain("backfill_state_json = NULL");
    expect(writtenSql).toContain("INSERT INTO jobs");
    expect(writtenSql).toContain(`'${VALID_ADDRESS}'`);
    expect(result).toEqual({
      address: VALID_ADDRESS,
      enqueuedBackfill: true,
      resumed: false,
      stateReset: true,
    });
  });

  it("resumes incomplete backfill with continuation payload", async () => {
    let writtenSql = "";
    const continuation = JSON.stringify({ chainCursor: "abc123" });
    const { client, executeFile, query } = mockClient(() => []);
    executeFile.mockImplementation((filePath: string) => {
      writtenSql = fs.readFileSync(filePath, "utf8");
      return [];
    });
    query
      .mockReturnValueOnce([{ is_flagged_hacker: 1 }])
      .mockReturnValueOnce([{ backfill_complete: 0, backfill_state_json: continuation }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ ok: 1 }]);

    const result = await reBackfillHackerRemote(client, { address: VALID_ADDRESS });

    expect(executeFile).toHaveBeenCalledOnce();
    expect(writtenSql).toContain("expand_status = 'backfilling'");
    expect(writtenSql).not.toContain("backfill_state_json = NULL");
    expect(writtenSql).toContain("chainCursor");
    expect(result).toEqual({
      address: VALID_ADDRESS,
      enqueuedBackfill: true,
      resumed: true,
      stateReset: false,
    });
  });

  it("no-ops when backfill is complete and not fresh", async () => {
    const { client, executeFile, query } = mockClient(() => []);
    query
      .mockReturnValueOnce([{ is_flagged_hacker: 1 }])
      .mockReturnValueOnce([{ backfill_complete: 1, backfill_state_json: null }]);

    const result = await reBackfillHackerRemote(client, { address: VALID_ADDRESS });

    expect(executeFile).not.toHaveBeenCalled();
    expect(result).toEqual({
      address: VALID_ADDRESS,
      enqueuedBackfill: false,
      resumed: false,
      stateReset: false,
      message: "Backfill already complete; use --fresh to restart",
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports enqueuedBackfill false when job already existed", async () => {
    const { client, executeFile, query } = mockClient(() => []);
    query
      .mockReturnValueOnce([{ is_flagged_hacker: 1 }])
      .mockReturnValueOnce([{ backfill_complete: 0, backfill_state_json: null }])
      .mockReturnValueOnce([{ ok: 1 }])
      .mockReturnValueOnce([{ ok: 1 }]);

    const result = await reBackfillHackerRemote(client, { address: VALID_ADDRESS, fresh: true });

    expect(executeFile).toHaveBeenCalledOnce();
    expect(result.enqueuedBackfill).toBe(false);
  });

  it("no-ops when address is not a flagged hacker", async () => {
    const { client, executeFile, query } = mockClient(() => []);
    query.mockReturnValueOnce([]);

    const result = await reBackfillHackerRemote(client, { address: VALID_ADDRESS });

    expect(executeFile).not.toHaveBeenCalled();
    expect(result).toEqual({
      address: VALID_ADDRESS,
      enqueuedBackfill: false,
      resumed: false,
      stateReset: false,
      message: "Address is not a flagged hacker (no-op)",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
