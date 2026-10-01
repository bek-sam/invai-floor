import { expect, type Page, test } from "@playwright/test";
import { client, ownerClient, PRESSER_PIN } from "./helpers/api";

const OWNER_PIN = "1111";

/**
 * The offline queue never jams: the press tablet loses Wi-Fi, three units are pressed (checked
 * on the tablet), the office puts one order on hold meanwhile, and the tablet reconnects. Two
 * scans sync, the held one comes back BLOCKED and is parked with a red alert naming the order,
 * and the next scan still goes straight through.
 */
test("offline scans replay in order; a server-rejected one is parked and alerted", async ({
  page,
  context,
}) => {
  const owner = await ownerClient();
  const location = (await owner.locations.list({})).items[0];
  const device = await owner.stations.create({
    name: `E2E offline ${Date.now() % 10_000}`,
    locationId: location?.id as string,
    kind: "press",
  });
  const token = (await owner.stations.issueToken({ id: device.id })).token;
  const login = await client(`Station ${token}`).floor.login({ pin: OWNER_PIN });
  const floor = client(`Bearer ${login.sessionToken}`);

  // Four press-ready units; the held one is on an order of its own. Units from multi-unit
  // orders go first, so the single-unit order press.spec needs is left alone when possible.
  const queue = await floor.production.queue({ station: "press", limit: 200 });
  const ready = queue.items.filter((i) => i.transferId && i.state === "transfer_in");
  const perOrder = new Map<string, number>();
  for (const i of ready) perOrder.set(i.orderId, (perOrder.get(i.orderId) ?? 0) + 1);
  const pool = [...ready].sort(
    (x, y) =>
      Number((perOrder.get(y.orderId) ?? 0) > 1) - Number((perOrder.get(x.orderId) ?? 0) > 1),
  );
  const held = pool[0];
  const others = pool.filter((u) => u.orderId !== held?.orderId).slice(0, 3);
  expect(held && others.length === 3, "four press-ready units on two or more orders").toBeTruthy();
  const [a, c, later] = others as [
    (typeof ready)[number],
    (typeof ready)[number],
    (typeof ready)[number],
  ];
  if (!held) return;

  await page.goto("/?dev=1");
  await page.locator("#station-token").fill(token);
  await page.getByRole("button", { name: "Connect station" }).click();
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible();
  for (const d of PRESSER_PIN) await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Scan the transfer QR")).toBeVisible();
  await waitForCachedQueue(
    page,
    [a, held, c].map((u) => u.transferId as string),
  );

  const scan = async (code: string) => {
    const box = page.getByTestId("simulate-scan");
    if (!(await box.count())) await page.getByRole("button", { name: "Simulate scan" }).click();
    await page.getByTestId("simulate-scan").fill(code);
    await page.getByRole("button", { name: "Scan", exact: true }).click();
  };
  const press = async (u: typeof a) => {
    await scan(`T:${u.transferId}`);
    await expect(page.getByText("Now scan the blank or tote label")).toBeVisible();
    await scan(`B:${u.blank.variantId}`);
  };

  // Wi-Fi drops. Three units are checked on the tablet and saved.
  await context.setOffline(true);
  for (const u of [a, held, c]) {
    await press(u);
    await expect(page.getByText("Checked on this tablet while offline")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("sync-pending")).toContainText("3 scans waiting to sync");

  // Meanwhile the office puts the second unit's order on hold.
  await owner.orders.hold({ id: held.orderId, reason: "buyer_request", note: null });

  // Back online: the queue replays in order.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  const alert = page.getByTestId("replay-alert");
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText("1 queued scan was rejected");
  await expect(alert).toContainText(`Order ${held.orderNo}`);
  await expect(alert).toContainText("Order on hold");
  await expect(page.getByTestId("sync-parked")).toContainText("1 needs a check");
  await expect(page.getByTestId("sync-pending")).toHaveCount(0);

  // 2 synced, 1 parked: the server agrees.
  const state = async (id: string) => (await floor.orderItems.get({ id })).state;
  expect(await state(a.orderItemId)).toBe("pressed");
  expect(await state(c.orderItemId)).toBe("pressed");
  expect(await state(held.orderItemId)).toBe("on_hold"); // not pressed

  // The parked scan is listed with what, who and why.
  await alert.getByRole("button", { name: "See the list" }).click();
  const sheet = page.getByTestId("problems-sheet");
  await expect(sheet).toBeVisible();
  const rows = sheet.getByTestId("problem-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-status", "parked");
  await expect(rows.first()).toContainText(`Order ${held.orderNo}`);
  await expect(rows.first()).toContainText("Order on hold");
  await expect(rows.first()).toContainText("By ");
  await sheet.getByRole("button", { name: "Close" }).click();

  // Nothing jams: the next scan goes straight to the server and gets a live PRESS.
  await press(later);
  const result = page.locator("[role=alert][data-tone]");
  await expect(result).toHaveAttribute("data-tone", "ok");
  await expect(result).toContainText("PRESS");
  await expect(page.getByText("Checked on this tablet while offline")).toHaveCount(0);
  expect(await state(later.orderItemId)).toBe("pressed");

  await owner.orders.release({ id: held.orderId });
});

/** The press queue is saved to IndexedDB before the network drops, so offline checks work. */
async function waitForCachedQueue(page: Page, transferIds: string[]) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (ids) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open("invai-floor");
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                try {
                  const req = open.result
                    .transaction("queueCache")
                    .objectStore("queueCache")
                    .get("press");
                  req.onsuccess = () => {
                    const items = (req.result?.items ?? []) as { transferId: string | null }[];
                    const have = new Set(items.map((i) => i.transferId));
                    resolve(ids.every((id) => have.has(id)));
                  };
                  req.onerror = () => resolve(false);
                } catch {
                  resolve(false);
                }
              };
            }),
          transferIds,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}
