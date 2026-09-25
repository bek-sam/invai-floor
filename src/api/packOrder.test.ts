import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuid } from "../lib/uuid";
import { FloorDB, type OutboxCommand } from "../outbox/db";
import { enqueue, flushOutbox } from "../outbox/outbox";
import { createDemoApi, DEMO_STATION_TOKEN } from "./demo";
import { ApiFailure } from "./errors";
import { packIncompleteMissing } from "./rpc";
import type { PackOrderResult } from "./types";

const author = { sessionToken: "tok-a", staffName: "Ana" };
const ORDER = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-000000000002";

function pack(key = uuid(), reason?: string): OutboxCommand {
  return {
    kind: "packOrder",
    input: { orderId: ORDER, idempotencyKey: key, ...(reason ? { override: { reason } } : {}) },
  };
}

const short: PackOrderResult = {
  orderId: ORDER,
  packed: false,
  missing: [{ orderItemId: UNIT, state: "pressed" }],
  override: null,
};

describe("packIncompleteMissing (rpc)", () => {
  it("reads missing[] from a PACK_INCOMPLETE refusal", () => {
    const err = { code: "PACK_INCOMPLETE", status: 409, data: { missing: short.missing } };
    expect(packIncompleteMissing(err)).toEqual(short.missing);
  });
  it("leaves every other error alone", () => {
    expect(packIncompleteMissing({ code: "CONFLICT", status: 409 })).toBeNull();
    expect(packIncompleteMissing(new TypeError("fetch failed"))).toBeNull();
  });
});

describe("packOrder through the outbox", () => {
  let db: FloorDB;
  beforeEach(() => {
    db = new FloorDB(`pack-${uuid()}`);
  });
  afterEach(async () => {
    await db.delete();
  });

  it("uses the idempotencyKey as the entry id", async () => {
    const e = await enqueue(pack("key-12345678"), author, db);
    expect(e.id).toBe("key-12345678");
  });

  it("a live refusal is a result, not a parked entry", async () => {
    await enqueue(pack(), author, db);
    const report = await flushOutbox(async () => short, { db });
    expect(report.sent).toBe(1);
    expect(report.parked).toHaveLength(0);
  });

  it("a pack saved offline that replays short is parked for a lead", async () => {
    const e = await enqueue(pack(), author, db);
    await db.outbox.update(e.seq as number, { replay: true });
    const report = await flushOutbox(async () => short, { db });
    expect(report.parked).toHaveLength(1);
    expect(report.parked[0]?.parkReason).toBe("blocked");
    expect(report.parked[0]?.errorCode).toBe("pack_incomplete");
  });

  it("a replayed hand-over or pack is done", async () => {
    const e = await enqueue(pack(uuid(), "Transfer lost"), author, db);
    await db.outbox.update(e.seq as number, { replay: true });
    const handed = { ...short, override: { reason: "Transfer lost" } };
    const report = await flushOutbox(async () => handed, { db });
    expect(report.sent).toBe(1);
  });

  it("a CONFLICT (order on hold) is parked, not counted as already applied", async () => {
    await enqueue(pack(), author, db);
    const report = await flushOutbox(
      async () => {
        throw new ApiFailure("rejected", "CONFLICT", "Order is on hold", 409);
      },
      { db },
    );
    expect(report.sent).toBe(0);
    expect(report.parked[0]?.errorCode).toBe("CONFLICT");
  });
});

describe("demo packOrder", () => {
  async function signIn(pin: string) {
    const api = createDemoApi();
    const s = await api.login(DEMO_STATION_TOKEN, pin);
    return { api, s };
  }

  async function shortOrder(api: Awaited<ReturnType<typeof signIn>>["api"], token: string) {
    const q = await api.queue(token, "pack");
    const orderId = q.items.find((i) => i.orderNo === "#1050")?.orderId as string;
    return orderId;
  }

  it("refuses a short order with missing[] and changes nothing", async () => {
    const { api, s } = await signIn("1166");
    const orderId = await shortOrder(api, s.sessionToken);
    const r = await api.packOrder(s.sessionToken, { orderId, idempotencyKey: uuid() });
    expect(r.packed).toBe(false);
    expect(r.override).toBeNull();
    expect(r.missing.map((m) => m.state)).toEqual(["pressed"]);
  });

  it("lets only owner and admin hand an order to a lead", async () => {
    const packer = await signIn("1166");
    expect(packer.s.permissions).not.toContain("production.override");
    const orderId = await shortOrder(packer.api, packer.s.sessionToken);
    await expect(
      packer.api.packOrder(packer.s.sessionToken, {
        orderId,
        idempotencyKey: uuid(),
        override: { reason: "lost" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const admin = await signIn("1122");
    expect(admin.s.permissions).toContain("production.override");
    const id2 = await shortOrder(admin.api, admin.s.sessionToken);
    const key = uuid();
    const r = await admin.api.packOrder(admin.s.sessionToken, {
      orderId: id2,
      idempotencyKey: key,
      override: { reason: "Transfer lost" },
    });
    expect(r.packed).toBe(false);
    expect(r.override?.reason).toBe("Transfer lost");
    // Handed over: off the pack list, and a replay returns the same result.
    const q = await admin.api.queue(admin.s.sessionToken, "pack");
    expect(q.items.some((i) => i.orderId === id2)).toBe(false);
    const again = await admin.api.packOrder(admin.s.sessionToken, {
      orderId: id2,
      idempotencyKey: key,
      override: { reason: "Transfer lost" },
    });
    expect(again).toEqual(r);
  });

  it("packs a complete order", async () => {
    const { api, s } = await signIn("1166");
    const q = await api.queue(s.sessionToken, "pack");
    const unit = q.items.find((i) => i.orderNo === "#1050" && i.state === "pressed");
    await api.qc(s.sessionToken, { orderItemId: unit?.orderItemId as string, result: "pass" });
    const r = await api.packOrder(s.sessionToken, {
      orderId: unit?.orderId as string,
      idempotencyKey: uuid(),
    });
    expect(r).toMatchObject({ packed: true, missing: [], override: null });
  });
});
