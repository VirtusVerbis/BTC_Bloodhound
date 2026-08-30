import { describe, expect, it, vi } from "vitest";
import { ReconnectCoordinator } from "./remoteReconnect.js";

describe("ReconnectCoordinator", () => {
  it("defers reconnect while tick is in progress", () => {
    const onDeferred = vi.fn();
    const coord = new ReconnectCoordinator({ onDeferred });
    coord.tickInProgress = true;
    const err = new Error("D1_ERROR: internal error; reference = abc");

    expect(coord.requestReconnect(err)).toBe(false);
    expect(coord.reconnectPending).toBe(true);
    expect(onDeferred).toHaveBeenCalledOnce();
    expect(coord.shouldFlushReconnect()).toBe(false);
  });

  it("requests immediate reconnect when idle", () => {
    const coord = new ReconnectCoordinator();
    const err = new Error("Failed query: select 1");

    expect(coord.requestReconnect(err)).toBe(true);
    expect(coord.reconnectPending).toBe(false);
  });

  it("flushes pending reconnect after tick ends", () => {
    const coord = new ReconnectCoordinator();
    coord.tickInProgress = true;
    coord.requestReconnect(new Error("Failed query: select 1"));
    coord.tickInProgress = false;

    expect(coord.shouldFlushReconnect()).toBe(true);
    expect(coord.consumePendingReconnect()).toBe(true);
    expect(coord.reconnectPending).toBe(false);
  });

  it("ignores non-transport errors", () => {
    const coord = new ReconnectCoordinator();
    expect(coord.requestReconnect(new Error("no such table: jobs"))).toBe(false);
    expect(coord.reconnectPending).toBe(false);
  });
});
