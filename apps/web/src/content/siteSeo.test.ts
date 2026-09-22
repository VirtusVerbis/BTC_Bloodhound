import { describe, expect, it } from "vitest";
import { normalizePathname, pathnameToRoute } from "./siteSeo";

describe("normalizePathname", () => {
  it("strips trailing slashes except on root", () => {
    expect(normalizePathname("/about/")).toBe("/about");
    expect(normalizePathname("/queue/")).toBe("/queue");
    expect(normalizePathname("/")).toBe("/");
  });
});

describe("pathnameToRoute", () => {
  it("maps known paths including trailing slash variants", () => {
    expect(pathnameToRoute("/about")).toBe("/about");
    expect(pathnameToRoute("/about/")).toBe("/about");
    expect(pathnameToRoute("/queue/")).toBe("/queue");
    expect(pathnameToRoute("/")).toBe("/");
  });

  it("returns null for unknown paths", () => {
    expect(pathnameToRoute("/nope")).toBeNull();
    expect(pathnameToRoute("/about/extra")).toBeNull();
  });
});
