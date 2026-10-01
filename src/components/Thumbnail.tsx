import { cn } from "@invai/ui";
import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { FloorApi } from "../api/types";
import { useApp } from "../app/store";

type CacheEntry = { url: string; expiresAtMs: number };

/** Signed URLs are good for a while (the backend's `files.downloadUrl` TTL); drop a cached one
 * this long before it actually expires, so nothing hands out a URL that's about to stop working
 * mid-render (T-P3-2: "cached URLs are dropped before their signed expiry"). */
const EXPIRY_MARGIN_MS = 30_000;

const urlCache = new Map<string, CacheEntry>();
/** Concurrent lookups for the same key (several thumbnails of the same design mounting
 * together) share one request instead of each calling `files.downloadUrl` (T-P3-2, B-237). */
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

function load(api: FloorApi, token: string, key: string): Promise<CacheEntry> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = api
    .fileUrl(token, key)
    .then((r) => {
      const entry: CacheEntry = { url: r.url, expiresAtMs: Date.parse(r.expiresAt) };
      urlCache.set(key, entry);
      return entry;
    })
    .finally(() => inFlight.delete(key));
  // A failed lookup is never cached (by either map): the `finally` above already dropped it
  // from `inFlight`, and a rejected promise never reaches `urlCache.set`.
  inFlight.set(key, p);
  return p;
}

/** Design artwork preview from an S3 key via files.downloadUrl (cached for the session). */
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
