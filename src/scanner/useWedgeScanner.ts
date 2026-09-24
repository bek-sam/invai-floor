import { useEffect, useRef } from "react";
import { emitScan, type ScanHandler, subscribeScans } from "./bus";
import { WedgeDetector, type WedgeOptions } from "./wedge";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Listens to the whole window for scanner bursts and forwards them to the scan bus. Mount
 * once at the app root. Keys typed into text fields are left alone (those fields handle
 * their own Enter). A detected scan swallows its Enter so it can't click a focused button.
 */
export function useWedgeListener(options: WedgeOptions = {}) {
  const { maxGapMs, maxEnterGapMs, minLength } = options;
  useEffect(() => {
    const detector = new WedgeDetector({ maxGapMs, maxEnterGapMs, minLength });
    function onKeyDown(e: KeyboardEvent) {
      if (isEditable(e.target)) {
        detector.reset();
        return;
      }
      const verdict = detector.key(e, performance.now());
      if (verdict.type === "scan") {
        e.preventDefault();
        e.stopPropagation();
        emitScan(verdict.code, "wedge");
      } else if (verdict.type === "buffered" && e.key === " ") {
        e.preventDefault(); // a space inside a scan must not press a focused button
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [maxGapMs, maxEnterGapMs, minLength]);
}

/** Receive scans while this component is the top-most scan consumer. */
export function useScan(onScan: ScanHandler, enabled = true) {
  const handler = useRef(onScan);
  handler.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    return subscribeScans((code, source) => handler.current(code, source));
  }, [enabled]);
}
