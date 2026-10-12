import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  describeFound,
  dumpIfAsked,
  type Found,
  fixedEntries,
  type Lang,
  loadBaseline,
  scan,
  unbaselined,
} from "./a11y-core";
import { client, OWNER_PIN, ownerClient, PRESSER_PIN } from "./helpers/api";
import { envUrl } from "./helpers/env-url";

/**
 * Axe (wcag2a, wcag2aa, wcag21aa) on the tablet screens in English and Spanish: pair this tablet,
 * PIN, choose a station and the press station. Fails on any serious or critical violation not in
 * a11y-baseline.json (see a11y-core.ts). The device language is the `invai-floor:lang`
 * localStorage key, set before the page loads. Each run pairs its own fresh "any station" tablet.
 */
const LANGS: Lang[] = ["en", "es"];
type Mode = "light" | "dark";
// The floor has no theme switch: @invai/ui theme.css follows `prefers-color-scheme` when the
// page sets no explicit light/dark class, so the dark run emulates it with `colorScheme`.
const DARK_BACKGROUND = /^oklch\(0\.17 0\.01 260\)$/;
const found: Found[] = [];
const scanned = new Set<string>();

test.describe.configure({ mode: "serial" });

// Every tablet context a test opens is closed after it. A paired tablet left open stays signed in
// on its station and refetches its queue on every live update, all on Desert Bloom's per-company
// `reads` budget, while offline.spec and press.spec run (gate 429, wave 36).
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close();
});

/**
 * The queue rows are seed- and state-dependent (row number, a state class that comes and goes), so
 * the full axe path differs between runs. A baseline entry keys on the offending element only:
 * its last compound selector, without `:nth-child` positions.
 */
function stableTarget(target: string) {
  const last = target.split(" > ").pop() ?? target;
  return last.replace(/:nth-child\(\d+\)/g, "");
}

async function check(page: Page, baseRoute: string, lang: Lang, mode: Mode) {
  const route = mode === "dark" ? `${baseRoute} [dark]` : baseRoute;
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  if (mode === "dark") {
    // The run must really be dark, or the scan would repeat the light one.
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
      true,
    );
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
    );
    expect(bg, "--color-background is the dark token").toMatch(DARK_BACKGROUND);
  }
  for (const f of await scan(page, route, lang))
    found.push({ ...f, target: stableTarget(f.target) });
  scanned.add(`${route}|${lang}`);
}

async function modePage(browser: Browser, mode: Mode) {
  const context = await browser.newContext({
    baseURL: envUrl("E2E_FLOOR_URL", "http://localhost:5174"),
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    colorScheme: mode,
  });
  opened.push(context);
  return context.newPage();
}

for (const mode of ["light", "dark"] as Mode[])
  for (const lang of LANGS) {
    test(`pair, PIN, station choice and press screens have no new serious violations (${lang}, ${mode})`, async ({
      browser,
    }) => {
      const page = await modePage(browser, mode);
      const owner = await ownerClient();
      const location = (await owner.locations.list({})).items[0];
      const device = await owner.stations.create({
        name: `E2E a11y ${lang} ${mode} ${Date.now() % 100_000}`,
        locationId: location?.id as string,
        kind: null,
      });
      const token = (await owner.stations.issueToken({ id: device.id })).token;
      // Make sure the PIN is valid for this station before the UI uses it.
      await client(`Station ${token}`).floor.login({ pin: OWNER_PIN });

      await page.addInitScript((l) => localStorage.setItem("invai-floor:lang", l), lang);
      await page.goto("/?dev=1");
      await expect(page.locator("#station-token")).toBeVisible();
      await check(page, "pair", lang, mode);

      await page.locator("#station-token").fill(token);
      await page.getByRole("button", { name: /^(Connect station|Conectar estación)$/ }).click();
      await expect(
        page.getByRole("heading", { name: /^(Enter your PIN|Ingresa tu PIN)$/ }),
      ).toBeVisible();
      await check(page, "pin", lang, mode);

      for (const d of PRESSER_PIN) await page.getByRole("button", { name: d, exact: true }).click();
      await page.getByRole("button", { name: /^(Confirm|Confirmar)$/ }).click();
      await expect(page.getByText(/^(Choose a station|Elige una estación)$/)).toBeVisible();
      await check(page, "station-choice", lang, mode);

      await page.getByRole("button", { name: /^(Press|Prensar)$/ }).click();
      await expect(
        page.getByText(/^(Scan the transfer QR|Escanea el QR de la transferencia)$/),
      ).toBeVisible();
      await check(page, "station-press", lang, mode);

      // The BLOCKED result screen: an unknown transfer is blocked by the server.
      await page.getByRole("button", { name: /^(Simulate scan|Simular escaneo)$/ }).click();
      await page.getByTestId("simulate-scan").fill("T:00000000-0000-4000-8000-000000000000");
      await page.getByRole("button", { name: /^(Scan|Escanear)$/, exact: true }).click();
      await page.getByTestId("simulate-scan").fill("B:00000000-0000-4000-8000-000000000001");
      await page.getByRole("button", { name: /^(Scan|Escanear)$/, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await check(page, "result-blocked", lang, mode);
      await expect(page.locator("[role=alert][data-tone]")).toHaveAttribute("data-tone", "blocked");

      // The PRESS (green) result screen: a real queued transfer plus its right blank. A multi-unit
      // order is preferred so press.spec.ts keeps its single-unit orders.
      const login = await client(`Station ${token}`).floor.login({ pin: OWNER_PIN });
      const floor = client(`Bearer ${login.sessionToken}`);
      const queue = await floor.production.queue({ station: "press", limit: 100 });
      let next: (typeof queue.items)[number] | undefined;
      for (const i of queue.items) {
        if (!i.transferId || !i.blank.variantId) continue;
        const order = await floor.orders.get({ id: i.orderId });
        if (order.items.filter((u) => u.state !== "cancelled").length > 1) {
          next = i;
          break;
        }
      }
      expect(next, "a multi-unit order is waiting at the press").toBeTruthy();
      await page.getByTestId("simulate-scan").fill(`T:${next?.transferId}`);
      await page.getByRole("button", { name: /^(Scan|Escanear)$/, exact: true }).click();
      await page.getByTestId("simulate-scan").fill(`B:${next?.blank.variantId}`);
      await page.getByRole("button", { name: /^(Scan|Escanear)$/, exact: true }).click();
      const pressed = page.locator("[role=alert][data-tone]");
      await expect(pressed).toHaveAttribute("data-tone", "ok");
      await expect(pressed).toContainText(/PRESS|PRENSAR/);
      await check(page, "result-press", lang, mode);

      // QC, Pack and Pick through the station menu (the result screen has no list of its own).
      const stations: [string, RegExp, RegExp][] = [
        [
          "station-qc",
          /^(Quality check|Control de calidad)$/,
          /Scan the pressed shirt|Escanea el código de la transferencia/,
        ],
        ["station-pack", /^(Pack|Empacar)$/, /Scan a tote or an item|Escanea una caja o una pieza/],
        [
          "station-pick",
          /^(Pick|Recoger)$/,
          /Scan a blank label|Escanea la etiqueta de una prenda/,
        ],
      ];
      for (const [route, menuName, ready] of stations) {
        await page.getByRole("button", { name: /^(Settings|Ajustes)$/ }).click();
        await page.getByRole("menuitem", { name: menuName }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(page.getByText(ready).first()).toBeVisible();
        await check(page, route, lang, mode);
      }
    });
  }

test("serious accessibility violations are all baselined, and the baseline holds no fixed entry", () => {
  dumpIfAsked(found);
  const baseline = loadBaseline();
  const fresh = unbaselined(found, baseline);
  const fixed = fixedEntries(found, baseline, scanned);
  expect(
    fresh,
    `New serious/critical violations (fix them, or ask for a baseline entry with a B-id):\n${describeFound(fresh)}`,
  ).toEqual([]);
  expect(
    fixed,
    `remove fixed baseline entry:\n${fixed.map((b) => `  - ${b.rule} ${b.route} ${b.target} (${b.backlog})`).join("\n")}`,
  ).toEqual([]);
});
