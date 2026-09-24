export const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export const DEFAULT_AUTO_LOCK_MINUTES = Number(import.meta.env.VITE_AUTO_LOCK_MINUTES) || 10;

/** `?demo=1` or VITE_DEMO=1 turns on the built-in mock backend (and the demo banner). */
export function demoRequested(): boolean {
  if (import.meta.env.VITE_DEMO === "1") return true;
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("demo") === "1";
}

/** `?dev=1` shows the simulate-scan box; it's also always on in `pnpm dev`. */
export function devToolsEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("dev") === "1";
}
