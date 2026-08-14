import { describe, expect, it, vi } from "vitest";
import { instrumentedFetch } from "./instrumentedFetch.js";

describe("instrumentedFetch", () => {
  it("counts each fetch attempt before calling global fetch", async () => {
    const sink = { consumeSubrequests: vi.fn() };
    const response = new Response("ok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await instrumentedFetch("https://example.com", undefined, sink);

    expect(sink.consumeSubrequests).toHaveBeenCalledWith(1);
    expect(fetch).toHaveBeenCalledWith("https://example.com", undefined);

    vi.unstubAllGlobals();
  });
});
