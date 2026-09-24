import { create } from "zustand";
import type { ApiFailure, FailureKind } from "../api/errors";
import { type FloorDB, floorDb, type OutboxCommand, type OutboxEntry } from "./db";
import { type CommandSender, enqueue, flushOutbox, getEntry, pendingCount } from "./outbox";

export type SyncState = {
  /** Browser connectivity AND the last request reaching the API. */
  online: boolean;
  pending: number;
  failed: number;
  lastFailure: { kind: FailureKind; code: string; message: string } | null;
  lastSyncAt: string | null;
};

export const useSyncStore = create<SyncState>(() => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  pending: 0,
  failed: 0,
  lastFailure: null,
  lastSyncAt: null,
}));

export type SubmitOutcome =
  | { status: "sent"; entry: OutboxEntry; result: unknown }
  | { status: "queued"; entry: OutboxEntry; reason: ApiFailure | null }
  | { status: "failed"; entry: OutboxEntry; message: string };

type EngineOptions = {
  send: CommandSender;
  currentSessionToken: () => string | null;
  onAuthExpired?: () => void;
  onReplayed?: (entries: OutboxEntry[]) => void;
  db?: FloorDB;
};

/**
 * Owns the outbox flush loop. Flushes run one at a time: on submit, on `online`, on focus,
 * and on a timer that backs off from 3 s to 60 s while the API stays unreachable.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 3_000;
  private readonly db: FloorDB;

  constructor(private readonly opts: EngineOptions) {
    this.db = opts.db ?? floorDb;
  }

  start() {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("focus", this.kick);
    void this.refreshCounts();
    this.kick();
    return () => {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      window.removeEventListener("focus", this.kick);
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /** Enqueue, then try to send right away. Resolves with the server result when it got through. */
  async submit(
    command: OutboxCommand,
    session: { sessionToken: string; staffName: string },
  ): Promise<SubmitOutcome> {
    const entry = await enqueue(command, session, this.db);
    await this.refreshCounts();
    await this.flush();
    const after = (await getEntry(entry.id, this.db)) ?? entry;
    if (after.status === "done") return { status: "sent", entry: after, result: after.result };
    if (after.status === "failed")
      return { status: "failed", entry: after, message: after.lastError ?? "Rejected" };
    return { status: "queued", entry: after, reason: this.lastStop };
  }

  private lastStop: ApiFailure | null = null;

  kick = () => {
    void this.flush();
  };

  private onOnline = () => {
    this.backoffMs = 3_000;
    this.kick();
  };

  private onOffline = () => {
    useSyncStore.setState({ online: false });
  };

  /** Coalesces concurrent calls: at most one flush runs, and one more follows if requested. */
  flush(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.flushOnce();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async flushOnce() {
    const pendingBefore = await this.db.outbox.where("status").equals("pending").toArray();
    const report = await flushOutbox(this.opts.send, {
      db: this.db,
      currentSessionToken: this.opts.currentSessionToken,
    });
    this.lastStop = report.stoppedBy;
    const stop = report.stoppedBy;
    const reachable = !stop || (stop.kind !== "offline" && stop.kind !== "unavailable");
    useSyncStore.setState({
      online: reachable && (typeof navigator === "undefined" || navigator.onLine),
      lastFailure: stop ? { kind: stop.kind, code: stop.code, message: stop.message } : null,
      ...(report.sent > 0 ? { lastSyncAt: new Date().toISOString() } : {}),
    });
    if (stop?.kind === "auth") this.opts.onAuthExpired?.();
    await this.refreshCounts();

    if (report.sent > 0 && this.opts.onReplayed) {
      const ids = new Set(pendingBefore.map((e) => e.id));
      const done = await this.db.outbox.where("status").anyOf("done", "failed").toArray();
      this.opts.onReplayed(done.filter((e) => ids.has(e.id)));
    }
    this.schedule(stop?.retryable ?? false);
  }

  private schedule(retrying: boolean) {
    if (this.timer) clearTimeout(this.timer);
    const delay = retrying ? this.backoffMs : 15_000;
    this.backoffMs = retrying ? Math.min(this.backoffMs * 2, 60_000) : 3_000;
    this.timer = setTimeout(this.kick, delay);
  }

  async refreshCounts() {
    const [pending, failed] = await Promise.all([
      pendingCount(this.db),
      this.db.outbox.where("status").equals("failed").count(),
    ]);
    useSyncStore.setState({ pending, failed });
  }
}
