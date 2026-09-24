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
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "e2e/.results",
  use: {
    baseURL: process.env.E2E_FLOOR_URL ?? "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "tablet", use: { ...devices["Desktop Chrome"], hasTouch: true } }],
});
