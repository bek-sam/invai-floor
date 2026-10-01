import { CONTRACT_VERSION, compareContractVersions } from "@invai/contracts";
import { type ApiFailure, toFailure } from "../api/errors";
import { uuid } from "../lib/uuid";
import {
  type FloorDB,
  floorDb,
  type OutboxCommand,
  type OutboxEntry,
  type OutboxUnit,
  type ParkReason,
} from "./db";

/** Sends one command to the server with the given floor session token. */
export type CommandSender = (command: OutboxCommand, sessionToken: string) => Promise<unknown>;

/** The signed-in person, for re-sending their own entries after they sign in again. */
export type CurrentSession = { token: string; userId: string; stationId: string };

/** Who made an entry. `staffId`/`stationId` bind it to one person on one station. */
export type EntryAuthor = {
  sessionToken: string;
  staffName: string;
  staffId: string | null;
  stationId: string | null;
};

export type FlushReport = {
  sent: number;
  /** Entries parked by this flush (rejected, gave up, blocked on replay, sign-in ended). */
  parked: OutboxEntry[];
  /** Why the flush stopped early, leaving entries pending. */
  stoppedBy: ApiFailure | null;
  /**
   * Scans that got a real server verdict this flush (sent, or parked as `blocked`), carrying
   * the `ScanResult`. A screen showing a provisional or busy view for one of these can replace
   * it with the real one (T-P3-2: a busy retry's answer must still reach the press panel).
   */
  resolved: OutboxEntry[];
};

/** A 5xx, 408, 429 or timeout is retried with backoff this many times, then parked. */
export const MAX_ATTEMPTS = 5;

/** Sent entries stay just long enough for `submit()` to read the result, then are pruned. */
const KEEP_DONE_MS = 60 * 1000;

export function commandId(command: OutboxCommand): string {
  if (command.kind === "scan") return command.input.clientScanId;
  if (command.kind === "packOrder") return command.input.idempotencyKey;
  return uuid();
}

/** Parked and the older `failed` status both mean "needs a lead". */
export function isParked(entry: Pick<OutboxEntry, "status">): boolean {
  return entry.status === "parked" || entry.status === "failed";
}

/** Rows saved before parking existed have no reason; they were server rejections. */
export function parkReasonOf(entry: OutboxEntry): ParkReason {
  return entry.parkReason ?? "rejected";
}

/**
 * Writes a command to IndexedDB first. It is only sent from here, by `flushOutbox`, so an
 * online send and an offline replay go through exactly the same path.
 */
export async function enqueue(
  command: OutboxCommand,
  author: Pick<EntryAuthor, "sessionToken" | "staffName"> & Partial<EntryAuthor>,
  db: FloorDB = floorDb,
  unit: OutboxUnit | null = null,
  contractVersion: string = CONTRACT_VERSION,
): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: commandId(command),
    command,
    sessionToken: author.sessionToken,
    staffName: author.staffName,
    staffId: author.staffId ?? null,
    stationId: author.stationId ?? null,
    createdAt: new Date().toISOString(),
    contractVersion,
    status: "pending",
    attempts: 0,
    lastError: null,
    errorCode: null,
    parkedAt: null,
    parkReason: null,
    unit,
    replay: false,
    result: null,
    sentAt: null,
  };
  // The unique `id` index makes a second enqueue of the same clientScanId a no-op.
  const existing = await db.outbox.where("id").equals(entry.id).first();
  if (existing) return existing;
  entry.seq = await db.outbox.add(entry);
  return entry;
}

/** A timeout means the server is slow on this request, not that the tablet is offline. */
function countsAsAttempt(failure: ApiFailure): boolean {
  return failure.kind === "unavailable" || failure.code === "TIMEOUT";
}

/**
 * Replays pending commands strictly in insertion order.
 * - Offline (no network): stop, keep everything pending, don't count an attempt.
 * - 5xx, 408, NOT_IMPLEMENTED or a timeout: stop and retry later with backoff; after
 *   `MAX_ATTEMPTS` in a row the entry is parked and the flush moves on.
 * - 429 RATE_LIMITED (`busy`): stop, keep everything pending, don't count an attempt. The caller
 *   retries using the server's `retryAfterSec`, not the outage backoff, and this never parks as
 *   `gave_up` (T-P3-2): overload is not an error.
 * - Any other 4xx: parked at once, and the flush moves on.
 * - Sign-in ended (401): re-sent only under the same person's new session on the same
 *   station; otherwise parked. Never sent as whoever is signed in now.
 * - A replayed scan the server BLOCKED is parked so a lead sees it.
 * - Saved under an older app version and refused (any 4xx): parked as `stale_version` (lead
 *   alert), not `rejected`. If the server still accepts the old shape, it is simply sent.
 * - CLIENT_TOO_OLD (this app is too old): stop, keep everything pending, don't count an attempt.
 *   The tablet shows "Update needed"; the new version sends them.
 *
 * Idempotency is the server's job: a scan replayed with the same clientScanId returns its
 * original result, so a crash between "sent" and "marked done" is harmless.
 */
export async function flushOutbox(
  send: CommandSender,
  opts: {
    db?: FloorDB;
    currentSession?: () => CurrentSession | null;
    /** The running app's contract version (tests override it). */
    appVersion?: string;
  } = {},
): Promise<FlushReport> {
  const db = opts.db ?? floorDb;
  const appVersion = opts.appVersion ?? CONTRACT_VERSION;
  const report: FlushReport = { sent: 0, parked: [], stoppedBy: null, resolved: [] };
  const pending = await db.outbox.where("status").equals("pending").sortBy("seq");

  const park = async (entry: OutboxEntry, reason: ParkReason, changes: Partial<OutboxEntry>) => {
    const parked: Partial<OutboxEntry> = {
      ...changes,
      status: "parked",
      parkReason: reason,
      parkedAt: new Date().toISOString(),
    };
    await db.outbox.update(entry.seq as number, parked);
    report.parked.push({ ...entry, ...parked });
  };

  for (const entry of pending) {
    const seq = entry.seq as number;
    try {
      const { result, token } = await sendAsAuthor(send, entry, opts.currentSession?.() ?? null);
      const sent: Partial<OutboxEntry> = {
        result,
        sentAt: new Date().toISOString(),
        attempts: entry.attempts + 1,
        lastError: null,
        errorCode: null,
        ...(token !== entry.sessionToken ? { sessionToken: token } : {}),
      };
      const blocked = blockedReason(entry, result);
      if (blocked) {
        await park(entry, "blocked", { ...sent, errorCode: blocked, lastError: blocked });
        if (entry.command.kind === "scan")
          report.resolved.push(report.parked.at(-1) as OutboxEntry);
      } else {
        await db.outbox.update(seq, { ...sent, status: "done" });
        report.sent++;
        if (entry.command.kind === "scan")
          report.resolved.push({ ...entry, ...sent, status: "done" });
      }
    } catch (err) {
      const failure = toFailure(err);
      const failed = {
        attempts: entry.attempts + 1,
        lastError: failure.message,
        errorCode: failure.code,
      };
      if (failure.kind === "rejected") {
        if (isAlreadyApplied(entry.command, failure)) {
          // A QC/bin replay the server already applied: the end state is what we wanted.
          await db.outbox.update(seq, {
            status: "done",
            sentAt: new Date().toISOString(),
            errorCode: failure.code,
          });
          report.sent++;
        } else if (isStaleVersion(entry, appVersion)) {
          await park(entry, "stale_version", failed);
        } else {
          await park(entry, "rejected", failed);
        }
        continue;
      }
      if (failure.kind === "auth") {
        await park(entry, "session", failed);
        continue;
      }
      if (countsAsAttempt(failure)) {
        if (failed.attempts >= MAX_ATTEMPTS) {
          await park(entry, "gave_up", failed);
          continue;
        }
        await db.outbox.update(seq, failed);
      }
      report.stoppedBy = failure;
      break;
    }
  }
  await pruneDone(db);
  return report;
}

/** Saved under an older contract version than the running app (or before versions existed). */
export function isStaleVersion(
  entry: Pick<OutboxEntry, "contractVersion">,
  appVersion: string = CONTRACT_VERSION,
): boolean {
  return compareContractVersions(entry.contractVersion ?? null, appVersion) < 0;
}

/** A scan or "Mark packed" saved offline that the server blocked on replay is parked. */
function blockedReason(entry: OutboxEntry, result: unknown): string | null {
  if (!entry.replay) return null;
  if (entry.command.kind === "packOrder") {
    // "Mark packed" saved offline, and the server found units missing: a lead must see it.
    const p = result as { packed?: unknown; override?: unknown } | null;
    return p?.packed === false && !p.override ? "pack_incomplete" : null;
  }
  if (entry.command.kind !== "scan") return null;
  const r = result as { ok?: unknown; mismatch?: unknown } | null;
  if (r?.ok !== false) return null;
  return typeof r.mismatch === "string" ? r.mismatch : "unknown";
}

async function sendAsAuthor(
  send: CommandSender,
  entry: OutboxEntry,
  current: CurrentSession | null,
): Promise<{ result: unknown; token: string }> {
  try {
    return { result: await send(entry.command, entry.sessionToken), token: entry.sessionToken };
  } catch (err) {
    const failure = toFailure(err);
    if (failure.kind === "auth" && current && current.token !== entry.sessionToken) {
      if (sameAuthor(entry, current)) {
        return { result: await send(entry.command, current.token), token: current.token };
      }
    }
    throw failure;
  }
}

/** The same person on the same station. Entries without both ids never match anyone. */
export function sameAuthor(
  entry: Pick<OutboxEntry, "staffId" | "stationId">,
  current: Pick<CurrentSession, "userId" | "stationId">,
): boolean {
  return (
    !!entry.staffId &&
    !!entry.stationId &&
    entry.staffId === current.userId &&
    entry.stationId === current.stationId
  );
}

/** Non-scan commands have no idempotency key, so a replayed QC pass may hit "already packed". */
function isAlreadyApplied(command: OutboxCommand, failure: ApiFailure): boolean {
  // packOrder has a real key: a CONFLICT (on hold, key reused) is a real refusal.
  if (command.kind === "scan" || command.kind === "packOrder") return false;
  return failure.code === "INVALID_TRANSITION" || failure.code === "CONFLICT";
}

async function pruneDone(db: FloorDB) {
  await db.outbox
    .where("status")
    .equals("done")
    .and((e) => e.sentAt === null || Date.now() - Date.parse(e.sentAt) > KEEP_DONE_MS)
    .delete();
}

export async function pendingCount(db: FloorDB = floorDb): Promise<number> {
  return db.outbox.where("status").equals("pending").count();
}

export async function parkedCount(db: FloorDB = floorDb): Promise<number> {
  return db.outbox.where("status").anyOf("parked", "failed").count();
}

export async function getEntry(id: string, db: FloorDB = floorDb) {
  return db.outbox.where("id").equals(id).first();
}

/** Pending and parked entries, oldest first: the problems list. */
export async function unresolvedEntries(db: FloorDB = floorDb): Promise<OutboxEntry[]> {
  return db.outbox.where("status").anyOf("pending", "parked", "failed").sortBy("seq");
}

/** Whether a lead may put a parked entry back in the queue, as it is (same author). */
export function canRetry(entry: OutboxEntry, current: CurrentSession | null): boolean {
  if (!isParked(entry)) return false;
  const reason = parkReasonOf(entry);
  if (reason === "blocked" || reason === "station_forgotten" || reason === "session") return false;
  // Entries from another station keep their own session, but only that station replays them.
  return !entry.stationId || !current || entry.stationId === current.stationId;
}

/** A lead may send an entry whose author's sign-in ended under their own name, same station. */
export function canSendAsMe(entry: OutboxEntry, current: CurrentSession | null): boolean {
  return (
    isParked(entry) &&
    parkReasonOf(entry) === "session" &&
    !!current &&
    !!entry.stationId &&
    entry.stationId === current.stationId
  );
}

const unpark: Partial<OutboxEntry> = {
  status: "pending",
  attempts: 0,
  parkedAt: null,
  parkReason: null,
  lastError: null,
  errorCode: null,
};

/** Put parked entries back in the queue, unchanged. Returns how many went back. */
export async function retryParked(
  ids: string[],
  current: CurrentSession | null,
  db: FloorDB = floorDb,
): Promise<number> {
  let n = 0;
  await db.transaction("rw", db.outbox, async () => {
    for (const id of ids) {
      const e = await db.outbox.where("id").equals(id).first();
      if (!e || !canRetry(e, current)) continue;
      await db.outbox.update(e.seq as number, unpark);
      n++;
    }
  });
  return n;
}

/**
 * A lead confirms an entry whose author's sign-in ended: it is sent under the lead's session
 * and recorded as theirs, explicitly, never silently as whoever is signed in.
 */
export async function sendAsMe(
  id: string,
  current: CurrentSession & { staffName: string },
  db: FloorDB = floorDb,
): Promise<boolean> {
  return db.transaction("rw", db.outbox, async () => {
    const e = await db.outbox.where("id").equals(id).first();
    if (!e || !canSendAsMe(e, current)) return false;
    await db.outbox.update(e.seq as number, {
      ...unpark,
      sessionToken: current.token,
      staffId: current.userId,
      staffName: current.staffName,
    });
    return true;
  });
}

/** When someone signs in, their own entries parked for an ended sign-in go back in the queue. */
export async function resumeOwnEntries(
  current: CurrentSession,
  db: FloorDB = floorDb,
): Promise<number> {
  return db.transaction("rw", db.outbox, async () => {
    const parked = await db.outbox.where("status").anyOf("parked", "failed").toArray();
    let n = 0;
    for (const e of parked) {
      if (parkReasonOf(e) !== "session" || !sameAuthor(e, current)) continue;
      await db.outbox.update(e.seq as number, { ...unpark, sessionToken: current.token });
      n++;
    }
    return n;
  });
}

/** Removes a parked entry for good (a lead decided it should not be sent). */
export async function discardEntry(id: string, db: FloorDB = floorDb): Promise<boolean> {
  return db.transaction("rw", db.outbox, async () => {
    const e = await db.outbox.where("id").equals(id).first();
    if (!e || !isParked(e)) return false;
    await db.outbox.delete(e.seq as number);
    return true;
  });
}

/**
 * Forgetting a station: every unsent entry is parked as `station_forgotten`, so it is never
 * replayed under the next station. It stays visible until a lead discards it.
 */
export async function parkForForgottenStation(db: FloorDB = floorDb): Promise<number> {
  const at = new Date().toISOString();
  return db.outbox
    .where("status")
    .equals("pending")
    .modify({ status: "parked", parkReason: "station_forgotten", parkedAt: at });
}
