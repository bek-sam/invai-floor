import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, toFailure } from "../../api/errors";
import { useApp } from "../../app/store";
import { kvGet, kvSet } from "../../outbox/db";

type Cached<T> = { items: T[]; fetchedAt: string };

export type CachedList<T> = {
  items: T[];
  loading: boolean;
  error: ApiFailure | null;
  /** Set when `items` came from this tablet's saved copy because the server couldn't be reached. */
  cachedAt: string | null;
  loaded: boolean;
  refetch: () => void;
  /** Local edit (after a receipt saved offline, for example); also updates the saved copy. */
  update: (fn: (items: T[]) => T[]) => void;
};

/**
 * A server list that keeps working offline: the last good copy is saved on the tablet per
 * station/company and shown, marked as saved, when the server can't be reached.
 */
export function useCachedList<T>(
  name: string,
  load: (token: string) => Promise<T[]>,
): CachedList<T> {
  const token = useApp((s) => s.session?.sessionToken ?? null);
  const station = useApp((s) => s.station);
  const key = `receiving:${station?.demo ? "demo" : (station?.token ?? "none")}:${name}`;
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const request = useRef(0);

  const run = useCallback(async () => {
    if (!token) return;
    const mine = ++request.current;
    const current = () => mine === request.current;
    setLoading(true);
    try {
      const fresh = await loadRef.current(token);
      if (!current()) return;
      setItems(fresh);
      setError(null);
      setCachedAt(null);
      setLoaded(true);
      await kvSet(key, { items: fresh, fetchedAt: new Date().toISOString() } as Cached<T>);
    } catch (err) {
      if (!current()) return;
      setError(toFailure(err));
      const saved = await kvGet<Cached<T>>(key);
      if (!current()) return;
      if (saved) {
        setItems(saved.items);
        setCachedAt(saved.fetchedAt);
        setLoaded(true);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [token, key]);

  useEffect(() => {
    void run();
  }, [run]);

  const update = useCallback(
    (fn: (items: T[]) => T[]) => {
      setItems((cur) => {
        const next = fn(cur);
        void kvSet(key, { items: next, fetchedAt: new Date().toISOString() } as Cached<T>);
        return next;
      });
    },
    [key],
  );

  const refetch = useCallback(() => void run(), [run]);
  return { items, loading, error, cachedAt, loaded, refetch, update };
}
