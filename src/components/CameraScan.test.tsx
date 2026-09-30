import { cleanup, fireEvent, render } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// S-44: isolate CameraScan's own open/close/getUserMedia race from Radix's Dialog behavior,
// which isn't the thing under test here. The real Button/Dialog markup is exercised by the e2e
// suite; this test proves the ref-guarded logic in CameraScan.tsx itself.
vi.mock("@invai/ui", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  toast: { warning: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CameraScan } from "./CameraScan";

describe("CameraScan (S-44: close-before-getUserMedia-resolves race)", () => {
  let resolveGetUserMedia: (stream: unknown) => void;
  let stopFns: ReturnType<typeof vi.fn>[];
  let getUserMedia: ReturnType<typeof vi.fn>;
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stopFns = [vi.fn(), vi.fn()];
    const tracks = stopFns.map((stop) => ({ stop }));
    const fakeStream = { getTracks: () => tracks };
    getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGetUserMedia = () => resolve(fakeStream);
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    // A BarcodeDetector must be "available" for start() to reach getUserMedia at all.
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      detect() {
        return Promise.resolve([]);
      }
    };
    rafSpy = vi.spyOn(window, "requestAnimationFrame");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector = undefined;
  });

  it("stops the stream's tracks and never starts the detect loop when the dialog is closed before getUserMedia resolves", async () => {
    const { getByTestId, getByText } = render(<CameraScan />);

    fireEvent.click(getByTestId("camera-scan-button"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Close the dialog (the user taps Cancel) while the permission prompt is still pending.
    fireEvent.click(getByText("floor.common.cancel"));

    // Now the permission prompt resolves, after close() already ran.
    await Promise.resolve().then(async () => {
      resolveGetUserMedia(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stopFns[0]).toHaveBeenCalledTimes(1);
    expect(stopFns[1]).toHaveBeenCalledTimes(1);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("assigns the stream and starts the detect loop when the dialog is still open when getUserMedia resolves", async () => {
    const { getByTestId } = render(<CameraScan />);

    fireEvent.click(getByTestId("camera-scan-button"));

    await Promise.resolve().then(async () => {
      resolveGetUserMedia(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stopFns[0]).not.toHaveBeenCalled();
    expect(stopFns[1]).not.toHaveBeenCalled();
    expect(rafSpy).toHaveBeenCalled();
  });
});
