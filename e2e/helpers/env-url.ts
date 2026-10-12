/** Reads a URL env var. Unset, empty or spaces-only falls back; a set, invalid value fails loudly with the variable name. */
export function envUrl(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Origin (scheme + host + port) of an env URL, for the Origin header. */
export function envOrigin(name: string, fallback: string): string {
  return new URL(envUrl(name, fallback)).origin;
}
