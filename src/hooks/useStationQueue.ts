import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, toFailure } from "../api/errors";
import type { QueueItem, Station } from "../api/types";
import { onAuthFailure } from "../app/actions";
import { useApp } from "../app/store";
import { floorDb } from "../outbox/db";

/** The first invalidation after a quiet spell loads this long after it (a burst shares one load). */
export const QUIET_DELAY_MS = 400;
/** At most one realtime-driven load per window; an invalidation inside it loads at the window's end. */
export const LOAD_WINDOW_MS = 10_000;

/**
 * Why a queue is being invalidated. `reconnect` (the live link came back, events may be missed)
 * loads at once; the others are throttled so a busy shop's scan bursts stay inside the read limit.
 */
export type InvalidateReason = "realtime" | "own" | "reconnect";

type Listener = {
  invalidate: (reason: InvalidateReason) => void;
  remove: (ids: Set<string>) => void;
};
const listeners = new Set<Listener>();

/** Realtime events and local writes call this; every mounted queue reloads (throttled). */
export function invalidateQueues(opts: { reason?: InvalidateReason } = {}) {
  const reason = opts.reason ?? "realtime";
  for (const l of listeners) l.invalidate(reason);
}

/**
 * This tablet's own scan was confirmed by the server and moved these items on: drop them from every
 * mounted list and the IndexedDB copy now, without a read. The throttled load reconciles later.
 */
export function removeFromQueues(orderItemIds: Array<string | null | undefined>) {
  const ids = new Set(orderItemIds.filter((i): i is string => !!i));
  if (ids.size === 0) return;
  for (const l of listeners) l.remove(ids);
  void floorDb
    .transaction("rw", floorDb.queueCache, async () => {
      for (const row of await floorDb.queueCache.toArray()) {
        const items = row.items.filter((i) => !ids.has(i.orderItemId));
        if (items.length !== row.items.length) await floorDb.queueCache.put({ ...row, items });
      }
    })
    .catch(() => {});
}

export type QueueState = {
  items: QueueItem[];
  counts: { waiting: number; doneToday: number } | null;
  loading: boolean;
  error: ApiFailure | null;
  /** When the list came from IndexedDB because the API was unreachable. */
  cachedAt: string | null;
  refetch: () => void;
};

/** The station queue, served from the IndexedDB copy first so an offline tablet still works. */
export function useStationQueue(station: Station): QueueState {
  const api = useApp((s) => s.api);
  const token = useApp((s) => s.session?.sessionToken ?? null);
  const [state, setState] = useState<Omit<QueueState, "refetch">>({
    items: [],
    counts: null,
    loading: true,
    error: null,
    cachedAt: null,
  });
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoad = useRef<number | null>(null);
  const removed = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!token) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    lastLoad.current = Date.now();
    removed.current = new Set();
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const q = await api.queue(token, station);
      if (n !== seq.current) return;
      // An item this tablet moved on while the read was in flight must not come back.
      const items = q.items.filter((i) => !removed.current.has(i.orderItemId));
      setState({ items, counts: q.counts, loading: false, error: null, cachedAt: null });
      await floorDb.queueCache.put({ station, items, fetchedAt: new Date().toISOString() });
    } catch (err) {
      if (n !== seq.current) return;
      const failure = toFailure(err);
      // 401: the tablet may have been unpaired in InvAI, or the session ended.
      if (failure.kind === "auth") void onAuthFailure();
      const cached = await floorDb.queueCache.get(station);
      setState((s) => ({
        items: cached?.items ?? s.items,
        counts: s.counts,
        loading: false,
        error: failure,
        cachedAt: cached?.fetchedAt ?? null,
      }));
    }
  }, [api, token, station]);

  useEffect(() => {
    let cancelled = false;
    void floorDb.queueCache.get(station).then((cached) => {
      if (!cancelled && cached)
        setState((s) => (s.items.length ? s : { ...s, items: cached.items }));
    });
    void load();
    const listener: Listener = {
      invalidate: (reason) => {
        if (reason === "reconnect") {
          void load();
          return;
        }
        if (timer.current) return; // a load is already scheduled; this event rides on it
        const now = Date.now();
        const last = lastLoad.current;
        const delay =
          last === null || now - last >= LOAD_WINDOW_MS
            ? QUIET_DELAY_MS
            : Math.max(0, last + LOAD_WINDOW_MS - now);
        timer.current = setTimeout(() => void load(), delay);
      },
      remove: (ids) => {
        for (const id of ids) removed.current.add(id);
        setState((s) => {
          const items = s.items.filter((i) => !ids.has(i.orderItemId));
          if (items.length === s.items.length) return s;
          const gone = s.items.length - items.length;
          const counts = s.counts && { ...s.counts, waiting: Math.max(0, s.counts.waiting - gone) };
          return { ...s, items, counts };
        });
      },
    };
    listeners.add(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load, station]);

  return { ...state, refetch: () => void load() };
}

/** Look up a scanned transfer in the queues cached on this tablet (any station). */
export async function findCachedItem(match: (i: QueueItem) => boolean): Promise<QueueItem | null> {
  const rows = await floorDb.queueCache.toArray();
  for (const row of rows) {
    const hit = row.items.find(match);
    if (hit) return hit;
  }
  return null;
}

export async function cachedBlanks(): Promise<QueueItem["blank"][]> {
  const rows = await floorDb.queueCache.toArray();
  const seen = new Map<string, QueueItem["blank"]>();
  for (const row of rows) for (const i of row.items) seen.set(i.blank.variantId, i.blank);
  return [...seen.values()];
}
