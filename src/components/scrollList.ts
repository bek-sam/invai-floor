/**
 * Props for a scrolling list or panel so a keyboard user can reach and scroll it (axe
 * `scrollable-region-focusable`). Rows stay `tabIndex={-1}` on purpose: a stray Enter from the
 * scanner must never press a row. The scanner listener is on the window and ignores only text
 * fields, so a focused list still receives scans and never takes them.
 */
export const SCROLL_FOCUS =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ring";

export function scrollFocus(label: string) {
  return { tabIndex: 0, "aria-label": label } as const;
}
