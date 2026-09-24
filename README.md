# invai-floor

The production-floor PWA for 10-inch landscape tablets with USB/Bluetooth keyboard-wedge scanners. English and Spanish.

```
cp .env.example .env
pnpm install
pnpm dev          # http://localhost:5174 (proxies /rpc and /events to :3000)
pnpm dev --open "/?demo=1"   # built-in demo backend, no server needed
```

- **Setup:** scan the station QR from the web app (JSON `{token, station, kind, company}`, a URL with `?token=`, `STATION:<token>` or the bare token). Stored in IndexedDB.
- **Login:** 4–6 digit PIN → floor session (`floor.login`). Auto-lock after inactivity (default 10 min, menu → Auto-lock). Language is remembered per staff member.
- **Stations:** pick (grouped by blank, tote assignment), press (transfer QR → blank/tote → PRESS/BLOCKED), QC (pass / fail with reason → reprint), pack (progress, missing-item warning, label).
- **Scanning:** `src/scanner/wedge.ts` tells scanner bursts from typing; a scan's Enter is swallowed so it can't click a focused button. Codes: `T:<transferId>`, `B:<blankVariantId>` or UPC, `BIN:<code>`.
- **Offline:** every write goes to the Dexie outbox first (`src/outbox`), is sent in order and replayed on reconnect. Scans carry a `clientScanId`, so replays are idempotent. Offline press checks run against the cached queue and are marked provisional.
- **Realtime:** fetch-based SSE on `/events?token=<floor session>` with backoff and `Last-Event-ID`.
- **Dev:** the scan icon (bottom right, `pnpm dev` or `?dev=1`) simulates a scan. `?demo=1` or "Try a demo station" uses the in-memory backend in `src/api/demo.ts` (PINs 1111, 1122 … 1177).

```
pnpm typecheck && pnpm lint && pnpm test   # unit tests (Vitest)
pnpm e2e                                   # Playwright, against a running stack
```
