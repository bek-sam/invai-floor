import { MAX_DOWNLOAD_URLS } from "@invai/contracts";
import { cn } from "@invai/ui";
import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiFailure } from "../api/errors";
import type { FloorApi } from "../api/types";
import { useApp } from "../app/store";

type CacheEntry = { url: string; expiresAtMs: number };

/** Signed URLs are good for a while (the backend's `files.downloadUrl` TTL); drop a cached one
 * this long before it actually expires, so nothing hands out a URL that's about to stop working
 * mid-render (T-P3-2: "cached URLs are dropped before their signed expiry"). */
const EXPIRY_MARGIN_MS = 30_000;

const urlCache = new Map<string, CacheEntry>();
/** Concurrent lookups for the same key (several thumbnails of the same design mounting
 * together) share one request instead of each signing separately (T-P3-2, B-237). */
const inFlight = new Map<string, Promise<CacheEntry>>();

function cached(key: string): string | null {
  const hit = urlCache.get(key);
  if (!hit) return null;
  if (hit.expiresAtMs - EXPIRY_MARGIN_MS <= Date.now()) {
    urlCache.delete(key);
    return null;
  }
  return hit.url;
}

type Deferred = { resolve: (e: CacheEntry) => void; reject: (err: unknown) => void };
type Group = { api: FloorApi; waiting: Map<string, Deferred> };

/** Keys queued this tick, per session token. They are flushed in a microtask: one React commit
 * runs all its effects in one task, so every thumbnail of a screen lands in the same flush, and
 * (unlike a timer) it never fights fake timers (T-38-3, B-362). */
const queued = new Map<string, Group>();
let flushScheduled = false;
/** Set once an older backend answers the batch route with NOT_FOUND; singles until reload. */
let batchUnsupported = false;

/** Test hook: forget caches, queued work and the "no batch route" flag. */
export function resetThumbnailState() {
  urlCache.clear();
  inFlight.clear();
  queued.clear();
  flushScheduled = false;
  batchUnsupported = false;
}

function toEntry(r: { url: string; expiresAt: string }): CacheEntry {
  const entry: CacheEntry = { url: r.url, expiresAtMs: Date.parse(r.expiresAt) };
  return entry;
}

async function single(api: FloorApi, token: string, key: string, d: Deferred) {
  try {
    d.resolve(toEntry(await api.fileUrl(token, key)));
  } catch (err) {
    d.reject(err);
  }
}

async function sendChunk(
  api: FloorApi,
  token: string,
  keys: string[],
  waiting: Map<string, Deferred>,
) {
  const def = (k: string) => waiting.get(k) as Deferred;
  if (batchUnsupported) {
    for (const k of keys) void single(api, token, k, def(k));
    return;
  }
  let items: Awaited<ReturnType<FloorApi["fileUrls"]>>;
  try {
    items = await api.fileUrls(token, keys);
  } catch (err) {
    // Only an old backend (unknown route -> NOT_FOUND) falls back. A 429, a network error or a
    // 5xx fails these thumbnails as before: it must not fan out into N single calls.
    if (err instanceof ApiFailure && err.code === "NOT_FOUND") {
      batchUnsupported = true;
      for (const k of keys) void single(api, token, k, def(k));
      return;
    }
    for (const k of keys) def(k).reject(err);
    return;
  }
  // Results are matched to keys by position AND fileKey. Anything off -> the whole batch fails;
  // a thumbnail must never show another key's artwork.
  const aligned =
    Array.isArray(items) &&
    items.length === keys.length &&
    items.every((it, i) => it === null || it.fileKey === keys[i]);
  if (!aligned) {
    const err = new Error("downloadUrls result does not match the requested keys");
    for (const k of keys) def(k).reject(err);
    return;
  }
  keys.forEach((k, i) => {
    const it = items[i];
    if (it) def(k).resolve(toEntry(it));
    else def(k).reject(new Error("no download url"));
  });
}

function flush() {
  flushScheduled = false;
  const groups = [...queued];
  queued.clear();
  for (const [token, { api, waiting }] of groups) {
    const all = [...waiting.keys()];
    for (let i = 0; i < all.length; i += MAX_DOWNLOAD_URLS) {
      void sendChunk(api, token, all.slice(i, i + MAX_DOWNLOAD_URLS), waiting);
    }
  }
}

function load(api: FloorApi, token: string, key: string): Promise<CacheEntry> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  let deferred!: Deferred;
  const raw = new Promise<CacheEntry>((resolve, reject) => {
    deferred = { resolve, reject };
  });
  // A failed lookup is never cached (by either map): `finally` drops it from `inFlight`, and
  // only a resolved entry reaches `urlCache.set`.
  const p = raw
    .then((entry) => {
      urlCache.set(key, entry);
      return entry;
    })
    .finally(() => inFlight.delete(key));
  // Registered when queued, not when sent, so a mount after dispatch joins it.
  inFlight.set(key, p);
  let group = queued.get(token);
  if (!group) {
    group = { api, waiting: new Map() };
    queued.set(token, group);
  }
  group.waiting.set(key, deferred);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
  return p;
}

/** Design artwork preview from an S3 key via files.downloadUrls (batched, cached for the session). */
export function Thumbnail({
  fileKey,
  className,
  alt,
}: {
  fileKey: string | null;
  className?: string;
  alt: string;
}) {
  const api = useApp((s) => s.api);
  const token = useApp((s) => s.session?.sessionToken ?? null);
  const [url, setUrl] = useState<string | null>(fileKey ? cached(fileKey) : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!fileKey || !token) return setUrl(null);
    const hit = cached(fileKey);
    if (hit) return setUrl(hit);
    let cancelled = false;
    load(api, token, fileKey)
      .then((entry) => {
        if (!cancelled) setUrl(entry.url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [api, token, fileKey]);

  const box = cn("flex items-center justify-center overflow-hidden rounded-xl bg-muted", className);
  if (!url || failed) {
    return (
      <div className={box}>
        <ImageOff className="size-10 text-muted-foreground" aria-hidden />
      </div>
    );
  }
  return (
    <div className={box}>
      <img
        src={url}
        alt={alt}
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
