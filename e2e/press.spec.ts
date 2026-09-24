import { expect, test } from "@playwright/test";
import { client, OWNER_PIN, ownerClient, PRESSER_PIN } from "./helpers/api";

/**
 * The tablet: pair with the station token, PIN login, press station scan check (wrong size is
 * BLOCKED, the right blank is PRESS), then QC pass and pack through the station menu.
 * Scans are simulated through the dev scan box, which feeds the same scanner bus as a wedge.
 */
test("station setup, PIN login, press scan check, QC pass and pack", async ({ page }) => {
  // The seeded "Press 1" token is pinned to the press; pair an "any station" tablet so one
  // login can move press -> QC -> pack through the station menu.
  const owner = await ownerClient();
  const location = (await owner.locations.list({})).items[0];
  const device = await owner.stations.create({
    name: `E2E tablet ${Date.now() % 10_000}`,
    locationId: location?.id as string,
    kind: null,
  });
  const token = (await owner.stations.issueToken({ id: device.id })).token;
  const station = client(`Station ${token}`);
  // Lookups run as the owner's floor session (a presser has no catalog.read); the tablet UI
  // below logs in as the presser.
  const login = await station.floor.login({ pin: OWNER_PIN });
  const floor = client(`Bearer ${login.sessionToken}`);
  const queue = await floor.production.queue({ station: "press", limit: 100 });
  // A single-unit order, so the pack station can complete it after one press + QC.
  let next: (typeof queue.items)[number] | undefined;
  for (const i of queue.items) {
    if (!i.transferId || !i.blank.variantId) continue;
    const order = await floor.orders.get({ id: i.orderId });
    if (order.items.filter((u) => u.state !== "cancelled").length === 1) {
      next = i;
      break;
    }
  }
  expect(next, "a single-unit transfer_in order is waiting at the press").toBeTruthy();
  const mine = await floor.blanks.get({ id: next?.blank.variantId as string });
  const sameStyle = await floor.blanks.list({
    styleCode: mine.styleCode,
    colorCode: mine.colorCode,
    limit: 20,
  });
  const wrongSize = sameStyle.items.find((b) => b.sizeCode !== mine.sizeCode);
  const otherStyle = (await floor.blanks.list({ limit: 200 })).items.find(
    (b) => b.styleCode !== mine.styleCode,
  );
  expect(wrongSize && otherStyle).toBeTruthy();

  await page.goto("/?dev=1");
  await page.locator("#station-token").fill(token);
  await page.getByRole("button", { name: "Connect station" }).click();
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible();
  for (const d of PRESSER_PIN) await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Choose a station")).toBeVisible();
  await page.getByRole("button", { name: "Press", exact: true }).click();
  await expect(page.getByText("Scan the transfer QR")).toBeVisible();

  const scan = async (code: string) => {
    const box = page.getByTestId("simulate-scan");
    if (!(await box.count())) await page.getByRole("button", { name: "Simulate scan" }).click();
    await page.getByTestId("simulate-scan").fill(code);
    await page.getByRole("button", { name: "Scan", exact: true }).click();
  };

  await scan(`T:${next?.transferId}`);
  await expect(page.getByText("Now scan the blank or tote label")).toBeVisible();
  const result = page.locator("[role=alert][data-tone]");
  await scan(`B:${otherStyle?.id}`);
  await expect(result).toHaveAttribute("data-tone", "blocked");
  await expect(result).toContainText("BLOCKED");
  await expect(result).toContainText("Wrong style");
  await scan(`B:${wrongSize?.id}`);
  await expect(result).toContainText("Wrong size");

  await scan(`B:${next?.blank.variantId}`);
  await expect(result).toHaveAttribute("data-tone", "ok");
  await expect(result).toContainText("PRESS");

  // QC: pass the unit just pressed.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Quality check" }).click();
  await expect(page.getByText("Scan the pressed shirt's transfer code")).toBeVisible();
  await scan(`T:${next?.transferId}`);
  await page.getByRole("button", { name: "Pass" }).click();
  await expect(page.getByText(`Passed: order ${next?.orderNo}`)).toBeVisible();

  // Pack: scan the item, mark the order packed.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Pack" }).click();
  await expect(page.getByText("Scan a tote or an item to start an order")).toBeVisible();
  await scan(`T:${next?.transferId}`);
  await expect(page.getByTestId("pack-progress")).toBeVisible();
  await page.getByRole("button", { name: "Mark packed" }).click();
  const anyway = page.getByRole("button", { name: "Pack anyway" });
  if (await anyway.isVisible().catch(() => false)) await anyway.click();
  await expect(page.getByText(`Order ${next?.orderNo} packed`)).toBeVisible();

  const after = await floor.orderItems.get({ id: next?.orderItemId as string });
  expect(after.state).toBe("packed");
});
