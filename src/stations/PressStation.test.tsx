import { cleanup, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../api/errors";
import type { QueueItem, ScanResult } from "../api/types";
import type { OutboxEntry } from "../outbox/db";

// T-P3-2 round 2 finding 1: a live scan's own `sent` result and a late `resolved` entry for the
// same clientScanId must not both apply -- one sound, one render. See PressStation.tsx's
// `resolvedEntry` effect and this file's test below.

vi.mock("@invai/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@invai/ui")>();
  return {
    ...actual,
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
    BigButton: (props: React.ComponentProps<"button">) => <button {...props} />,
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

const queueState = {
  items: [] as QueueItem[],
  counts: null as { waiting: number; doneToday: number } | null,
  loading: false,
  error: null,
  cachedAt: null,
  refetch: vi.fn(),
};

vi.mock("../hooks/useStationQueue", () => ({
  useStationQueue: () => queueState,
  invalidateQueues: vi.fn(),
  cachedBlanks: vi.fn().mockResolvedValue([]),
  findCachedItem: vi.fn().mockResolvedValue(null),
}));

vi.mock("../app/store", () => ({
  useSession: () => ({
    sessionToken: "tok1",
    user: { id: "u1", name: "Ana", role: "presser" },
    station: { id: "st1" },
  }),
  useApp: (selector: (s: { api: unknown; session: null }) => unknown) =>
    selector({ api: {}, session: null }),
}));

const submitMock = vi.fn();
vi.mock("../app/actions", () => ({ submit: (...args: unknown[]) => submitMock(...args) }));

const feedbackMock = vi.fn();
vi.mock("../lib/feedback", () => ({ feedback: (...args: unknown[]) => feedbackMock(...args) }));

import { setLang, setupI18n } from "../i18n";
import { takeResolved, useSyncStore } from "../outbox/sync";
import { emitScan } from "../scanner/bus";
import { PressStation } from "./PressStation";

const ITEM: QueueItem = {
  orderItemId: "item-1",
  orderId: "order-1",
  orderNo: "#1042",
  state: "ready",
  shipBy: new Date().toISOString(),
  isRush: false,
  isReprint: false,
  design: { id: "d1", name: "Desert Sun", code: "DS1" },
  placement: "front",
  blank: { variantId: "b1", brand: "Gildan", style: "64000", color: "Black", size: "L" },
  artworkPreviewKey: null,
  transferId: "T000001",
  sheetId: "sheet-1",
  sheetName: "2026-09-24 #1",
  binCode: null,
  orderOpenUnits: 1,
};

function scanId(): string {
  const call = submitMock.mock.calls.at(-1)?.[0] as { input: { clientScanId: string } };
  return call.input.clientScanId;
}

describe("PressStation resolved entries (T-P3-2 round 2)", () => {
  beforeAll(async () => {
    await setupI18n();
    await setLang("en", false);
  });

  beforeEach(() => {
    queueState.items = [ITEM];
    submitMock.mockReset();
    feedbackMock.mockReset();
    useSyncStore.setState({ resolved: {} });
  });

  afterEach(cleanup);

  it("a live BLOCKED scan plays exactly one sound and renders once", async () => {
    const result: ScanResult = {
      ok: false,
      clientScanId: "",
      mismatch: "wrong_size",
      orderNo: "#1042",
    } as ScanResult;
    submitMock.mockImplementation(async (cmd: { input: { clientScanId: string } }) => {
      const id = cmd.input.clientScanId;
      // The real engine's flush already wrote this scan into `resolved` before `submit()`
      // returns -- a live send is published there too, same as a replayed one (outbox.ts).
      const entry = {
        id,
        command: { kind: "scan", input: cmd.input },
        status: "done",
        parkReason: null,
        result: { ...result, clientScanId: id },
        replay: false,
      } as unknown as OutboxEntry;
      useSyncStore.setState((s) => ({ resolved: { ...s.resolved, [id]: entry } }));
      return { status: "sent", entry, result: entry.result };
    });

    const { getByRole, findByRole } = render(<PressStation />);
    emitScan(`T:${ITEM.transferId}`);
    emitScan(`B:${ITEM.blank.variantId}x`); // not a real UUID: forces the server round trip

    const heading = await findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("BLOCKED");
    expect(getByRole("heading", { level: 1 })).toBe(heading); // exactly one heading, not two

    await waitFor(() => expect(feedbackMock).toHaveBeenCalled());
    // tick (transfer scanned), then one "error" for the server's verdict -- never a second one
    // from the `resolved` entry the same send also published.
    expect(feedbackMock.mock.calls.map((c) => c[0])).toEqual(["tick", "error"]);
    expect(useSyncStore.getState().resolved[scanId()]).toBeUndefined();
  });

  it("still replaces a busy panel with the server's late verdict (AC3/R1 kept)", async () => {
    submitMock.mockResolvedValue({
      status: "queued",
      entry: { id: "pending" },
      reason: new ApiFailure("busy", "RATE_LIMITED", "slow down", 429, { retryAfterSec: 5 }),
    });

    const { findByText, getByRole } = render(<PressStation />);
    emitScan(`T:${ITEM.transferId}`);
    emitScan("UPC:0000000000001"); // can't be checked locally -> full busy panel

    await findByText("BUSY");
    expect(feedbackMock.mock.calls.map((c) => c[0])).toEqual(["tick", "warn"]);

    const id = scanId();
    const blocked: ScanResult = {
      ok: false,
      clientScanId: id,
      mismatch: "wrong_style",
      orderNo: "#1042",
    } as ScanResult;
    const entry = {
      id,
      command: { kind: "scan", input: { clientScanId: id } },
      status: "parked",
      parkReason: "blocked",
      result: blocked,
      replay: true,
    } as unknown as OutboxEntry;
    useSyncStore.setState((s) => ({ resolved: { ...s.resolved, [id]: entry } }));

    const heading = await waitFor(() => getByRole("heading", { level: 1 }));
    await waitFor(() => expect(heading.textContent).toBe("BLOCKED"));
    expect(feedbackMock.mock.calls.map((c) => c[0])).toEqual(["tick", "warn", "error"]);
    expect(useSyncStore.getState().resolved[id]).toBeUndefined();
    expect(takeResolved(id)).toBeUndefined();
  });
});
