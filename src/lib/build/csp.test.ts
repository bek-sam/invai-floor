import { describe, expect, it } from "vitest";
import { connectSrc, requireApiOrigin } from "./csp";

describe("build-time CSP helpers (T-12-5 review r1)", () => {
  it("throws when VITE_API_URL was never set, instead of a silent https: fallback", () => {
    expect(() => requireApiOrigin(undefined)).toThrow(/VITE_API_URL/);
  });

  it("an explicit empty string means same-origin, not an error", () => {
    expect(requireApiOrigin("")).toBe("");
  });

  it("derives just the origin, dropping path and query", () => {
    expect(requireApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(requireApiOrigin("https://api.example.com/v1?x=1")).toBe("https://api.example.com");
  });

  it("connectSrc pins the origin when cross-origin, omits it when same-origin", () => {
    expect(connectSrc("https://api.example.com")).toBe("'self' https://api.example.com");
    expect(connectSrc("")).toBe("'self'");
  });
});
