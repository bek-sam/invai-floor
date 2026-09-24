import { floorDb } from "./db";

/** Flush queued scans on reconnect, on focus and every few seconds. No Background Sync API (Chromium-only). */
export function startOutboxSync(intervalMs = 5_000) {
  const flush = async () => {
    if (!navigator.onLine) return;
    const pending = await floorDb.scans.where("synced").equals(0).sortBy("scannedAt");
    for (const scan of pending) {
      // TODO: call the typed oRPC client: production.scan(scan)
      await floorDb.scans.update(scan.clientScanId, { synced: 1 });
    }
  };
  window.addEventListener("online", flush);
  window.addEventListener("focus", flush);
  setInterval(flush, intervalMs);
}
