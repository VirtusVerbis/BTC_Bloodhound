import fs from "node:fs";
import path from "node:path";
import { D1RowMeter, todayUtcDate, type D1RowMeterSnapshot } from "@cointrace/db";

export type SidecarD1MeterFile = D1RowMeterSnapshot;

export function defaultSidecarD1MeterPath(): string {
  return process.env.SIDECAR_D1_METER_PATH?.trim() || path.resolve(process.cwd(), "data/sidecar-d1-meter.json");
}

function parseMeterFile(raw: string): SidecarD1MeterFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SidecarD1MeterFile>;
    if (
      typeof parsed.utcDate !== "string" ||
      typeof parsed.rowsRead !== "number" ||
      typeof parsed.rowsWritten !== "number" ||
      !Number.isFinite(parsed.rowsRead) ||
      !Number.isFinite(parsed.rowsWritten) ||
      parsed.rowsRead < 0 ||
      parsed.rowsWritten < 0
    ) {
      return null;
    }
    return {
      utcDate: parsed.utcDate,
      rowsRead: Math.floor(parsed.rowsRead),
      rowsWritten: Math.floor(parsed.rowsWritten),
    };
  } catch {
    return null;
  }
}

export function loadSidecarD1Meter(
  filePath = defaultSidecarD1MeterPath(),
  now = new Date(),
): { meter: D1RowMeter; loadedFromFile: boolean; warning?: string } {
  const today = todayUtcDate(now);
  const meter = new D1RowMeter(today);

  if (!fs.existsSync(filePath)) {
    return { meter, loadedFromFile: false };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { meter, loadedFromFile: false, warning: `could not read ${filePath}` };
  }

  const parsed = parseMeterFile(raw);
  if (!parsed) {
    return { meter, loadedFromFile: false, warning: `corrupt D1 meter file ${filePath}` };
  }

  if (parsed.utcDate !== today) {
    return { meter, loadedFromFile: false };
  }

  meter.loadSnapshot(parsed);
  return { meter, loadedFromFile: true };
}

export function flushSidecarD1Meter(
  meter: D1RowMeter,
  filePath = defaultSidecarD1MeterPath(),
): void {
  meter.rolloverIfNeeded();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(meter.snapshot(), null, 2);
  fs.writeFileSync(filePath, `${payload}\n`, "utf8");
}

export function createDebouncedMeterFlush(
  meter: D1RowMeter,
  filePath = defaultSidecarD1MeterPath(),
  debounceMs = 5_000,
): { flush(): void; flushNow(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) return;
    dirty = false;
    flushSidecarD1Meter(meter, filePath);
  };

  const schedule = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flushNow();
    }, debounceMs);
  };

  return {
    flush: schedule,
    flushNow,
    dispose: () => {
      if (timer) clearTimeout(timer);
      flushNow();
    },
  };
}
