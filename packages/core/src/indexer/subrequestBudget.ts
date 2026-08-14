/** Tracks Cloudflare subrequest budget per Worker invocation (D1 + fetch). */
export interface SubrequestBudget {
  canConsume(n?: number): boolean;
  consume(n?: number): void;
  remaining(): number;
  exhausted(): boolean;
  used(): number;
  limit(): number;
}

export function createSubrequestBudget(limit: number): SubrequestBudget {
  const cap = Math.max(0, limit);
  let used = 0;

  return {
    canConsume(n = 1): boolean {
      if (cap <= 0) return true;
      return used + Math.max(0, n) <= cap;
    },
    consume(n = 1): void {
      if (cap <= 0) return;
      used += Math.max(0, n);
    },
    remaining(): number {
      if (cap <= 0) return Number.POSITIVE_INFINITY;
      return Math.max(0, cap - used);
    },
    exhausted(): boolean {
      if (cap <= 0) return false;
      return used >= cap;
    },
    used(): number {
      return used;
    },
    limit(): number {
      return cap;
    },
  };
}

/** No-op budget for local CLI / unlimited runs. */
export function createUnlimitedSubrequestBudget(): SubrequestBudget {
  return createSubrequestBudget(0);
}

export function scheduleSubrequestReserve(config: {
  scheduleSubrequestReserve: number;
  scheduleReserveMaintExtra: number;
  hackerMaintenanceEveryNCrons: number;
  maintenanceCronCounter: number;
}): number {
  const base = config.scheduleSubrequestReserve;
  const isMaintTick =
    config.hackerMaintenanceEveryNCrons > 0 &&
    config.maintenanceCronCounter % config.hackerMaintenanceEveryNCrons === 0;
  return base + (isMaintTick ? config.scheduleReserveMaintExtra : 0);
}
