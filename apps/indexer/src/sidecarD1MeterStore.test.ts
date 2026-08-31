import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { todayUtcDate } from "@cointrace/db";
import { flushSidecarD1Meter, loadSidecarD1Meter } from "./sidecarD1MeterStore.js";

describe("sidecarD1MeterStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-meter-"));
    filePath = path.join(tmpDir, "meter.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts fresh when file is missing", () => {
    const { meter, loadedFromFile } = loadSidecarD1Meter(filePath);
    expect(loadedFromFile).toBe(false);
    expect(meter.snapshot().rowsRead).toBe(0);
    expect(meter.snapshot().rowsWritten).toBe(0);
  });

  it("hydrates when utcDate matches today", () => {
    const today = todayUtcDate();
    fs.writeFileSync(
      filePath,
      JSON.stringify({ utcDate: today, rowsRead: 100, rowsWritten: 50 }),
      "utf8",
    );
    const { meter, loadedFromFile } = loadSidecarD1Meter(filePath);
    expect(loadedFromFile).toBe(true);
    expect(meter.snapshot().rowsWritten).toBe(50);
  });

  it("ignores stale utcDate", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ utcDate: "2020-01-01", rowsRead: 100, rowsWritten: 50 }),
      "utf8",
    );
    const { meter, loadedFromFile } = loadSidecarD1Meter(filePath);
    expect(loadedFromFile).toBe(false);
    expect(meter.snapshot().rowsWritten).toBe(0);
  });

  it("round-trips flush", () => {
    const { meter } = loadSidecarD1Meter(filePath);
    meter.record(10, 20);
    flushSidecarD1Meter(meter, filePath);
    const reloaded = loadSidecarD1Meter(filePath);
    expect(reloaded.meter.snapshot().rowsWritten).toBe(20);
  });

  it("warns on corrupt file", () => {
    fs.writeFileSync(filePath, "not-json", "utf8");
    const { loadedFromFile, warning } = loadSidecarD1Meter(filePath);
    expect(loadedFromFile).toBe(false);
    expect(warning).toContain("corrupt");
  });
});
