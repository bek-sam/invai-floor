import { expect, type Page, test } from "@playwright/test";
import { client, OWNER_PIN, ownerClient } from "./helpers/api";

type Floor = ReturnType<typeof client>;
type Unit = Awaited<ReturnType<Floor["production"]["queue"]>>["items"][number];

/**
 * Pack station, T-4-4: "Mark packed" asks the server (production.packOrder). A unit that isn't
 * packed yet blocks it and is listed; once that unit passes QC, "Check again" packs the order.
 *
 * The server's pack list only holds orders whose units are all packed, so a short order reaches
 * the tablet only through a list that went stale. The test makes that happen on purpose: it
 * adds the order to the tablet's pack list while one unit still waits at QC.
 */
test("pack: a missing unit blocks Mark packed, then the order packs", async ({ page }) => {
  const owner = await ownerClient();
  const location = (await owner.locations.list({})).items[0];
  const device = await owner.stations.create({
    name: `E2E pack ${Date.now() % 10_000}`,
    locationId: location?.id as string,
    kind: null,
  });
  const token = (await owner.stations.issueToken({ id: device.id })).token;
  const login = await client(`Station ${token}`).floor.login({ pin: OWNER_PIN });
  const floor = client(`Bearer ${login.sessionToken}`);

  const units = await twoUnitOrderAtQc(floor);
  const [first, last] = [units[0] as Unit, units[units.length - 1] as Unit];
  for (const u of units.slice(0, -1)) {
    await floor.production.qc({ orderItemId: u.orderItemId, result: "pass" });
  }

  // The stale list: this order, with its last unit still at QC.
  let stale = true;
  await page.route("**/rpc/production/queue", async (route) => {
    const body = route.request().postData() ?? "";
    if (!stale || !body.includes('"pack"')) return route.continue();
    const res = await route.fetch();
    const out = (await res.json()) as { json: { items: Unit[] } };
    out.json.items.push(
      ...units.map((u) => ({ ...u, state: u === last ? "pressed" : "packed" }) as Unit),
    );
    return route.fulfill({ response: res, json: out });
  });

  await page.goto("/?dev=1");
  await page.locator("#station-token").fill(token);
  await page.getByRole("button", { name: "Connect station" }).click();
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible();
  for (const d of OWNER_PIN) await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Pack", exact: true }).click();
  await expect(page.getByText("Scan a tote or an item to start an order")).toBeVisible();

  await scan(page, `T:${first.transferId}`);
  await expect(page.getByTestId("pack-progress")).toContainText(`1 of ${units.length}`);
  await page.getByRole("button", { name: "Mark packed" }).click();

  // Blocked, with the missing unit and its state.
  const panel = page.locator("[role=alert][data-tone=blocked]");
  await expect(panel).toContainText("NOT READY TO PACK");
  await expect(page.getByTestId("pack-missing")).toContainText(last.design.name);
  await expect(page.getByTestId("pack-missing")).toContainText("Pressed");
  await expect(page.getByRole("button", { name: "Hand to lead" })).toBeVisible(); // owner
  let order = await floor.orders.get({ id: first.orderId });
  expect(order.items.find((i) => i.id === last.orderItemId)?.state).toBe("pressed");

  // Progress survives a reload.
  stale = false;
  await page.reload();
  await expect(page.getByText("Picked up where you left off")).toBeVisible();
  await expect(page.getByTestId("pack-progress")).toContainText(`1 of ${units.length}`);

  // The last unit passes QC; checking again packs the order.
  await floor.production.qc({ orderItemId: last.orderItemId, result: "pass" });
  await page.getByRole("button", { name: "Mark packed" }).click();
  await expect(page.getByText(`Order ${first.orderNo} packed`)).toBeVisible();
  order = await floor.orders.get({ id: first.orderId });
  expect(order.status).toBe("ready_to_ship");
  expect(order.items.every((i) => i.state === "packed" || i.state === "cancelled")).toBe(true);

  // Finished: nothing is left to resume.
  await page.getByRole("button", { name: "Next" }).click();
  await page.reload();
  await expect(page.getByText("Scan a tote or an item to start an order")).toBeVisible();
  await expect(page.getByText("Picked up where you left off")).toHaveCount(0);
});

async function scan(page: Page, code: string) {
  const box = page.getByTestId("simulate-scan");
  if (!(await box.count())) await page.getByRole("button", { name: "Simulate scan" }).click();
  await page.getByTestId("simulate-scan").fill(code);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
}

/** An order with 2+ units, every open unit pressed and waiting at QC; presses some if needed. */
async function twoUnitOrderAtQc(floor: Floor): Promise<Unit[]> {
  const ready = async (orderId: string, atQc: Unit[]) => {
    const order = await floor.orders.get({ id: orderId });
    const open = order.items.filter((i) => i.state !== "cancelled");
    return open.length >= 2 && open.every((i) => atQc.some((u) => u.orderItemId === i.id));
  };
  const qc = (await floor.production.queue({ station: "qc", limit: 200 })).items;
  for (const orderId of new Set(qc.map((u) => u.orderId))) {
    const atQc = qc.filter((u) => u.orderId === orderId);
    if (await ready(orderId, atQc)) return atQc;
  }
  // None at QC: press every unit of a two-or-more-unit order waiting at the press.
  const press = (await floor.production.queue({ station: "press", limit: 200 })).items;
  for (const orderId of new Set(press.map((u) => u.orderId))) {
    const atPress = press.filter((u) => u.orderId === orderId && u.transferId);
    if (!(await ready(orderId, atPress))) continue;
    for (const u of atPress) {
      const r = await floor.production.scan({
        clientScanId: crypto.randomUUID(),
        station: "press",
        transferCode: `T:${u.transferId}`,
        blankCode: `B:${u.blank.variantId}`,
        scannedAt: new Date().toISOString(),
      });
      expect(r.ok, r.message).toBe(true);
    }
    return (await floor.production.queue({ station: "qc", limit: 200 })).items.filter(
      (u) => u.orderId === orderId,
    );
  }
  throw new Error("No order with two or more units at the press or QC");
}
