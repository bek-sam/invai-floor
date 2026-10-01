import { describe, expect, it } from "vitest";
import type { QueueItem, ScanResult } from "../api/types";
import { initialPressState, type PressEvent, type PressState, pressReducer } from "./pressFlow";
import { localPressCheck, queuedView, viewFromResult } from "./result";

const VARIANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const preview = {
  orderItemId: "a",
  orderId: "o",
  orderNo: "#1042",
  state: "transfer_in",
  shipBy: "2026-09-25T00:00:00.000Z",
  isRush: false,
  isReprint: false,
  design: { id: "d", name: "Desert Sun", code: "DS-01" },
  placement: "front",
  blank: { variantId: VARIANT, brand: "Gildan", style: "64000", color: "Black", size: "L" },
  artworkPreviewKey: null,
  transferId: "t1",
  sheetId: null,
  sheetName: null,
  binCode: "A12",
  orderOpenUnits: 1,
} as QueueItem;

function result(over: Partial<ScanResult>): ScanResult {
  return {
    ok: true,
    clientScanId: "c1",
    mismatch: null,
    message: "",
    transferId: "t1",
    orderItemId: "a",
    orderId: "o",
    orderNo: "#1042",
    design: { id: "d", name: "Desert Sun", code: "DS-01" },
    expected: preview.blank,
    scannedBlank: preview.blank,
    placement: "front",
    isReprint: false,
    binCode: "A12",
    itemState: "pressed",
    nextAction: "qc",
    orderOpenUnits: 0,
    ...over,
  } as ScanResult;
}

function run(events: PressEvent[], start: PressState = initialPressState) {
  return events.reduce(pressReducer, start);
}

const scan = (code: string, clientScanId = "c1", p: QueueItem | null = null): PressEvent => ({
  type: "scan",
  code,
  preview: p,
  clientScanId,
});

describe("pressReducer", () => {
  it("transfer -> blank -> checking -> green result", () => {
    let s = run([scan("T:t1", "x", preview)]);
    expect(s).toMatchObject({ phase: "awaitBlank", transferCode: "T:t1", preview });
    s = run([scan(`B:${VARIANT}`, "c1")], s);
    expect(s).toMatchObject({ phase: "checking", blankCode: `B:${VARIANT}`, clientScanId: "c1" });
    s = run([{ type: "result", clientScanId: "c1", result: result({}) }], s);
    expect(s.phase).toBe("result");
    if (s.phase === "result") expect(s.view.tone).toBe("ok");
  });

  it("asks for the transfer first when a blank is scanned first", () => {
    expect(run([scan(`B:${VARIANT}`)])).toEqual({
      phase: "awaitTransfer",
      hint: "scan_transfer_first",
    });
  });

  it("replaces the transfer when a different transfer QR is scanned", () => {
    const s = run([scan("T:t1"), scan("T:t2")]);
    expect(s).toMatchObject({ phase: "awaitBlank", transferCode: "T:t2" });
  });

  it("ignores the same transfer QR scanned twice", () => {
    const s = run([scan("abc-transfer"), scan("abc-transfer")]);
    expect(s).toMatchObject({ phase: "awaitBlank", transferCode: "abc-transfer" });
  });

  it("ignores scans and stale answers while a check is running", () => {
    let s = run([scan("T:t1"), scan("B:x1", "c1")]);
    s = run([scan("B:x2", "c2")], s);
    expect(s).toMatchObject({ phase: "checking", clientScanId: "c1" });
    s = run([{ type: "result", clientScanId: "other", result: result({}) }], s);
    expect(s.phase).toBe("checking");
  });

  it("shows the red reason and re-checks the same transfer with a new blank", () => {
    let s = run([
      scan("T:t1"),
      scan("B:wrong", "c1"),
      {
        type: "result",
        clientScanId: "c1",
        result: result({ ok: false, mismatch: "wrong_size", message: "Needs L" }),
      },
    ]);
    expect(s.phase === "result" && s.view).toMatchObject({
      tone: "blocked",
      reasonKey: "mismatch.wrong_size",
    });
    s = run([scan(`B:${VARIANT}`, "c2")], s);
    expect(s).toMatchObject({ phase: "checking", transferCode: "T:t1", clientScanId: "c2" });
  });

  it("after a green result, a new transfer starts the next cycle and a blank only hints", () => {
    const green = run([
      scan("T:t1"),
      scan("B:x", "c1"),
      { type: "result", clientScanId: "c1", result: result({}) },
    ]);
    expect(run([scan("B:y", "c2")], green)).toMatchObject({
      phase: "result",
      hint: "scan_next_transfer",
    });
    expect(run([scan("T:t9", "c3")], green)).toMatchObject({
      phase: "awaitBlank",
      transferCode: "T:t9",
    });
  });

  it("Next resets from anywhere", () => {
    expect(run([scan("T:t1"), { type: "next" }])).toEqual(initialPressState);
  });

  it("takes a local verdict while offline", () => {
    const s = run([
      scan("T:t1", "x", preview),
      scan(`B:${VARIANT}`, "c1"),
      { type: "local", clientScanId: "c1", view: localPressCheck(preview, `B:${VARIANT}`) },
    ]);
    expect(s.phase === "result" && s.view).toMatchObject({
      tone: "ok",
      provisional: true,
      queued: true,
    });
  });

  it("a busy retry's late answer replaces the provisional view it's still showing (T-P3-2 AC3)", () => {
    let s = run([
      scan("T:t1", "x", preview),
      scan(`B:${VARIANT}`, "c1"),
      { type: "local", clientScanId: "c1", view: localPressCheck(preview, `B:${VARIANT}`, [], 5) },
    ]);
    expect(s.phase === "result" && s.view).toMatchObject({ tone: "ok", busyRetryAfterSec: 5 });
    s = run(
      [
        {
          type: "result",
          clientScanId: "c1",
          result: result({ ok: false, mismatch: "wrong_size", message: "Needs L" }),
        },
      ],
      s,
    );
    expect(s.phase === "result" && s.view).toMatchObject({
      tone: "blocked",
      reasonKey: "mismatch.wrong_size",
    });
  });

  it("ignores a late answer for a scan the presser already moved past (T-P3-2 R1)", () => {
    let s = run([
      scan("T:t1", "x", preview),
      scan(`B:${VARIANT}`, "c1"),
      { type: "local", clientScanId: "c1", view: queuedView(preview, 5) },
    ]);
    const shown = s.phase === "result" && s.view;
    // Moved on to a new scan on the same transfer before the busy retry answered.
    s = run([scan(`B:${VARIANT}`, "c2")], s);
    s = run(
      [
        {
          type: "result",
          clientScanId: "c1",
          result: result({ ok: false, mismatch: "wrong_size" }),
        },
      ],
      s,
    );
    expect(s).toMatchObject({ phase: "checking", clientScanId: "c2" });
    expect(shown).toMatchObject({ busyRetryAfterSec: 5 });
  });
});

describe("viewFromResult", () => {
  it.each([
    ["wrong_size", "mismatch.wrong_size"],
    ["wrong_color", "mismatch.wrong_color"],
    ["wrong_design", "mismatch.wrong_design"],
    ["already_processed", "mismatch.already_processed"],
    ["item_cancelled", "mismatch.item_cancelled"],
    ["item_on_hold", "mismatch.item_on_hold"],
  ] as const)("maps %s to a red panel with its reason", (mismatch, key) => {
    const v = viewFromResult(result({ ok: false, mismatch, message: "server text" }));
    // The server's English message never reaches the screen; the reason key is translated.
    expect(v).toMatchObject({ tone: "blocked", reasonKey: key, message: null });
  });

  it("carries the order, design and expected vs scanned blank", () => {
    const v = viewFromResult(
      result({
        ok: false,
        mismatch: "wrong_color",
        scannedBlank: {
          ...preview.blank,
          blankVariantId: OTHER,
          color: "White",
        } as ScanResult["scannedBlank"],
        expected: { ...preview.blank, blankVariantId: VARIANT } as ScanResult["expected"],
      }),
    );
    expect(v.orderNo).toBe("#1042");
    expect(v.designName).toBe("Desert Sun");
    expect(v.expected).toBe("Gildan 64000 · Black · L");
    expect(v.scanned).toBe("Gildan 64000 · White · L");
  });
});

describe("localPressCheck", () => {
  it("passes a matching blank variant", () => {
    expect(localPressCheck(preview, `B:${VARIANT}`).tone).toBe("ok");
  });

  it("names the difference when the scanned blank is known", () => {
    const white = { ...preview.blank, variantId: OTHER, color: "White" };
    expect(localPressCheck(preview, `B:${OTHER}`, [white])).toMatchObject({
      tone: "blocked",
      reasonKey: "mismatch.wrong_color",
    });
  });

  it("can't verify a UPC or an unknown transfer offline", () => {
    expect(localPressCheck(preview, "012345678905").tone).toBe("warn");
    expect(localPressCheck(null, `B:${VARIANT}`).tone).toBe("warn");
  });
});
