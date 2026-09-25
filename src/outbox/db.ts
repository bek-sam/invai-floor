import Dexie, { type Table } from "dexie";
import type { QcInput, QueueItem, ReprintReason, ScanInput, Station } from "../api/types";
import type { ReceivingCommand } from "../stations/receiving/commands";

export type OutboxCommand =
  | { kind: "scan"; input: ScanInput }
  | { kind: "qc"; input: QcInput }
  | { kind: "assignBin"; code: string; orderId: string }
  | { kind: "releaseBin"; code: string }
  | { kind: "reprint"; orderItemId: string; reason: ReprintReason; note: string | null }
  | ReceivingCommand;

export type OutboxStatus = "pending" | "done" | "failed";

export type OutboxEntry = {
  /** Insertion order; replay follows it strictly. */
  seq?: number;
  /** Idempotency key. For scans it is the `clientScanId` the server de-duplicates on. */
  id: string;
  command: OutboxCommand;
  /** The floor session that made the change, so a replay is attributed to the right person. */
  sessionToken: string;
  staffName: string;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /** Server response once sent (the ScanResult for scans). */
  result: unknown;
  sentAt: string | null;
};

export type KvRow = { key: string; value: unknown };
export type StaffPref = { userId: string; name: string; lang: "en" | "es"; lastLoginAt: string };
export type QueueCacheRow = { station: Station; items: QueueItem[]; fetchedAt: string };

export class FloorDB extends Dexie {
  outbox!: Table<OutboxEntry, number>;
  kv!: Table<KvRow, string>;
  staffPrefs!: Table<StaffPref, string>;
  queueCache!: Table<QueueCacheRow, Station>;

  constructor(name = "invai-floor") {
    super(name);
    this.version(2).stores({
      scans: null, // v1 scaffold table, replaced by `outbox`
      outbox: "++seq, &id, status",
      kv: "key",
      staffPrefs: "userId, lastLoginAt",
      queueCache: "station",
    });
  }
}

export const floorDb = new FloorDB();

export async function kvGet<T>(key: string, db: FloorDB = floorDb): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown, db: FloorDB = floorDb) {
  await db.kv.put({ key, value });
}

export async function kvDelete(key: string, db: FloorDB = floorDb) {
  await db.kv.delete(key);
}
