import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorApi } from "../api/types";
import { useApp } from "../app/store";
import { Thumbnail } from "./Thumbnail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeApi(fileUrl: FloorApi["fileUrl"]): FloorApi {
  return { fileUrl } as unknown as FloorApi;
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
