import { describe, expect, it } from "vitest";
import { WedgeDetector, type WedgeVerdict } from "./wedge";

/** Feed a string as keystrokes `gapMs` apart, then Enter `enterGapMs` later. */
function type(d: WedgeDetector, text: string, gapMs: number, start = 1000, enterGapMs = gapMs) {
  let t = start;
  const verdicts: WedgeVerdict[] = [];
  for (const ch of text) {
    verdicts.push(d.key({ key: ch }, t));
    t += gapMs;
  }
  verdicts.push(d.key({ key: "Enter" }, t - gapMs + enterGapMs));
  return { last: verdicts[verdicts.length - 1], verdicts, end: t };
}

describe("WedgeDetector", () => {
  it("recognizes a fast burst ending in Enter as a scan", () => {
    const d = new WedgeDetector();
    expect(type(d, "T:0b7c9e4e-1111", 8).last).toEqual({ type: "scan", code: "T:0b7c9e4e-1111" });
  });

  it("ignores a person typing the same characters", () => {
    const d = new WedgeDetector();
    expect(type(d, "T:0b7c9e4e", 140).last).toEqual({ type: "pass" });
  });

  it("does not count human keys typed before a scan as part of it", () => {
    const d = new WedgeDetector();
    d.key({ key: "x" }, 0);
    d.key({ key: "y" }, 200);
    expect(type(d, "BIN:A12", 5, 900).last).toEqual({ type: "scan", code: "BIN:A12" });
  });

  it("rejects bursts shorter than minLength (e.g. a quick double key)", () => {
    const d = new WedgeDetector({ minLength: 4 });
    expect(type(d, "ab", 5).last).toEqual({ type: "pass" });
  });

  it("lets a plain Enter through so keyboard users can press the focused button", () => {
    const d = new WedgeDetector();
    expect(d.key({ key: "Enter" }, 10)).toEqual({ type: "pass" });
  });

  it("requires the Enter to follow the burst promptly", () => {
    const d = new WedgeDetector({ maxEnterGapMs: 100 });
    expect(type(d, "B:12345", 5, 0, 500).last).toEqual({ type: "pass" });
  });

  it("ignores Shift between characters and treats Tab as a terminator", () => {
    const d = new WedgeDetector();
    const t = 0;
    d.key({ key: "Shift" }, t);
    d.key({ key: "T" }, t + 4);
    d.key({ key: "Shift" }, t + 6);
    d.key({ key: ":" }, t + 8);
    for (const [i, ch] of [..."abc9"].entries()) d.key({ key: ch }, t + 12 + i * 4);
    expect(d.key({ key: "Tab" }, t + 40)).toEqual({ type: "scan", code: "T:abc9" });
  });

  it("drops auto-repeat and shortcut chords", () => {
    const d = new WedgeDetector();
    d.key({ key: "a" }, 0);
    d.key({ key: "a", repeat: true }, 5);
    expect(d.key({ key: "Enter" }, 10)).toEqual({ type: "pass" });
    d.key({ key: "c", ctrlKey: true }, 20);
    expect(d.key({ key: "Enter" }, 25)).toEqual({ type: "pass" });
  });

  it("handles two scans back to back", () => {
    const d = new WedgeDetector();
    const first = type(d, "T:first-1", 3, 0);
    const second = type(d, "B:second", 3, first.end + 40);
    expect(first.last).toEqual({ type: "scan", code: "T:first-1" });
    expect(second.last).toEqual({ type: "scan", code: "B:second" });
  });
});
