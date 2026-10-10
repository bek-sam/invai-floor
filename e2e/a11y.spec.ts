import { expect, type Page, test } from "@playwright/test";
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

/**
 * Axe (wcag2a, wcag2aa, wcag21aa) on the tablet screens in English and Spanish: pair this tablet,
 * PIN, choose a station and the press station. Fails on any serious or critical violation not in
 * a11y-baseline.json (see a11y-core.ts). The device language is the `invai-floor:lang`
 * localStorage key, set before the page loads. Each run pairs its own fresh "any station" tablet.
 */
const LANGS: Lang[] = ["en", "es"];
const found: Found[] = [];
const scanned = new Set<string>();

test.describe.configure({ mode: "serial" });

async function check(page: Page, route: string, lang: Lang) {
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  found.push(...(await scan(page, route, lang)));
  scanned.add(`${route}|${lang}`);
}

for (const lang of LANGS) {
  test(`pair, PIN, station choice and press screens have no new serious violations (${lang})`, async ({
    page,
  }) => {
    const owner = await ownerClient();
    const location = (await owner.locations.list({})).items[0];
    const device = await owner.stations.create({
      name: `E2E a11y ${lang} ${Date.now() % 100_000}`,
      locationId: location?.id as string,
      kind: null,
    });
    const token = (await owner.stations.issueToken({ id: device.id })).token;
    // Make sure the PIN is valid for this station before the UI uses it.
    await client(`Station ${token}`).floor.login({ pin: OWNER_PIN });

    await page.addInitScript((l) => localStorage.setItem("invai-floor:lang", l), lang);
    await page.goto("/?dev=1");
    await expect(page.locator("#station-token")).toBeVisible();
    await check(page, "pair", lang);

    await page.locator("#station-token").fill(token);
    await page.getByRole("button", { name: /^(Connect station|Conectar estación)$/ }).click();
    await expect(
      page.getByRole("heading", { name: /^(Enter your PIN|Ingresa tu PIN)$/ }),
    ).toBeVisible();
    await check(page, "pin", lang);

    for (const d of PRESSER_PIN) await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: /^(Confirm|Confirmar)$/ }).click();
    await expect(page.getByText(/^(Choose a station|Elige una estación)$/)).toBeVisible();
    await check(page, "station-choice", lang);

    await page.getByRole("button", { name: /^(Press|Prensar)$/ }).click();
    await expect(
      page.getByText(/^(Scan the transfer QR|Escanea el QR de la transferencia)$/),
    ).toBeVisible();
    await check(page, "station-press", lang);
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
