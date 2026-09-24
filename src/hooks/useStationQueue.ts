import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, toFailure } from "../api/errors";
import type { QueueItem, Station } from "../api/types";
import { useApp } from "../app/store";
import { floorDb } from "../outbox/db";

type Listener = () => void;
const listeners = new Set<Listener>();

/** Realtime events and local writes call this; every mounted queue refetches (debounced). */
export function invalidateQueues() {
  for (const l of listeners) l();
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

  const load = useCallback(async () => {
    if (!token) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const q = await api.queue(token, station);
      if (n !== seq.current) return;
      setState({ items: q.items, counts: q.counts, loading: false, error: null, cachedAt: null });
      await floorDb.queueCache.put({
        station,
        items: q.items,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (n !== seq.current) return;
      const cached = await floorDb.queueCache.get(station);
      setState((s) => ({
        items: cached?.items ?? s.items,
        counts: s.counts,
        loading: false,
        error: toFailure(err),
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
    const onInvalidate = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 400);
    };
    listeners.add(onInvalidate);
    return () => {
      cancelled = true;
      listeners.delete(onInvalidate);
      if (timer.current) clearTimeout(timer.current);
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
