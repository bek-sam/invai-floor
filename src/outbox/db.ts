import type { Station } from "@invai/contracts";
import Dexie, { type Table } from "dexie";

export type QueuedScan = {
  clientScanId: string; // idempotency key: the server ignores replays
  station: Station;
  code: string;
  scannedAt: string;
  synced: 0 | 1;
};

class FloorDB extends Dexie {
  scans!: Table<QueuedScan, string>;
  constructor() {
    super("invai-floor");
    this.version(1).stores({ scans: "clientScanId, synced, scannedAt" });
  }
}

export const floorDb = new FloorDB();

export async function queueScan(scan: { station: Station; code: string }) {
  await floorDb.scans.add({
    ...scan,
    clientScanId: crypto.randomUUID(),
    scannedAt: new Date().toISOString(),
    synced: 0,
  });
}
