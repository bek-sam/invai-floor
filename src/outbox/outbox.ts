import { type ApiFailure, toFailure } from "../api/errors";
import { uuid } from "../lib/uuid";
import { type FloorDB, floorDb, type OutboxCommand, type OutboxEntry } from "./db";

/** Sends one command to the server with the given floor session token. */
export type CommandSender = (command: OutboxCommand, sessionToken: string) => Promise<unknown>;

export type FlushReport = {
  sent: number;
  failed: number;
  /** Why the flush stopped early, leaving entries pending. */
  stoppedBy: ApiFailure | null;
};

/** Keep sent entries around this long for the recent-scan list, then prune. */
const KEEP_DONE_MS = 24 * 60 * 60 * 1000;

export function commandId(command: OutboxCommand): string {
  return command.kind === "scan" ? command.input.clientScanId : uuid();
}

/**
 * Writes a command to IndexedDB first. It is only sent from here, by `flushOutbox`, so an
 * online send and an offline replay go through exactly the same path.
 */
export async function enqueue(
  command: OutboxCommand,
  session: { sessionToken: string; staffName: string },
  db: FloorDB = floorDb,
): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: commandId(command),
    command,
    sessionToken: session.sessionToken,
    staffName: session.staffName,
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    lastError: null,
    result: null,
    sentAt: null,
  };
  // The unique `id` index makes a second enqueue of the same clientScanId a no-op.
  const existing = await db.outbox.where("id").equals(entry.id).first();
  if (existing) return existing;
  entry.seq = await db.outbox.add(entry);
  return entry;
}

/**
 * Replays pending commands strictly in insertion order. A retryable failure (offline, API
 * down, NOT_IMPLEMENTED) stops the flush so later scans never overtake earlier ones. A
 * rejected command is marked failed and the flush moves on. An expired session is retried
 * once with the current session, then stops until someone logs in again.
 *
 * Idempotency is the server's job: a scan replayed with the same clientScanId returns its
 * original result, so a crash between "sent" and "marked done" is harmless.
 */
export async function flushOutbox(
  send: CommandSender,
  opts: { db?: FloorDB; currentSessionToken?: () => string | null } = {},
): Promise<FlushReport> {
  const db = opts.db ?? floorDb;
  const report: FlushReport = { sent: 0, failed: 0, stoppedBy: null };
  const pending = await db.outbox.where("status").equals("pending").sortBy("seq");

  for (const entry of pending) {
    const seq = entry.seq as number;
    try {
      const result = await sendWithFallback(send, entry, opts.currentSessionToken?.() ?? null);
      await db.outbox.update(seq, {
        status: "done",
        result,
        sentAt: new Date().toISOString(),
        attempts: entry.attempts + 1,
        lastError: null,
      });
      report.sent++;
    } catch (err) {
      const failure = toFailure(err);
      if (failure.kind === "rejected" && !isAlreadyApplied(entry.command, failure)) {
        await db.outbox.update(seq, {
          status: "failed",
          attempts: entry.attempts + 1,
          lastError: failure.message,
        });
        report.failed++;
        continue;
      }
      if (failure.kind === "rejected") {
        // A QC/bin replay the server already applied: the end state is what we wanted.
        await db.outbox.update(seq, {
          status: "done",
          sentAt: new Date().toISOString(),
          lastError: failure.code,
        });
        report.sent++;
        continue;
      }
      await db.outbox.update(seq, { attempts: entry.attempts + 1, lastError: failure.message });
      report.stoppedBy = failure;
      break;
    }
  }
  await db.outbox
    .where("status")
    .equals("done")
    .and((e) => e.sentAt !== null && Date.now() - Date.parse(e.sentAt) > KEEP_DONE_MS)
    .delete();
  return report;
}

async function sendWithFallback(send: CommandSender, entry: OutboxEntry, current: string | null) {
  try {
    return await send(entry.command, entry.sessionToken);
  } catch (err) {
    const failure = toFailure(err);
    if (failure.kind === "auth" && current && current !== entry.sessionToken) {
      return await send(entry.command, current);
    }
    throw failure;
  }
}

/** Non-scan commands have no idempotency key, so a replayed QC pass may hit "already packed". */
function isAlreadyApplied(command: OutboxCommand, failure: ApiFailure): boolean {
  if (command.kind === "scan") return false;
  return failure.code === "INVALID_TRANSITION" || failure.code === "CONFLICT";
}

export async function pendingCount(db: FloorDB = floorDb): Promise<number> {
  return db.outbox.where("status").equals("pending").count();
}

export async function getEntry(id: string, db: FloorDB = floorDb) {
  return db.outbox.where("id").equals(id).first();
}
