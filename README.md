# invai-floor

The production-floor app for 10-inch tablets (Android/Chromebook in kiosk mode recommended) with USB or Bluetooth barcode scanners.

- **Stations:** pick, press, QC, pack. Big buttons (`size="floor"` from `@invai/ui`), English/Spanish.
- **Scanning:** `src/scanner/useWedgeScanner.ts` detects scanner bursts. Camera fallback via `barcode-detector` (todo).
- **Offline:** every scan goes into an IndexedDB outbox (Dexie) with a client-generated ID, then syncs. The server de-duplicates by that ID, so replays are safe.
- **Live updates:** Server-Sent Events from `invai-backend` (`/events`).
- Installable PWA (vite-plugin-pwa), landscape, fullscreen.

```
cp .env.example .env
pnpm install
pnpm dev          # http://localhost:5174
```
