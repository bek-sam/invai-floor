import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloorApi, FloorSession, QueueItem } from "../api/types";
import { useApp } from "../app/store";
import { floorDb } from "../outbox/db";
import {
  invalidateQueues,
  LOAD_WINDOW_MS,
  QUIET_DELAY_MS,
  removeFromQueues,
  useStationQueue,
} from "./useStationQueue";

// T-57-4 (A4.1/A4.2): realtime bursts cost at most one queue read per 10 s window per tablet,
// never starve, and the tablet's own confirmed scan removes the item with no read.

const item = (id: string) => ({ orderItemId: id, transferId: `t-${id}` }) as unknown as QueueItem;

let queue: ReturnType<typeof vi.fn>;

function setup() {
  queue = vi.fn(async () => ({
    station: "press",
    items: [item("a"), item("b")],
    nextCursor: null,
    counts: { waiting: 2, doneToday: 0 },
  }));
  useApp.setState({
    api: { kind: "rpc", queue } as unknown as FloorApi,
    session: { sessionToken: "tok" } as unknown as FloorSession,
  });
  return renderHook(() => useStationQueue("press"));
}

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await floorDb.queueCache.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useStationQueue throttle", () => {
  it("mount loads at once", async () => {
    setup();
    await settle();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("5 events in 400 ms after a quiet spell cost 1 load, 400 ms after the first", async () => {
    setup();
    await settle();
    await advance(LOAD_WINDOW_MS);
    for (let i = 0; i < 5; i++) {
      invalidateQueues();
      await advance(80);
    }
    await advance(QUIET_DELAY_MS);
    expect(queue).toHaveBeenCalledTimes(2);
    await advance(LOAD_WINDOW_MS - 1000);
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it("events every 150 ms for 60 s load 6-7 times, never 0 (no starvation)", async () => {
    setup();
    await settle();
    for (let t = 0; t < 60_000; t += 150) {
      invalidateQueues();
      await advance(150);
    }
    expect(queue.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(queue.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("an event inside the window loads at lastLoad + W, not before", async () => {
    setup();
    await settle(); // load at t=0
    await advance(3000);
    invalidateQueues();
    await advance(LOAD_WINDOW_MS - 3000 - 1);
    expect(queue).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it("a reconnect loads at once and restarts the window", async () => {
    setup();
    await settle();
    await advance(2000);
    invalidateQueues({ reason: "reconnect" });
    await settle();
    expect(queue).toHaveBeenCalledTimes(2);
    invalidateQueues();
    await advance(LOAD_WINDOW_MS - 1);
    expect(queue).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it("refetch loads at once", async () => {
    const { result } = setup();
    await settle();
    act(() => result.current.refetch());
    await settle();
    expect(queue).toHaveBeenCalledTimes(2);
  });
});

describe("useStationQueue own scan", () => {
  it("removes a confirmed item from the list and the cache with no extra read", async () => {
    const { result } = setup();
    await settle();
    expect(result.current.items.map((i) => i.orderItemId)).toEqual(["a", "b"]);
    await floorDb.queueCache.put({
      station: "press",
      items: [item("a"), item("b")],
      fetchedAt: "x",
    });
    act(() => removeFromQueues(["a"]));
    expect(result.current.items.map((i) => i.orderItemId)).toEqual(["b"]);
    expect(result.current.counts?.waiting).toBe(1);
    await act(async () => {
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));
    });
    const row = await floorDb.queueCache.get("press");
    expect(row?.items.map((i) => i.orderItemId)).toEqual(["b"]);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("a read that was already in flight cannot bring the item back", async () => {
    const { result } = setup();
    await settle();
    let release: (v: unknown) => void = () => {};
    queue.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    act(() => result.current.refetch());
    act(() => removeFromQueues(["a"]));
    await act(async () => {
      release({ station: "press", items: [item("a"), item("b")], nextCursor: null, counts: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items.map((i) => i.orderItemId)).toEqual(["b"]);
  });
});
