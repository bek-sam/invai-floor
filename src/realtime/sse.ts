export type SseMessage = { event: string; data: string; id: string | null };
export type SseStatus = "connecting" | "open" | "closed";

/** Incremental text/event-stream parser (WHATWG rules: fields, comments, blank-line dispatch). */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private id: string | null = null;
  lastEventId: string | null = null;

  constructor(private readonly onMessage: (m: SseMessage) => void) {}

  push(chunk: string) {
    this.buf += chunk;
    let nl = this.buf.search(/\r\n|\r|\n/);
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line);
      nl = this.buf.search(/\r\n|\r|\n/);
    }
  }

  private line(line: string) {
    if (line === "") {
      if (this.data.length) {
        if (this.id !== null) this.lastEventId = this.id;
        this.onMessage({ event: this.event || "message", data: this.data.join("\n"), id: this.id });
      }
      this.event = "";
      this.data = [];
      this.id = null;
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
}

export type SseOptions = {
  url: string;
  /** Called on every (re)connect so a refreshed floor session token is picked up. */
  token: () => string | null;
  onMessage: (m: SseMessage) => void;
  onStatus?: (s: SseStatus) => void;
  /** Called after a reconnect: events may have been missed, so refetch. */
  onReconnect?: () => void;
  fetchImpl?: typeof fetch;
  minDelayMs?: number;
  maxDelayMs?: number;
};

/**
 * Server-Sent Events over fetch (not EventSource) so reconnects are ours and every retry can
 * send `Last-Event-ID`. The floor session goes in `?token=`, which the backend's /events
 * accepts; it's also sent as `Authorization: Bearer` for servers that prefer the header.
 * Reconnects with exponential backoff and jitter.
 */
export function connectSse(opts: SseOptions): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const minDelay = opts.minDelayMs ?? 1_000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let lastEventId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connectedOnce = false;

  const run = async () => {
    if (stopped) return;
    opts.onStatus?.("connecting");
    controller = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    const token = opts.token();
    let url = opts.url;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    try {
      const res = await fetchImpl(url, {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      attempt = 0;
      opts.onStatus?.("open");
      if (connectedOnce) opts.onReconnect?.();
      connectedOnce = true;
      const parser = new SseParser((m) => {
        if (m.id) lastEventId = m.id;
        opts.onMessage(m);
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // fall through to reconnect
    }
    if (stopped) return;
    opts.onStatus?.("closed");
    const delay = Math.min(maxDelay, minDelay * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt++;
    timer = setTimeout(run, delay);
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
