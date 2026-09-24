import { useEffect, useRef } from "react";

/**
 * USB/Bluetooth barcode scanners act as keyboards. A scan is a burst of keys arriving
 * less than `maxGapMs` apart and ending with Enter; people typing are much slower.
 */
export function useWedgeScanner(
  onScan: (code: string) => void,
  { maxGapMs = 30, minLength = 4 } = {},
) {
  const buffer = useRef("");
  const lastAt = useRef(0);
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const now = performance.now();
      if (now - lastAt.current > maxGapMs) buffer.current = "";
      lastAt.current = now;

      if (e.key === "Enter") {
        if (buffer.current.length >= minLength) {
          e.preventDefault();
          handler.current(buffer.current);
        }
        buffer.current = "";
        return;
      }
      if (e.key.length === 1 && !e.repeat) buffer.current += e.key;
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maxGapMs, minLength]);
}
