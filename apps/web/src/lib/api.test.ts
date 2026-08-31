import { describe, expect, it } from "vitest";
import {
  ApiError,
  isHtmlErrorBody,
  isJsonContentType,
  sanitizeApiErrorBody,
} from "./api";

describe("isHtmlErrorBody", () => {
  it("detects doctype HTML", () => {
    expect(isHtmlErrorBody("<!DOCTYPE html><title>rate limited</title>")).toBe(true);
  });

  it("detects cf-wrapper", () => {
    expect(isHtmlErrorBody('{"x":1}<div id="cf-wrapper">')).toBe(true);
  });
});

describe("isJsonContentType", () => {
  it("accepts application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
  });

  it("rejects text/html", () => {
    expect(isJsonContentType("text/html")).toBe(false);
  });
});

describe("sanitizeApiErrorBody", () => {
  it("returns friendly Cloudflare 429 message for HTML", () => {
    const html = "<!DOCTYPE html><html><title>rate limited</title></html>";
    expect(sanitizeApiErrorBody(html, 429, "text/html")).toBe(
      "Site temporarily rate limited by Cloudflare. Please try again in 24 hours.",
    );
  });

  it("returns generic message for non-429 HTML", () => {
    expect(sanitizeApiErrorBody("<html>error</html>", 502, "text/html")).toBe(
      "Unexpected HTML error from server",
    );
  });

  it("returns 24h suffix for non-JSON 429", () => {
    expect(sanitizeApiErrorBody("Too Many Requests", 429, "text/plain")).toBe(
      "Rate limit exceeded. Please try again in 24 hours.",
    );
  });

  it("returns generic message for non-JSON 500", () => {
    expect(sanitizeApiErrorBody("internal", 500, "text/plain")).toBe("Request failed (500)");
  });

  it("appends 24h suffix for JSON 429 error field", () => {
    expect(
      sanitizeApiErrorBody(JSON.stringify({ error: "rate limit exceeded" }), 429, "application/json"),
    ).toBe("rate limit exceeded. Please try again in 24 hours.");
  });

  it("uses JSON error field for non-429", () => {
    expect(
      sanitizeApiErrorBody(JSON.stringify({ error: "not found" }), 404, "application/json"),
    ).toBe("not found");
  });
});

describe("ApiError", () => {
  it("does not surface raw HTML in message", () => {
    const html = "<!DOCTYPE html><html><body>cf-wrapper huge page</body></html>";
    const err = new ApiError(429, html, 60, "text/html");
    expect(err.message).not.toContain("<!DOCTYPE");
    expect(err.message).toContain("Cloudflare");
    expect(err.message).toContain("24 hours");
  });
});
