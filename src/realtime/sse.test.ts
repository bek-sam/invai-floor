import { describe, expect, it, vi } from "vitest";
import { connectSse, type SseMessage, SseParser } from "./sse";

describe("SseParser", () => {
  it("parses events split across chunks, comments and multi-line data", () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.push(": keepalive\n\nevent: queue.changed\nid: 7\nda");
    p.push('ta: {"station":"press"}\n\ndata: a\ndata: b\r\n\r\n');
    expect(got).toEqual([
      { event: "queue.changed", data: '{"station":"press"}', id: "7" },
      { event: "message", data: "a\nb", id: null },
    ]);
    expect(p.lastEventId).toBe("7");
  });
});

function streamResponse(text: string) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

describe("connectSse", () => {
  it("sends the session only as Bearer, never in the URL, reconnects with Last-Event-ID and reports the reconnect", async () => {
    const calls: Record<string, string>[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      calls.push(init?.headers as Record<string, string>);
      if (calls.length === 1) return streamResponse("id: 42\nevent: item.pressed\ndata: {}\n\n");
      if (calls.length === 2) throw new TypeError("offline");
      return streamResponse("");
    }) as unknown as typeof fetch;
    const messages: SseMessage[] = [];
    const onReconnect = vi.fn();
    const stop = connectSse({
      url: "/events",
      token: () => "sess",
      onMessage: (m) => messages.push(m),
      onReconnect,
      fetchImpl,
      minDelayMs: 1,
      maxDelayMs: 2,
    });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    stop();
    // The request URL is exactly opts.url: no ?token= on the first connect or on reconnect.
    expect(urls[0]).toBe("/events");
    expect(urls[1]).toBe("/events");
    expect(urls.some((u) => u.includes("token"))).toBe(false);
    expect(calls[0]?.Authorization).toBe("Bearer sess");
    expect(calls[1]?.["Last-Event-ID"]).toBe("42");
    expect(messages[0]).toMatchObject({ event: "item.pressed", id: "42" });
    expect(onReconnect).toHaveBeenCalled();
  });

  it("stops and calls onUnauthorized once, with no further fetch, on an unauthorized SSE event", async () => {
    const fetchImpl = vi.fn(async () => streamResponse("event: unauthorized\ndata: \n\n"));
    const onUnauthorized = vi.fn();
    const messages: SseMessage[] = [];
    const stop = connectSse({
      url: "/events",
      token: () => "sess",
      onMessage: (m) => messages.push(m),
      onUnauthorized,
      fetchImpl,
      minDelayMs: 1,
      maxDelayMs: 2,
    });
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    // Give a would-be reconnect (minDelayMs: 1) every chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // A transport control event, like ready/ping/shutdown: not forwarded to onMessage.
    expect(messages).toEqual([]);
    stop();
  });

  it("stops and calls onUnauthorized once, with no retry, on a 401 at connect", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 401, body: null }) as unknown as Response,
    );
    const onUnauthorized = vi.fn();
    const onStatus = vi.fn();
    const stop = connectSse({
      url: "/events",
      token: () => "sess",
      onMessage: () => {},
      onUnauthorized,
      onStatus,
      fetchImpl,
      minDelayMs: 1,
      maxDelayMs: 2,
    });
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    stop();
  });
});
