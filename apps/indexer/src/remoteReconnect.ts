import { isD1TransportError } from "@cointrace/core";

export interface ReconnectCoordinatorCallbacks {
  onDeferred?: () => void;
}

/** Tracks tick-scoped reconnect deferral so proxy dispose never races in-flight ticks. */
export class ReconnectCoordinator {
  tickInProgress = false;
  reconnectPending = false;
  tickAbandoned = false;

  constructor(private readonly callbacks: ReconnectCoordinatorCallbacks = {}) {}

  requestReconnect(err: unknown): boolean {
    if (!isD1TransportError(err)) return false;
    if (this.tickInProgress) {
      this.reconnectPending = true;
      this.callbacks.onDeferred?.();
      return false;
    }
    return true;
  }

  shouldFlushReconnect(): boolean {
    return this.reconnectPending && !this.tickInProgress;
  }

  consumePendingReconnect(): boolean {
    if (!this.shouldFlushReconnect()) return false;
    this.reconnectPending = false;
    return true;
  }

  markTickAbandoned(): void {
    this.tickAbandoned = true;
    this.reconnectPending = true;
  }

  consumeTickAbandoned(): boolean {
    if (!this.tickAbandoned) return false;
    this.tickAbandoned = false;
    return true;
  }
}
