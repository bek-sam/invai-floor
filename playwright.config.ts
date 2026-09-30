import { defineConfig, devices } from "@playwright/test";

/**
 * Tablet E2E against the real stack: api :3000, worker, imaging :8000, floor :5174 and a seeded
 * dev database (`pnpm db:seed` in invai-backend writes the station token to seed-output.json).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  // Both paths must sit outside invai-floor/, not just under e2e/: the live :5174 Vite dev server
  // this suite runs against watches the whole project tree (no server.watch.ignored) and force
  // full-page-reloads every open tab when Playwright writes trace/report files mid-run, the same
  // reload-storm mechanism found in invai-web (A1 gate step 6, invai-docs/waves/A1/reports/
  // gate-step6-qa.md). "../.e2e-out/invai-floor" resolves next to invai-floor/, never inside it.
  reporter: [["list"], ["html", { open: "never", outputFolder: "../.e2e-out/invai-floor/report" }]],
  outputDir: "../.e2e-out/invai-floor/results",
  use: {
    baseURL: process.env.E2E_FLOOR_URL ?? "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "tablet", use: { ...devices["Desktop Chrome"], hasTouch: true } }],
});
