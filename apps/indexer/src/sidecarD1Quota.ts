import { nextUtcMidnightIso, type D1RowMeter } from "@cointrace/db";

export type SidecarD1QuotaLimits = {
  readDailyLimit: number;
  writeDailyLimit: number;
  writeWarnPct: number;
};

export function parseSidecarD1QuotaLimits(env: NodeJS.ProcessEnv = process.env): SidecarD1QuotaLimits {
  return {
    readDailyLimit: parsePositiveInt(env.D1_READ_DAILY_LIMIT, 5_000_000),
    writeDailyLimit: parsePositiveInt(env.D1_WRITE_DAILY_LIMIT, 100_000),
    writeWarnPct: parsePositiveInt(env.D1_WRITE_WARN_PCT, 90),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export function formatQuotaPct(used: number, limit: number): string {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  return `${used}/${limit} (${pct.toFixed(1)}%, sidecar today UTC)`;
}

export function formatUtcResetCountdown(now = Date.now()): string {
  const resetAt = new Date(nextUtcMidnightIso()).getTime();
  const sec = Math.max(0, Math.ceil((resetAt - now) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function formatSidecarD1QuotaLine(meter: D1RowMeter, limits: SidecarD1QuotaLimits): string {
  meter.rolloverIfNeeded();
  const snap = meter.snapshot();
  return `d1R=${formatQuotaPct(snap.rowsRead, limits.readDailyLimit)} d1W=${formatQuotaPct(
    snap.rowsWritten,
    limits.writeDailyLimit,
  )} resetIn=${formatUtcResetCountdown()}`;
}

export function shouldWarnWrites(
  meter: D1RowMeter,
  writeDailyLimit: number,
  writeWarnPct: number,
): boolean {
  meter.rolloverIfNeeded();
  const threshold = Math.floor((writeDailyLimit * writeWarnPct) / 100);
  return meter.snapshot().rowsWritten >= threshold;
}

export async function promptContinueOnWriteQuota(opts: {
  meter: D1RowMeter;
  limits: SidecarD1QuotaLimits;
  ask: (question: string) => Promise<string>;
  isTty: boolean;
  log: (message: string) => void;
  logWarn: (message: string) => void;
}): Promise<boolean> {
  const snap = opts.meter.snapshot();
  const threshold = Math.floor((opts.limits.writeDailyLimit * opts.limits.writeWarnPct) / 100);
  const resetIn = formatUtcResetCountdown();

  if (!opts.isTty) {
    opts.logWarn(
      `[sidecar] D1 write quota (sidecar today UTC) at ${opts.limits.writeWarnPct}% ` +
        `(${snap.rowsWritten}/${opts.limits.writeDailyLimit}). Not full account usage. ` +
        `Reset in ${resetIn}. Non-interactive stdin — pausing.`,
    );
    return false;
  }

  const question =
    `[sidecar] D1 write quota (sidecar today UTC) at ${opts.limits.writeWarnPct}% ` +
    `(${snap.rowsWritten}/${opts.limits.writeDailyLimit}, threshold ${threshold}). ` +
    `Not full account usage. Reset in ${resetIn}. Continue? [Y/n] `;

  const answer = (await opts.ask(question)).trim().toLowerCase();
  if (answer === "" || answer === "y" || answer === "yes") return true;
  return false;
}
