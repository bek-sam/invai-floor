import { create } from "zustand";
import type { ApiFailure, FailureKind } from "../api/errors";
import { type FloorDB, floorDb, type OutboxCommand, type OutboxEntry, type OutboxUnit } from "./db";
import {
  type CommandSender,
  type CurrentSession,
  type EntryAuthor,
  enqueue,
  flushOutbox,
  getEntry,
  isParked,
  parkedCount,
  pendingCount,
} from "./outbox";

export type SyncState = {
  /** Browser connectivity AND the last request reaching the API. */
  online: boolean;
  pending: number;
  /** Parked entries waiting for a lead. With `pending`, the unresolved count on the badge. */
  parked: number;
  lastFailure: { kind: FailureKind; code: string; message: string } | null;
  lastSyncAt: string | null;
  /** Entries saved offline that the server later refused; shown until someone taps OK. */
  alerts: OutboxEntry[];
  /** The problems sheet (opened from the sync badge or the alert). */
  sheetOpen: boolean;
};

export const useSyncStore = create<SyncState>(() => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  pending: 0,
  parked: 0,
  lastFailure: null,
  lastSyncAt: null,
  alerts: [],
  sheetOpen: false,
}));

export function dismissAlerts() {
  useSyncStore.setState({ alerts: [] });
}

export function setProblemsOpen(open: boolean) {
  useSyncStore.setState({ sheetOpen: open });
}

export type SubmitOutcome =
  | { status: "sent"; entry: OutboxEntry; result: unknown }
  | { status: "queued"; entry: OutboxEntry; reason: ApiFailure | null }
  | { status: "failed"; entry: OutboxEntry; message: string };

type EngineOptions = {
  send: CommandSender;
  currentSession: () => CurrentSession | null;
  onAuthExpired?: () => void;
  /** Entries saved offline that the server refused on replay (parked by this flush). */
  onReplayRejected?: (entries: OutboxEntry[]) => void;
  /** Anything reached the server (for refreshing station queues). */
  onSent?: () => void;
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

  /** Stops the retry timer (tests, teardown). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Enqueue, then try to send right away. Resolves with the server result when it got through. */
  async submit(
    command: OutboxCommand,
    author: EntryAuthor,
    unit: OutboxUnit | null = null,
  ): Promise<SubmitOutcome> {
    const entry = await enqueue(command, author, this.db, unit);
    await this.refreshCounts();
    await this.flush();
    // Read and flag in one transaction, so a timer flush can't send it in between unflagged.
    const after = await this.db.transaction("rw", this.db.outbox, async () => {
      const e = (await getEntry(entry.id, this.db)) ?? entry;
      if (e.status === "pending" && !e.replay && e.seq !== undefined) {
        await this.db.outbox.update(e.seq, { replay: true });
        return { ...e, replay: true };
      }
      return e;
    });
    if (after.status === "done") return { status: "sent", entry: after, result: after.result };
    if (isParked(after))
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
    const report = await flushOutbox(this.opts.send, {
      db: this.db,
      currentSession: this.opts.currentSession,
    });
    this.lastStop = report.stoppedBy;
    const stop = report.stoppedBy;
    const reachable = !stop || (stop.kind !== "offline" && stop.kind !== "unavailable");
    useSyncStore.setState({
      online: reachable && (typeof navigator === "undefined" || navigator.onLine),
      lastFailure: stop ? { kind: stop.kind, code: stop.code, message: stop.message } : null,
      ...(report.sent > 0 ? { lastSyncAt: new Date().toISOString() } : {}),
    });
    // Only the signed-in person's own sign-in ending locks the tablet; an older one doesn't.
    const current = this.opts.currentSession()?.token ?? null;
    const mineEnded = report.parked.some(
      (e) => e.parkReason === "session" && current !== null && e.sessionToken === current,
    );
    if (mineEnded) this.opts.onAuthExpired?.();
    await this.refreshCounts();

    // Only a server verdict on the unit ("set it aside") alerts. An ended sign-in or a server
    // that never answered (gave_up) is listed in the problems sheet, not alerted: overload is
    // not an error.
    const rejected = report.parked.filter(
      (e) => e.replay && (e.parkReason === "rejected" || e.parkReason === "blocked"),
    );
    if (rejected.length > 0) {
      useSyncStore.setState((s) => ({ alerts: [...s.alerts, ...rejected] }));
      this.opts.onReplayRejected?.(rejected);
    }
    if (report.sent > 0 || report.parked.length > 0) this.opts.onSent?.();
    this.schedule(stop?.retryable ?? false);
  }

  private schedule(retrying: boolean) {
    if (this.timer) clearTimeout(this.timer);
    const delay = retrying ? this.backoffMs : 15_000;
    this.backoffMs = retrying ? Math.min(this.backoffMs * 2, 60_000) : 3_000;
    this.timer = setTimeout(this.kick, delay);
  }

  async refreshCounts() {
    const [pending, parked] = await Promise.all([pendingCount(this.db), parkedCount(this.db)]);
    useSyncStore.setState({ pending, parked });
  }
}
