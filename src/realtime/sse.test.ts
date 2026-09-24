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
  it("sends the session as ?token= and Bearer, reconnects with Last-Event-ID and reports the reconnect", async () => {
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
    expect(urls[0]).toBe("/events?token=sess");
    expect(calls[0]?.Authorization).toBe("Bearer sess");
    expect(calls[1]?.["Last-Event-ID"]).toBe("42");
    expect(messages[0]).toMatchObject({ event: "item.pressed", id: "42" });
    expect(onReconnect).toHaveBeenCalled();
  });
});
