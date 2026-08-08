import { describe, expect, it, vi } from "vitest";
import { fetchGraphDeduped } from "./graphCache";

describe("fetchGraphDeduped", () => {
  it("shares one in-flight fetch per key", async () => {
    const fetchFn = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10)),
    );
    const [a, b] = await Promise.all([
      fetchGraphDeduped("dedup-key-a", fetchFn),
      fetchGraphDeduped("dedup-key-a", fetchFn),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
  });

  it("force bypasses in-flight dedup", async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve("forced"));

    const p1 = fetchGraphDeduped("dedup-key-b", fetchFn);
    const p2 = fetchGraphDeduped("dedup-key-b", fetchFn, { force: true });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    resolveFirst("first");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("first");
    expect(r2).toBe("forced");
  });
});
