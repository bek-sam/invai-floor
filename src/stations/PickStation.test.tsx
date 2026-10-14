import { cleanup, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../api/types";

vi.mock("@invai/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@invai/ui")>();
  return {
    ...actual,
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
    BigButton: (props: React.ComponentProps<"button">) => <button {...props} />,
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
  removeFromQueues: vi.fn(),
}));

vi.mock("../app/store", () => ({
  useSession: () => ({
    sessionToken: "tok1",
    user: { id: "u1", name: "Ana", role: "presser" },
    station: { id: "st1" },
  }),
}));

const submitMock = vi.fn();
vi.mock("../app/actions", () => ({ submit: (...args: unknown[]) => submitMock(...args) }));
vi.mock("../lib/feedback", () => ({ feedback: vi.fn() }));

import { removeFromQueues } from "../hooks/useStationQueue";
import { setLang, setupI18n } from "../i18n";
import { emitScan } from "../scanner/bus";
import { useWedgeListener } from "../scanner/useWedgeScanner";
import { PickStation } from "./PickStation";

const mk = (n: number): QueueItem => ({
  orderItemId: `item-${n}`,
  orderId: `order-${n}`,
  orderNo: `#10${n}`,
  state: "ready",
  shipBy: new Date().toISOString(),
  isRush: false,
  isReprint: false,
  design: { id: "d1", name: "Desert Sun", code: "DS1" },
  placement: "front",
  blank: { variantId: "b1", brand: "Gildan", style: "64000", color: "Black", size: "L" },
  artworkPreviewKey: null,
  transferId: `T00000${n}`,
  sheetId: "sheet-1",
  sheetName: "2026-09-24 #1",
  binCode: null,
  orderOpenUnits: 1,
});

function Host() {
  useWedgeListener();
  return <PickStation />;
}

describe("PickStation queue removal (T-57-4 round 2)", () => {
  beforeAll(async () => {
    await setupI18n();
    await setLang("en", false);
  });
  beforeEach(() => {
    queueState.items = [mk(1), mk(2)];
    submitMock.mockReset();
    vi.mocked(removeFromQueues).mockClear();
  });
  afterEach(cleanup);

  async function pickOnce(outcome: unknown) {
    submitMock.mockResolvedValueOnce(outcome);
    render(<Host />);
    emitScan("B:b1");
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
  }

  it("drops the picked unit once the server confirms, so the next scan takes the next unit", async () => {
    await pickOnce({
      status: "sent",
      entry: {},
      result: { clientScanId: "x", ok: true, mismatch: null },
    });
    expect(submitMock.mock.calls[0]?.[0].input.transferCode).toBe("T000001");
    expect(removeFromQueues).toHaveBeenCalledWith(["item-1"]);
  });

  it("keeps the unit when the server blocks or the pick is only queued", async () => {
    await pickOnce({
      status: "sent",
      entry: {},
      result: { clientScanId: "x", ok: false, mismatch: "wrong_size" },
    });
    expect(removeFromQueues).not.toHaveBeenCalled();
    cleanup();
    submitMock.mockReset();
    await pickOnce({ status: "queued", entry: { id: "p" }, reason: new Error("offline") });
    expect(removeFromQueues).not.toHaveBeenCalled();
  });
});
