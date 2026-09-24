import { cn } from "@invai/ui";
import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";

const urlCache = new Map<string, string>();

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
  const [url, setUrl] = useState<string | null>(fileKey ? (urlCache.get(fileKey) ?? null) : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!fileKey || !token) return setUrl(null);
    const hit = urlCache.get(fileKey);
    if (hit) return setUrl(hit);
    let cancelled = false;
    api
      .fileUrl(token, fileKey)
      .then((u) => {
        urlCache.set(fileKey, u);
        if (!cancelled) setUrl(u);
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
