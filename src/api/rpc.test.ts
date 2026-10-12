import { describe, expect, it } from "vitest";
import { ApiFailure } from "./errors";
import { alignDownloads } from "./rpc";

const ok = (fileKey: string) => ({
  fileKey,
  download: { url: `https://x/${fileKey}`, expiresAt: "2030-01-01T00:00:00.000Z" },
});

describe("alignDownloads (T-38-3)", () => {
  it("maps items to keys in order, null where there is no download", () => {
    const out = alignDownloads(["a", "b"], [ok("a"), { fileKey: "b", download: null }]);
    expect(out).toEqual([
      { fileKey: "a", url: "https://x/a", expiresAt: "2030-01-01T00:00:00.000Z" },
      null,
    ]);
  });

  it("fails the whole batch on a shuffled order or a wrong length", () => {
    expect(() => alignDownloads(["a", "b"], [ok("b"), ok("a")])).toThrow(ApiFailure);
    expect(() => alignDownloads(["a", "b"], [ok("a")])).toThrow(ApiFailure);
  });
});
