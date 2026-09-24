import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScan, useWedgeListener } from "./useWedgeScanner";

function Harness({ onScan, onClick }: { onScan: (c: string) => void; onClick: () => void }) {
  useWedgeListener();
  useScan(onScan);
  return (
    <button type="button" onClick={onClick}>
      Next
    </button>
  );
}

function press(key: string, target: EventTarget = window) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

let clock = 0;
const advance = (ms: number) => {
  clock += ms;
};

describe("useWedgeListener + useScan", () => {
  beforeEach(() => {
    clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("delivers scanner bursts and swallows their Enter", () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} onClick={() => {}} />);
    let enter: KeyboardEvent | undefined;
    act(() => {
      for (const ch of "T:abc123") {
        press(ch);
        advance(5);
      }
      enter = press("Enter");
    });
    expect(onScan).toHaveBeenCalledWith("T:abc123", "wedge");
    expect(enter?.defaultPrevented).toBe(true);
  });

  it("ignores slow human typing and leaves its Enter alone", () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} onClick={() => {}} />);
    let enter: KeyboardEvent | undefined;
    act(() => {
      for (const ch of "T:abc123") {
        press(ch);
        advance(150);
      }
      enter = press("Enter");
    });
    expect(onScan).not.toHaveBeenCalled();
    expect(enter?.defaultPrevented).toBe(false);
  });

  it("does not treat typing inside a text field as a scan", () => {
    const onScan = vi.fn();
    render(<Harness onScan={onScan} onClick={() => {}} />);
    const input = document.createElement("input");
    document.body.append(input);
    act(() => {
      for (const ch of "T:abc123") {
        press(ch, input);
        advance(5);
      }
      press("Enter", input);
    });
    expect(onScan).not.toHaveBeenCalled();
    input.remove();
  });
});
