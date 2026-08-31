export type D1RowMeterSnapshot = {
  utcDate: string;
  rowsRead: number;
  rowsWritten: number;
};

export type D1RowMeterRolloverListener = () => void;

/** UTC-day scoped accumulator for D1 meta.rows_read / rows_written. */
export class D1RowMeter {
  private utcDate: string;
  private rowsRead = 0;
  private rowsWritten = 0;
  private rolloverListeners: D1RowMeterRolloverListener[] = [];
  private recordListeners: Array<() => void> = [];

  constructor(initialUtcDate = todayUtcDate()) {
    this.utcDate = initialUtcDate;
  }

  onRollover(listener: D1RowMeterRolloverListener): () => void {
    this.rolloverListeners.push(listener);
    return () => {
      this.rolloverListeners = this.rolloverListeners.filter((l) => l !== listener);
    };
  }

  onRecord(listener: () => void): () => void {
    this.recordListeners.push(listener);
    return () => {
      this.recordListeners = this.recordListeners.filter((l) => l !== listener);
    };
  }

  /** Returns true when counters were reset for a new UTC day. */
  rolloverIfNeeded(now = new Date()): boolean {
    const today = todayUtcDate(now);
    if (this.utcDate === today) return false;
    this.utcDate = today;
    this.rowsRead = 0;
    this.rowsWritten = 0;
    for (const listener of this.rolloverListeners) listener();
    return true;
  }

  record(reads: number, writes: number, now = new Date()): boolean {
    const rolled = this.rolloverIfNeeded(now);
    if (reads > 0) this.rowsRead += reads;
    if (writes > 0) this.rowsWritten += writes;
    if (reads > 0 || writes > 0) {
      for (const listener of this.recordListeners) listener();
    }
    return rolled;
  }

  snapshot(): D1RowMeterSnapshot {
    return {
      utcDate: this.utcDate,
      rowsRead: this.rowsRead,
      rowsWritten: this.rowsWritten,
    };
  }

  loadSnapshot(snapshot: D1RowMeterSnapshot): void {
    this.utcDate = snapshot.utcDate;
    this.rowsRead = snapshot.rowsRead;
    this.rowsWritten = snapshot.rowsWritten;
  }

  reset(now = new Date()): void {
    this.utcDate = todayUtcDate(now);
    this.rowsRead = 0;
    this.rowsWritten = 0;
  }
}

export function todayUtcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function metaNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function recordD1ResultMeta(result: unknown, meter: D1RowMeter): boolean {
  const meta = (result as { meta?: { rows_read?: unknown; rows_written?: unknown } } | null)?.meta;
  if (!meta) return meter.rolloverIfNeeded();
  return meter.record(metaNumber(meta.rows_read), metaNumber(meta.rows_written));
}

export function recordD1BatchMeta(results: unknown, meter: D1RowMeter): boolean {
  if (!Array.isArray(results)) return recordD1ResultMeta(results, meter);
  let rolled = false;
  for (const result of results) {
    if (recordD1ResultMeta(result, meter)) rolled = true;
  }
  return rolled;
}
