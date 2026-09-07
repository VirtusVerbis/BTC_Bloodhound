import { JOB_PRIORITY } from "../config.js";

export interface ExpandOpsFields {
  ops?: true;
  opsPriority?: number;
}

export function expandOpsFields(payload: Record<string, unknown>): ExpandOpsFields {
  if (payload.ops !== true) return {};
  const opsPriority = payload.opsPriority;
  if (typeof opsPriority !== "number" || !Number.isFinite(opsPriority) || opsPriority < 1) {
    return { ops: true };
  }
  return { ops: true, opsPriority };
}

export function resolveExpandJobPriority(payload: Record<string, unknown>): number {
  const fields = expandOpsFields(payload);
  return fields.opsPriority ?? JOB_PRIORITY.CRON_EXPAND;
}
