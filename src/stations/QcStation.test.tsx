import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../api/types";

// B-222: isolate the result heading from Radix Dialog/portal behavior (no test in this repo
// renders @invai/ui's Dialog), and from the real outbox/queue machinery, which isn't the thing
// under test here. The real markup is exercised by the e2e suite.
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
}));

vi.mock("../app/store", () => ({
  useApp: (selector: (s: { api: unknown; session: null }) => unknown) =>
    selector({ api: {}, session: null }),
}));

const submitMock = vi.fn();
vi.mock("../app/actions", () => ({ submit: (...args: unknown[]) => submitMock(...args) }));

vi.mock("../lib/feedback", () => ({ feedback: vi.fn() }));

import { setLang, setupI18n } from "../i18n";
import { emitScan } from "../scanner/bus";
import { QcStation } from "./QcStation";

const ITEM: QueueItem = {
  orderItemId: "item-1",
  orderId: "order-1",
  orderNo: "#1042",
  state: "pressed",
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

describe("QcStation result heading (B-222)", () => {
  beforeAll(async () => {
    await setupI18n();
    await setLang("es", false);
  });

  beforeEach(() => {
    queueState.items = [ITEM];
    submitMock.mockReset();
  });

  afterEach(cleanup);

  it("in Spanish, a QC pass shows the result key 'Aprobado', not the Pass button's own label", async () => {
    submitMock.mockResolvedValue({ status: "sent", entry: {}, result: {} });
    const { getByText, getByRole } = render(<QcStation />);

    emitScan(`T:${ITEM.transferId}`);
    const passButton = await waitFor(() => getByText("Aprobar"));
    fireEvent.click(passButton);

    const heading = await waitFor(() => getByRole("heading", { level: 1 }));
    expect(heading.textContent).toBe("Aprobado");
  });

  it("in Spanish, a QC fail shows the result key 'Rechazado', distinct from the Fail button's 'Rechazar'", async () => {
    submitMock.mockResolvedValue({ status: "sent", entry: {}, result: {} });
    const { getByText, getByRole } = render(<QcStation />);

    emitScan(`T:${ITEM.transferId}`);
    const failButton = await waitFor(() => getByText("Rechazar"));
    fireEvent.click(failButton);
    // Fail opens the reason dialog (mocked above); pick the first reason.
    const reasonButton = await waitFor(() => getByText("Mala impresión"));
    fireEvent.click(reasonButton);

    const heading = await waitFor(() => getByRole("heading", { level: 1 }));
    expect(heading.textContent).toBe("Rechazado");
  });
});
