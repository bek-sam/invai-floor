import { parseCode } from "../../lib/codes";
import { uuid } from "../../lib/uuid";
import type { GangSheet, PoLine, PurchaseOrder, StockLevel } from "./api";

type Blankish = { variantId: string; supplierSku: string };

/** Does a scanned code name this blank? `B:<variantId>`, a bare id, or the supplier SKU/UPC. */
export function codeMatchesBlank(code: string, blank: Blankish): boolean {
  const p = parseCode(code);
  if (p.kind === "blank" || p.kind === "unknown") {
    return (
      p.value === blank.variantId ||
      p.raw === blank.variantId ||
      p.raw.toUpperCase() === blank.supplierSku.toUpperCase()
    );
  }
  return false;
}

/** A PO is picked by scanning its number (`PO-1001`, `PO:PO-1001`) or its id. */
export function findPo(pos: PurchaseOrder[], code: string): PurchaseOrder | null {
  const raw = code.trim();
  const bare = raw.toUpperCase().startsWith("PO:") ? raw.slice(3) : raw;
  const upper = bare.toUpperCase();
  return pos.find((po) => po.id === bare || po.poNo.toUpperCase() === upper) ?? null;
}

/* ------------------------------- PO receipts ------------------------------- */

export type ReceiptDraft = {
  poId: string;
  /** One key per submission, so a double tap or an offline replay counts once. */
  idempotencyKey: string;
  qty: Record<string, number>;
};

export function newReceipt(po: PurchaseOrder): ReceiptDraft {
  return { poId: po.id, idempotencyKey: uuid(), qty: {} };
}

export const outstanding = (line: PoLine) => Math.max(0, line.qty - line.receivedQty);

export function draftQty(draft: ReceiptDraft, lineId: string): number {
  return draft.qty[lineId] ?? 0;
}

/** Which PO line a blank scan counts toward: the first one still short, else the first match. */
export function lineForScan(po: PurchaseOrder, draft: ReceiptDraft, code: string): PoLine | null {
  const matches = po.lines.filter((l) =>
    codeMatchesBlank(code, { variantId: l.blankVariantId, supplierSku: l.blank.supplierSku }),
  );
  return matches.find((l) => draftQty(draft, l.id) < outstanding(l)) ?? matches[0] ?? null;
}

export function setLineQty(draft: ReceiptDraft, lineId: string, qty: number): ReceiptDraft {
  const n = Number.isFinite(qty) ? Math.max(0, Math.floor(qty)) : 0;
  return { ...draft, qty: { ...draft.qty, [lineId]: n } };
}

export function addOne(draft: ReceiptDraft, lineId: string): ReceiptDraft {
  return setLineQty(draft, lineId, draftQty(draft, lineId) + 1);
}

/** Lines where more arrived than the PO still expects. The server refuses these. */
export function overLines(po: PurchaseOrder, draft: ReceiptDraft) {
  return po.lines
    .filter((l) => draftQty(draft, l.id) > outstanding(l))
    .map((l) => ({ line: l, extra: draftQty(draft, l.id) - outstanding(l) }));
}

/** Caps every line at what is still outstanding (the "receive only what was ordered" fix). */
export function capToOutstanding(po: PurchaseOrder, draft: ReceiptDraft): ReceiptDraft {
  let d = draft;
  for (const l of po.lines) {
    if (draftQty(d, l.id) > outstanding(l)) d = setLineQty(d, l.id, outstanding(l));
  }
  return d;
}

export function receiptLines(po: PurchaseOrder, draft: ReceiptDraft) {
  return po.lines
    .filter((l) => draftQty(draft, l.id) > 0)
    .map((l) => ({ lineId: l.id, qty: draftQty(draft, l.id) }));
}

export function receiptTotal(draft: ReceiptDraft): number {
  return Object.values(draft.qty).reduce((s, n) => s + n, 0);
}

/** Does this receipt finish the PO (every line fully in)? */
export function completesPo(po: PurchaseOrder, draft: ReceiptDraft): boolean {
  return po.lines.every((l) => draftQty(draft, l.id) >= outstanding(l));
}

/** The PO as it will look once these receipt lines land; used while receipts wait offline. */
export function applyReceiptLines(
  po: PurchaseOrder,
  lines: { lineId: string; qty: number }[],
): PurchaseOrder {
  const add = new Map<string, number>();
  for (const l of lines) add.set(l.lineId, (add.get(l.lineId) ?? 0) + l.qty);
  const next = po.lines.map((l) => ({
    ...l,
    receivedQty: Math.min(l.qty, l.receivedQty + (add.get(l.id) ?? 0)),
  }));
  const done = next.every((l) => l.receivedQty >= l.qty);
  const any = next.some((l) => l.receivedQty > 0);
  return {
    ...po,
    lines: next,
    status: done ? "received" : any ? "partially_received" : po.status,
  };
}

/* ------------------------------ vendor sheets ------------------------------ */

/** A scan of a sheet's id, `S:<id>`/`SHEET:<id>`, or its name ("2026-09-24 #1"). */
export function findSheetByCode(sheets: GangSheet[], code: string): GangSheet | null {
  const raw = code.trim();
  const bare = raw.replace(/^(SHEET|S):/i, "");
  return sheets.find((s) => s.id === bare || s.name.toUpperCase() === bare.toUpperCase()) ?? null;
}

/* ------------------------------- stock count ------------------------------- */

export type CountLine = { blankVariantId: string; counted: number };
export type CountDraft = { lines: CountLine[] };

export function findStock(stock: StockLevel[], code: string): StockLevel | null {
  return (
    stock.find((s) =>
      codeMatchesBlank(code, { variantId: s.blankVariantId, supplierSku: s.blank.supplierSku }),
    ) ?? null
  );
}

/** One scan = one shirt counted. A new blank goes to the top of the list. */
export function countOne(draft: CountDraft, blankVariantId: string): CountDraft {
  const found = draft.lines.find((l) => l.blankVariantId === blankVariantId);
  if (!found) return { lines: [{ blankVariantId, counted: 1 }, ...draft.lines] };
  return setCounted(draft, blankVariantId, found.counted + 1);
}

export function setCounted(draft: CountDraft, blankVariantId: string, n: number): CountDraft {
  const counted = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const exists = draft.lines.some((l) => l.blankVariantId === blankVariantId);
  if (!exists) return { lines: [{ blankVariantId, counted }, ...draft.lines] };
  return {
    lines: draft.lines.map((l) => (l.blankVariantId === blankVariantId ? { ...l, counted } : l)),
  };
}

export function removeCountLine(draft: CountDraft, blankVariantId: string): CountDraft {
  return { lines: draft.lines.filter((l) => l.blankVariantId !== blankVariantId) };
}

export type CountRow = CountLine & { stock: StockLevel | null; expected: number; delta: number };

/** Counted vs what the system has on hand, shown before the count is saved. */
export function countRows(draft: CountDraft, stock: StockLevel[]): CountRow[] {
  const byId = new Map(stock.map((s) => [s.blankVariantId, s]));
  return draft.lines.map((l) => {
    const s = byId.get(l.blankVariantId) ?? null;
    const expected = s?.onHand ?? 0;
    return { ...l, stock: s, expected, delta: l.counted - expected };
  });
}
