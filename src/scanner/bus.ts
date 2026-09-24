export type ScanSource = "wedge" | "simulate" | "camera";
export type ScanHandler = (code: string, source: ScanSource) => void;

/**
 * Only the top-most subscriber gets scans, so an open dialog (e.g. the QC fail reasons) can
 * take over from the station screen underneath it.
 */
const stack: ScanHandler[] = [];

export function subscribeScans(handler: ScanHandler): () => void {
  stack.push(handler);
  return () => {
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function emitScan(code: string, source: ScanSource = "wedge") {
  const trimmed = code.trim();
  if (!trimmed) return;
  stack[stack.length - 1]?.(trimmed, source);
}
