import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { D1WranglerClient } from "./d1Wrangler.js";
import { addHackerRemote } from "./d1Wrangler.js";

const VALID_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

describe("addHackerRemote", () => {
  it("uses executeFile instead of execute and writes both SQL statements", async () => {
    let writtenSql = "";
    const execute = vi.fn();
    const executeFile = vi.fn((filePath: string) => {
      writtenSql = fs.readFileSync(filePath, "utf8");
      return [];
    });
    const query = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ ok: 1 }]);

    const client = {
      execute,
      executeFile,
      query,
    } as unknown as D1WranglerClient;

    const result = await addHackerRemote(client, {
      address: VALID_ADDRESS,
      label: "has spaces",
      source: "admin",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(executeFile).toHaveBeenCalledOnce();
    expect(writtenSql).toContain("INSERT INTO addresses");
    expect(writtenSql).toContain("INSERT INTO jobs");
    expect(writtenSql).toContain("'has spaces'");
    expect(writtenSql).toContain(`'${VALID_ADDRESS}'`);
    expect(writtenSql).toContain("'admin'");
    expect(result).toEqual({
      address: VALID_ADDRESS,
      upserted: true,
      enqueuedBackfill: true,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports enqueuedBackfill false when job already existed", async () => {
    const execute = vi.fn();
    const executeFile = vi.fn(() => []);
    const query = vi
      .fn()
      .mockReturnValueOnce([{ ok: 1 }])
      .mockReturnValueOnce([{ ok: 1 }]);

    const client = {
      execute,
      executeFile,
      query,
    } as unknown as D1WranglerClient;

    const result = await addHackerRemote(client, { address: VALID_ADDRESS });

    expect(result.enqueuedBackfill).toBe(false);
    expect(executeFile).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
