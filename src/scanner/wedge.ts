export type WedgeOptions = {
  /** Max gap between characters of one scan. Scanners send a char every 1-20 ms; people take 80+. */
  maxGapMs?: number;
  /** Max gap between the last character and the terminating Enter. */
  maxEnterGapMs?: number;
  minLength?: number;
};

export type WedgeKey = {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export type WedgeVerdict =
  /** A complete scan; the caller should swallow the Enter so it doesn't click a focused button. */
  | { type: "scan"; code: string }
  /** A character that is part of a burst in progress. */
  | { type: "buffered" }
  /** Anything else: a person typing or pressing a key; let it through. */
  | { type: "pass" };

/**
 * Tells a keyboard-wedge barcode scanner apart from a person on the same keyboard. A scan is
 * `minLength`+ printable characters, each within `maxGapMs` of the previous, then Enter.
 * Human keystrokes are slower, so their buffer keeps resetting and never reaches `minLength`.
 */
export class WedgeDetector {
  private buffer = "";
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly maxGapMs: number;
  private readonly maxEnterGapMs: number;
  private readonly minLength: number;

  constructor({ maxGapMs = 50, maxEnterGapMs = 120, minLength = 4 }: WedgeOptions = {}) {
    this.maxGapMs = maxGapMs;
    this.maxEnterGapMs = maxEnterGapMs;
    this.minLength = minLength;
  }

  key(e: WedgeKey, now: number): WedgeVerdict {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.reset();
      return { type: "pass" };
    }
    // Modifier and navigation keys: Shift arrives between characters of `T:` etc.; ignore it.
    if (e.key.length > 1 && e.key !== "Enter" && e.key !== "Tab") return { type: "pass" };

    const gap = now - this.lastAt;
    if (e.key === "Enter" || e.key === "Tab") {
      const code = this.buffer;
      const isScan = code.length >= this.minLength && gap <= this.maxEnterGapMs;
      this.reset();
      return isScan ? { type: "scan", code } : { type: "pass" };
    }
    if (e.repeat) {
      this.reset();
      return { type: "pass" };
    }
    if (gap > this.maxGapMs) this.buffer = "";
    this.buffer += e.key;
    this.lastAt = now;
    return this.buffer.length > 1 ? { type: "buffered" } : { type: "pass" };
  }

  reset() {
    this.buffer = "";
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}
