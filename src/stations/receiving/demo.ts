import { ApiFailure } from "../../api/errors";
import type {
  CountInput,
  CountResult,
  GangSheet,
  PurchaseOrder,
  ReceiveInput,
  ReceivingApi,
  StockLevel,
} from "./api";

/**
 * In-memory receiving backend for demo mode, with the server's rules: partial receipts,
 * no more than outstanding per line, one result per idempotency key, and sheets only
 * received from printed or shipped. Blank ids match the demo floor backend's blanks.
 */
const uid = (prefix: number, n: number) =>
  `00000000-0000-4000-8${prefix.toString(16).padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

const LOCATION = uid(40, 1);
const now = () => new Date().toISOString();

type Blank = StockLevel["blank"];
const blank = (
  n: number,
  brand: string,
  style: string,
  color: string,
  size: string,
  sku: string,
): Blank => ({
  variantId: uid(2, n),
  brand,
  style,
  styleCode: style,
  color,
  colorCode: color.toLowerCase().replace(/\s+/g, "-"),
  size,
  supplier: "ssactivewear",
  supplierSku: sku,
  cost: 312,
});

const BLANKS: Blank[] = [
  blank(1, "Gildan", "64000", "Black", "L", "B00760005"),
  blank(2, "Gildan", "64000", "Black", "M", "B00760004"),
  blank(3, "Gildan", "64000", "White", "L", "B00030005"),
  blank(4, "Comfort Colors", "1717", "Pepper", "XL", "B09874006"),
  blank(5, "Bella+Canvas", "3001", "Heather Dust", "S", "B18832003"),
  blank(6, "Comfort Colors", "1717", "Sage", "M", "B09875004"),
];
const ON_HAND = [42, 18, 30, 7, 12, 9];

function stockRow(b: Blank, onHand: number, incoming: number): StockLevel {
  return {
    blankVariantId: b.variantId,
    blank: b,
    locationId: LOCATION,
    onHand,
    reserved: 0,
    available: onHand,
    incoming,
    reorderPoint: null,
    reorderQty: null,
    dailyVelocity: 0,
    daysOfCover: null,
    belowReorderPoint: false,
    updatedAt: now(),
  };
}

function po(n: number, poNo: string, lines: [number, number, number][]): PurchaseOrder {
  const at = new Date(Date.now() - n * 86_400_000).toISOString();
  const poLines = lines.map(([b, qty, received], i) => {
    const bl = BLANKS[b] as Blank;
    return {
      id: uid(42, n * 16 + i),
      blankVariantId: bl.variantId,
      blank: bl,
      qty,
      receivedQty: received,
      unitCost: bl.cost,
    };
  });
  const subtotal = poLines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  return {
    id: uid(41, n),
    poNo,
    supplier: "ssactivewear",
    status: poLines.some((l) => l.receivedQty > 0) ? "partially_received" : "submitted",
    locationId: LOCATION,
    lines: poLines,
    subtotal,
    freight: 0,
    total: subtotal,
    supplierOrderId: `SS-${900 + n}`,
    expectedAt: at,
    notes: null,
    submittedAt: at,
    receivedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function sheet(n: number, status: GangSheet["status"], transfers: number): GangSheet {
  const at = new Date(Date.now() - n * 3_600_000).toISOString();
  return {
    id: uid(43, n),
    batchId: uid(44, 1),
    sheetNo: n,
    name: `2026-09-24 #${n}`,
    vendorConnectionId: uid(45, 1),
    vendorName: "Sun City DTF",
    widthIn: 22,
    lengthIn: 120,
    utilization: 0.88,
    status,
    transferCount: transfers,
    reprintCount: 0,
    files: { pngKey: null, pdfKey: null, previewKey: null },
    cost: 4200,
    tracking: status === "shipped" ? { carrier: "UPS", code: "1Z999AA10123456784" } : null,
    sentAt: at,
    acknowledgedAt: at,
    printedAt: at,
    shippedAt: status === "shipped" ? at : null,
    receivedAt: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

const fail = (code: string, message: string, status = 400) =>
  new ApiFailure("rejected", code, message, status);
const delay = (ms = 150) => new Promise((r) => setTimeout(r, ms));

export function createReceivingDemo(): ReceivingApi {
  const pos: PurchaseOrder[] = [
    po(1, "PO-1007", [
      [0, 24, 0],
      [1, 12, 0],
      [2, 24, 0],
    ]),
    po(2, "PO-1006", [
      [3, 12, 6],
      [4, 6, 0],
    ]),
  ];
  const sheets: GangSheet[] = [sheet(3, "shipped", 14), sheet(4, "printed", 9)];
  const transfersOf = new Map(
    sheets.map((s) => [
      s.id,
      Array.from({ length: s.transferCount }, (_, i) => uid(46 + s.sheetNo, i + 1)),
    ]),
  );
  const stock = BLANKS.map((b, i) => stockRow(b, ON_HAND[i] ?? 0, 0));
  const receipts = new Map<string, string>(); // idempotencyKey -> purchaseOrderId

  const recomputeIncoming = () => {
    for (const s of stock) {
      s.incoming = pos
        .flatMap((p) => (p.status === "received" ? [] : p.lines))
        .filter((l) => l.blankVariantId === s.blankVariantId)
        .reduce((sum, l) => sum + (l.qty - l.receivedQty), 0);
    }
  };
  recomputeIncoming();

  return {
    async openPurchaseOrders() {
      await delay();
      return structuredClone(pos.filter((p) => p.status !== "received"));
    },
    async receivePo(_token, input: ReceiveInput) {
      await delay();
      const p = pos.find((x) => x.id === input.purchaseOrderId);
      if (!p) throw fail("NOT_FOUND", "Purchase order not found", 404);
      if (input.idempotencyKey && receipts.has(input.idempotencyKey)) {
        return structuredClone(p);
      }
      if (p.status === "received") throw fail("INVALID_TRANSITION", "Already received", 409);
      for (const r of input.lines) {
        const line = p.lines.find((l) => l.id === r.lineId);
        if (!line) throw fail("NOT_FOUND", "Line not found", 404);
        if (r.qty > line.qty - line.receivedQty) {
          throw fail("BAD_REQUEST", `Only ${line.qty - line.receivedQty} outstanding`);
        }
      }
      for (const r of input.lines) {
        const line = p.lines.find((l) => l.id === r.lineId);
        if (!line) continue;
        line.receivedQty += r.qty;
        const s = stock.find((x) => x.blankVariantId === line.blankVariantId);
        if (s) {
          s.onHand += r.qty;
          s.available += r.qty;
        }
      }
      const done = p.lines.every((l) => l.receivedQty >= l.qty);
      p.status = done ? "received" : "partially_received";
      p.receivedAt = done ? now() : null;
      if (input.idempotencyKey) receipts.set(input.idempotencyKey, p.id);
      recomputeIncoming();
      return structuredClone(p);
    },
    async arrivingSheets() {
      await delay();
      return structuredClone(
        sheets.filter((s) => s.status === "printed" || s.status === "shipped"),
      );
    },
    async sheetTransferIds(_token, sheetId) {
      await delay(60);
      return transfersOf.get(sheetId) ?? [];
    },
    async markSheetReceived(_token, sheetId) {
      await delay();
      const s = sheets.find((x) => x.id === sheetId);
      if (!s) throw fail("NOT_FOUND", "Sheet not found", 404);
      if (s.status !== "printed" && s.status !== "shipped") {
        throw fail("INVALID_TRANSITION", `Sheet is ${s.status}`, 409);
      }
      s.status = "received";
      s.receivedAt = now();
      return structuredClone(s);
    },
    async stock() {
      await delay();
      return structuredClone(stock);
    },
    async count(_token, input: CountInput): Promise<CountResult> {
      await delay();
      const variance = input.lines.map((l) => {
        const s = stock.find((x) => x.blankVariantId === l.blankVariantId);
        if (!s) throw fail("NOT_FOUND", "Blank not found", 404);
        const expected = s.onHand;
        s.onHand = l.counted;
        s.available = l.counted - s.reserved;
        return {
          blankVariantId: l.blankVariantId,
          expected,
          counted: l.counted,
          delta: l.counted - expected,
        };
      });
      return { countId: uid(47, Date.now() % 100000), movements: [], variance };
    },
  };
}
