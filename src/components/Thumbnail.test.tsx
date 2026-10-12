import { MAX_DOWNLOAD_URLS } from "@invai/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../api/errors";
import type { FloorApi } from "../api/types";
import { useApp } from "../app/store";
import { resetThumbnailState, Thumbnail } from "./Thumbnail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeApi(fileUrl: FloorApi["fileUrl"]): FloorApi {
  // fileUrls is built from the same fileUrl mock: per key, null when that lookup rejects.
  const fileUrls: FloorApi["fileUrls"] = (token, keys) =>
    Promise.all(
      keys.map((fileKey) =>
        fileUrl(token, fileKey).then(
          (r) => ({ fileKey, ...r }),
          () => null,
        ),
      ),
    );
  return { fileUrl, fileUrls } as unknown as FloorApi;
}

function withSession(api: FloorApi) {
  useApp.setState({ api, session: { sessionToken: "tok" } as unknown as never });
}

describe("Thumbnail (T-P3-2: fewer signed-URL calls)", () => {
  it("shares one in-flight request when several thumbnails mount with the same key", async () => {
    let calls = 0;
    const fileUrl = vi.fn(async (_token: string, _key: string) => {
      calls++;
      return {
        url: "data:image/svg+xml,a",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    withSession(fakeApi(fileUrl));

    // Three thumbnails for the same design (the transfer card plus two queue rows) mounting
    // together, as a real queue load does.
    render(
      <>
        <Thumbnail fileKey="demo/dedupe-1" alt="a" />
        <Thumbnail fileKey="demo/dedupe-1" alt="b" />
        <Thumbnail fileKey="demo/dedupe-1" alt="c" />
      </>,
    );

    await waitFor(() => expect(calls).toBe(1));
  });

  it("does not cache a failed lookup: a later mount retries", async () => {
    let calls = 0;
    const fileUrl = vi.fn(async (_token: string, _key: string) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return {
        url: "data:image/svg+xml,b",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    withSession(fakeApi(fileUrl));

    const first = render(<Thumbnail fileKey="demo/retry-1" alt="a" />);
    await waitFor(() => expect(calls).toBe(1));
    first.unmount();

    render(<Thumbnail fileKey="demo/retry-1" alt="a" />);
    await waitFor(() => expect(calls).toBe(2));
  });

  it("drops a cached URL before its signed expiry, instead of serving it stale", async () => {
    let calls = 0;
    const fileUrl = vi.fn(async (_token: string, _key: string) => {
      calls++;
      // Expires almost immediately -- well inside the cache's safety margin.
      return { url: "data:image/svg+xml,c", expiresAt: new Date(Date.now() + 1_000).toISOString() };
    });
    withSession(fakeApi(fileUrl));

    const first = render(<Thumbnail fileKey="demo/ttl-1" alt="a" />);
    await waitFor(() => expect(calls).toBe(1));
    first.unmount();

    render(<Thumbnail fileKey="demo/ttl-1" alt="a" />);
    await waitFor(() => expect(calls).toBe(2));
  });
});

type Signed = { fileKey: string; url: string; expiresAt: string };
const later = () => new Date(Date.now() + 60_000).toISOString();
const signed = (fileKey: string): Signed => ({
  fileKey,
  url: `data:image/svg+xml,${fileKey}`,
  expiresAt: later(),
});
const imgs = (c: HTMLElement) => [...c.querySelectorAll("img")].map((i) => i.getAttribute("src"));

function Many({ keys }: { keys: string[] }) {
  const rows = keys.map((k, n) => ({ id: `${n}:${k}`, k }));
  return rows.map((r) => <Thumbnail key={r.id} fileKey={r.k} alt="x" />);
}

describe("Thumbnail (T-38-3: one batch call per screen)", () => {
  beforeEach(resetThumbnailState);
  afterEach(resetThumbnailState);

  function batchApi(fileUrls: FloorApi["fileUrls"], fileUrl = vi.fn()): FloorApi {
    return { fileUrls, fileUrl } as unknown as FloorApi;
  }

  it("27 thumbnails of 9 distinct keys make one call with 9 keys", async () => {
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => keys.map(signed));
    withSession(batchApi(fileUrls));
    const { container } = render(
      <Many keys={Array.from({ length: 27 }, (_, i) => `art/k${i % 9}`)} />,
    );
    await waitFor(() => expect(imgs(container)).toHaveLength(27));
    expect(fileUrls).toHaveBeenCalledTimes(1);
    expect(fileUrls.mock.calls[0]?.[1]).toEqual(Array.from({ length: 9 }, (_, i) => `art/k${i}`));
  });

  it("splits into chunks of at most MAX_DOWNLOAD_URLS", async () => {
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => keys.map(signed));
    withSession(batchApi(fileUrls));
    const n = MAX_DOWNLOAD_URLS + 5;
    const { container } = render(<Many keys={Array.from({ length: n }, (_, i) => `art/c${i}`)} />);
    await waitFor(() => expect(imgs(container)).toHaveLength(n));
    expect(fileUrls.mock.calls.map((c) => c[1].length).sort((a, b) => a - b)).toEqual([
      5,
      MAX_DOWNLOAD_URLS,
    ]);
  });

  it("never shows another key's URL when the result is shuffled or mismatched", async () => {
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => keys.map(signed).reverse());
    withSession(batchApi(fileUrls));
    const { container } = render(
      <>
        <Thumbnail fileKey="art/m1" alt="a" />
        <Thumbnail fileKey="art/m2" alt="b" />
      </>,
    );
    await waitFor(() => expect(fileUrls).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(imgs(container)).toEqual([]);
  });

  it("fails the batch when the item count differs from the key count", async () => {
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => keys.slice(0, 1).map(signed));
    withSession(batchApi(fileUrls));
    const { container } = render(
      <>
        <Thumbnail fileKey="art/n1" alt="a" />
        <Thumbnail fileKey="art/n2" alt="b" />
      </>,
    );
    await waitFor(() => expect(fileUrls).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(imgs(container)).toEqual([]);
  });

  it("a null for one key fails only that thumbnail and is not cached", async () => {
    let round = 0;
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => {
      round++;
      return keys.map((k) => (k === "art/bad" && round === 1 ? null : signed(k)));
    });
    withSession(batchApi(fileUrls));
    const { container, unmount } = render(
      <>
        <Thumbnail fileKey="art/good" alt="a" />
        <Thumbnail fileKey="art/bad" alt="b" />
      </>,
    );
    await waitFor(() => expect(imgs(container)).toEqual(["data:image/svg+xml,art/good"]));
    unmount();
    const again = render(<Thumbnail fileKey="art/bad" alt="b" />);
    await waitFor(() => expect(imgs(again.container)).toEqual(["data:image/svg+xml,art/bad"]));
    expect(fileUrls).toHaveBeenCalledTimes(2);
  });

  it("falls back to single calls on NOT_FOUND and remembers it", async () => {
    const fileUrls = vi.fn(async () => {
      throw new ApiFailure("rejected", "NOT_FOUND", "not found", 404);
    });
    const fileUrl = vi.fn(async (_t: string, key: string) => signed(key));
    withSession(batchApi(fileUrls, fileUrl));
    const first = render(
      <>
        <Thumbnail fileKey="art/f1" alt="a" />
        <Thumbnail fileKey="art/f2" alt="b" />
      </>,
    );
    await waitFor(() => expect(imgs(first.container)).toHaveLength(2));
    expect(fileUrls).toHaveBeenCalledTimes(1);
    expect(fileUrl).toHaveBeenCalledTimes(2);
    render(<Thumbnail fileKey="art/f3" alt="c" />);
    await waitFor(() => expect(fileUrl).toHaveBeenCalledTimes(3));
    expect(fileUrls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["busy", "RATE_LIMITED"],
    ["unavailable", "NETWORK"],
    ["rejected", "BOOM"],
  ] as const)("a whole-call %s failure does not fan out into single calls", async (kind, code) => {
    const fileUrls = vi.fn(async () => {
      throw new ApiFailure(kind, code, "x");
    });
    const fileUrl = vi.fn(async (_t: string, key: string) => signed(key));
    withSession(batchApi(fileUrls, fileUrl));
    const { container } = render(
      <>
        <Thumbnail fileKey={`art/${code}1`} alt="a" />
        <Thumbnail fileKey={`art/${code}2`} alt="b" />
      </>,
    );
    await waitFor(() => expect(fileUrls).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fileUrl).not.toHaveBeenCalled();
    expect(imgs(container)).toEqual([]);
  });

  it("a mount after dispatch joins the in-flight request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fileUrls = vi.fn(async (_t: string, keys: string[]) => {
      await gate;
      return keys.map(signed);
    });
    withSession(batchApi(fileUrls));
    render(<Thumbnail fileKey="art/j1" alt="a" />);
    await waitFor(() => expect(fileUrls).toHaveBeenCalledTimes(1));
    const late = render(<Thumbnail fileKey="art/j1" alt="b" />);
    release();
    await waitFor(() => expect(imgs(late.container)).toHaveLength(1));
    expect(fileUrls).toHaveBeenCalledTimes(1);
  });
});
