import { describe, expect, it } from "vitest";
import { type GangSheet, type PurchaseOrder, receivingApi, type StockLevel } from "./api";
import { sendReceiving } from "./commands";
import { createReceivingDemo } from "./demo";
import {
  applyReceiptLines,
  capToOutstanding,
  completesPo,
  countOne,
  countRows,
  draftQty,
  findPo,
  findSheetByCode,
  findStock,
  lineForScan,
  newReceipt,
  overLines,
  receiptLines,
  receiptTotal,
  setCounted,
  setLineQty,
} from "./logic";

const token = "demo-session";

async function demoPo(poNo = "PO-1007") {
  const api = createReceivingDemo();
  const pos = await api.openPurchaseOrders(token);
  const po = pos.find((p) => p.poNo === poNo) as PurchaseOrder;
  return { api, po };
}

describe("picking a PO", () => {
  it("finds a PO by number (any case, with or without PO: prefix) or id", async () => {
    const { api } = await demoPo();
    const pos = await api.openPurchaseOrders(token);
    const po = pos[0] as PurchaseOrder;
    expect(findPo(pos, po.poNo.toLowerCase())?.id).toBe(po.id);
    expect(findPo(pos, `PO:${po.poNo}`)?.id).toBe(po.id);
    expect(findPo(pos, ` ${po.id} `)?.id).toBe(po.id);
    expect(findPo(pos, "PO-9999")).toBeNull();
  });
});

describe("PO receipt draft", () => {
  it("counts a blank scan toward the matching line, by B: code or supplier SKU", async () => {
    const { po } = await demoPo();
    const line = po.lines[0];
    if (!line) throw new Error("no line");
    let d = newReceipt(po);
    expect(lineForScan(po, d, `B:${line.blankVariantId}`)?.id).toBe(line.id);
    expect(lineForScan(po, d, line.blank.supplierSku.toLowerCase())?.id).toBe(line.id);
    expect(lineForScan(po, d, "B:not-on-this-po")).toBeNull();
    expect(lineForScan(po, d, "T:some-transfer")).toBeNull();
    d = setLineQty(d, line.id, 3);
    expect(draftQty(d, line.id)).toBe(3);
    expect(receiptLines(po, d)).toEqual([{ lineId: line.id, qty: 3 }]);
    expect(receiptTotal(d)).toBe(3);
  });

  it("keeps one idempotency key per draft", async () => {
    const { po } = await demoPo();
    const d = newReceipt(po);
    const line = po.lines[0];
    if (!line) throw new Error("no line");
    expect(setLineQty(d, line.id, 2).idempotencyKey).toBe(d.idempotencyKey);
    expect(newReceipt(po).idempotencyKey).not.toBe(d.idempotencyKey);
  });

  it("allows a partial receipt and knows when a receipt completes the PO", async () => {
    const { po } = await demoPo();
    let d = newReceipt(po);
    const [a] = po.lines;
    if (!a) throw new Error("no line");
    d = setLineQty(d, a.id, 5);
    expect(completesPo(po, d)).toBe(false);
    for (const l of po.lines) d = setLineQty(d, l.id, l.qty - l.receivedQty);
    expect(completesPo(po, d)).toBe(true);
  });

  it("warns about over-receipt and can cap to what is outstanding", async () => {
    const { po } = await demoPo("PO-1006");
    const partial = po.lines[0]; // 12 ordered, 6 already in
    if (!partial) throw new Error("no line");
    let d = setLineQty(newReceipt(po), partial.id, 8);
    expect(overLines(po, d)).toEqual([{ line: partial, extra: 2 }]);
    d = capToOutstanding(po, d);
    expect(draftQty(d, partial.id)).toBe(6);
    expect(overLines(po, d)).toEqual([]);
  });

  it("prefers a line that is still short when a blank is on two lines", async () => {
    const { po } = await demoPo();
    const line = po.lines[0];
    if (!line) throw new Error("no line");
    const twin = { ...line, id: "twin-line", qty: 5, receivedQty: 0 };
    const doubled: PurchaseOrder = { ...po, lines: [line, twin] };
    const d = setLineQty(newReceipt(doubled), line.id, line.qty);
    expect(lineForScan(doubled, d, `B:${line.blankVariantId}`)?.id).toBe("twin-line");
  });

  it("folds receipts waiting offline into the PO so they can't be received twice", async () => {
    const { po } = await demoPo();
    const [a] = po.lines;
    if (!a) throw new Error("no line");
    const once = applyReceiptLines(po, [{ lineId: a.id, qty: 4 }]);
    expect(once.lines[0]?.receivedQty).toBe(4);
    expect(once.status).toBe("partially_received");
    const all = applyReceiptLines(
      po,
      po.lines.map((l) => ({ lineId: l.id, qty: l.qty })),
    );
    expect(all.status).toBe("received");
  });
});

describe("demo receiving backend (same rules as the server)", () => {
  it("receives partially, then fully, and counts a replayed key once", async () => {
    const { api, po } = await demoPo();
    const [a, ...rest] = po.lines;
    if (!a) throw new Error("no line");
    const first = {
      purchaseOrderId: po.id,
      lines: [{ lineId: a.id, qty: 10 }],
      note: null,
      idempotencyKey: "key-first-0001",
    };
    const r1 = await api.receivePo(token, first);
    expect(r1.status).toBe("partially_received");
    const replay = await api.receivePo(token, first);
    expect(replay.lines[0]?.receivedQty).toBe(10);

    const r2 = await api.receivePo(token, {
      purchaseOrderId: po.id,
      lines: [
        { lineId: a.id, qty: a.qty - 10 },
        ...rest.map((l) => ({ lineId: l.id, qty: l.qty })),
      ],
      note: null,
      idempotencyKey: "key-second-0002",
    });
    expect(r2.status).toBe("received");
    expect((await api.openPurchaseOrders(token)).some((p) => p.id === po.id)).toBe(false);
  });

  it("refuses more than is outstanding", async () => {
    const { api, po } = await demoPo("PO-1006");
    const line = po.lines[0];
    if (!line) throw new Error("no line");
    await expect(
      api.receivePo(token, {
        purchaseOrderId: po.id,
        lines: [{ lineId: line.id, qty: 7 }],
        note: null,
        idempotencyKey: "key-over-0001",
      }),
    ).rejects.toMatchObject({ kind: "rejected", code: "BAD_REQUEST" });
  });

  it("marks an arriving sheet received once; a replay is refused as a transition", async () => {
    const api = receivingApi("demo"); // the instance the outbox sender uses
    const [sheet] = await api.arrivingSheets(token);
    if (!sheet) throw new Error("no sheet");
    const ids = await api.sheetTransferIds(token, sheet.id);
    expect(ids.length).toBe(sheet.transferCount);
    const cmd = {
      kind: "receiving" as const,
      action: { op: "sheetReceived" as const, sheetId: sheet.id, label: sheet.name },
    };
    const res = (await sendReceiving(cmd, token, "demo")) as GangSheet;
    expect(res.status).toBe("received");
    await expect(api.markSheetReceived(token, sheet.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect((await api.arrivingSheets(token)).some((s) => s.id === sheet.id)).toBe(false);
  });

  it("records a count and reports the variance", async () => {
    const api = createReceivingDemo();
    const stock = await api.stock(token);
    const s = stock[0] as StockLevel;
    const res = await api.count(token, {
      lines: [{ blankVariantId: s.blankVariantId, counted: s.onHand - 2 }],
      note: null,
    });
    expect(res.variance[0]).toMatchObject({ expected: s.onHand, delta: -2 });
    const after = await api.stock(token);
    expect(after[0]?.onHand).toBe(s.onHand - 2);
  });
});

describe("finding a sheet", () => {
  it("matches a sheet id, S:/SHEET: code or the sheet name", async () => {
    const sheets = await createReceivingDemo().arrivingSheets(token);
    const s = sheets[0] as GangSheet;
    expect(findSheetByCode(sheets, s.id)?.id).toBe(s.id);
    expect(findSheetByCode(sheets, `SHEET:${s.id}`)?.id).toBe(s.id);
    expect(findSheetByCode(sheets, `s:${s.id}`)?.id).toBe(s.id);
    expect(findSheetByCode(sheets, s.name)?.id).toBe(s.id);
    expect(findSheetByCode(sheets, "T:abc")).toBeNull();
  });
});

describe("stock count", () => {
  it("counts one per scan, shows the difference before saving", async () => {
    const stock = await createReceivingDemo().stock(token);
    const s = stock[0] as StockLevel;
    expect(findStock(stock, `B:${s.blankVariantId}`)?.blankVariantId).toBe(s.blankVariantId);
    expect(findStock(stock, s.blank.supplierSku)?.blankVariantId).toBe(s.blankVariantId);
    expect(findStock(stock, "B:unknown")).toBeNull();

    let d = countOne({ lines: [] }, s.blankVariantId);
    d = countOne(d, s.blankVariantId);
    expect(countRows(d, stock)[0]).toMatchObject({
      counted: 2,
      expected: s.onHand,
      delta: 2 - s.onHand,
    });
    d = setCounted(d, s.blankVariantId, s.onHand);
    expect(countRows(d, stock)[0]?.delta).toBe(0);
    const other = stock[1] as StockLevel;
    d = countOne(d, other.blankVariantId);
    expect(d.lines[0]?.blankVariantId).toBe(other.blankVariantId); // newest on top
  });
});
