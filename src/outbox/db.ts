import Dexie, { type Table } from "dexie";
import type {
  PackOrderInput,
  QcInput,
  QueueItem,
  ReprintReason,
  ScanInput,
  Station,
} from "../api/types";
import type { ReceivingCommand } from "../stations/receiving/commands";

export type OutboxCommand =
  | { kind: "scan"; input: ScanInput }
  | { kind: "qc"; input: QcInput }
  | { kind: "assignBin"; code: string; orderId: string }
  | { kind: "releaseBin"; code: string }
  | { kind: "reprint"; orderItemId: string; reason: ReprintReason; note: string | null }
  | { kind: "packOrder"; input: PackOrderInput }
  | ReceivingCommand;

/**
 * `parked`: set aside for a lead (see `ParkReason`); it never blocks later entries.
 * `failed` is the pre-parking name for a rejected entry and is read exactly like `parked`.
 */
export type OutboxStatus = "pending" | "done" | "parked" | "failed";

/**
 * Why an entry was parked:
 * - `rejected`: the server refused it (a 4xx other than 408/429).
 * - `gave_up`: 5 attempts in a row hit a 5xx, 408, 429 or a timeout.
 * - `blocked`: a scan saved offline came back BLOCKED from the server.
 * - `session`: the staff member's sign-in ended before it was sent. It resumes when the same
 *   person signs in on the same station, or a lead sends it under their own name.
 * - `station_forgotten`: the station was forgotten with this entry unsent. It is never sent.
 */
export type ParkReason = "rejected" | "gave_up" | "blocked" | "session" | "station_forgotten";

/** What the entry was about, in shop words, captured from the cached queue when it was made. */
export type OutboxUnit = {
  orderNo: string | null;
  design: string | null;
  blank: string | null;
  bin: string | null;
};

export type OutboxEntry = {
  /** Insertion order; replay follows it strictly. */
  seq?: number;
  /** Idempotency key. For scans it is the `clientScanId` the server de-duplicates on. */
  id: string;
  command: OutboxCommand;
  /** The floor session that made the change, so a replay is attributed to the right person. */
  sessionToken: string;
  staffName: string;
  /** Who and where; missing on entries saved before parking existed (read as unknown). */
  staffId?: string | null;
  stationId?: string | null;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /** Machine-readable error (oRPC code, or the mismatch reason for a BLOCKED replay). */
  errorCode?: string | null;
  /** Read `undefined` (rows from before parking) the same as `null`. */
  parkedAt?: string | null;
  parkReason?: ParkReason | null;
  unit?: OutboxUnit | null;
  /** It couldn't be sent when it was made, so a later server rejection must raise an alert. */
  replay?: boolean;
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
