/**
 * Build-time CSP helpers (T-12-5, B-24, review r1): derive the API origin from `VITE_API_URL` so
 * the production `connect-src` pins the real origin the app actually calls, instead of a broad
 * `https:` that would let a stored-XSS bug exfiltrate to any HTTPS host. Shared between
 * `vite.config.ts` (the dev-preview headers) and `scripts/render-nginx-conf.ts` (the static
 * `nginx.conf` header) so both derive the same value from the same source, the same way.
 */

/**
 * `raw` is `process.env.VITE_API_URL` -- `undefined` means the variable was never set (the bug
 * this review found: a silent fallback to a broad CSP). `""` is a deliberate, valid choice (a
 * same-origin deployment, e.g. behind a reverse proxy) and is not an error.
 */
export function requireApiOrigin(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error(
      "VITE_API_URL must be set to build for production: the CSP's connect-src is derived " +
        "from it so it can pin the real API origin instead of a broad 'https:'. Set it to " +
        'the API\'s origin (e.g. "https://api.example.com"), or to "" for a same-origin ' +
        "deployment.",
    );
  }
  return raw === "" ? "" : new URL(raw).origin;
}

/**
 * `'self'` plus the API origin when it's cross-origin. SSE rides the same origin/path as RPC
 * calls (both `EventSource` and `fetch` are governed by `connect-src`), so no extra host is
 * needed for it.
 */
export function connectSrc(apiOrigin: string): string {
  return apiOrigin ? `'self' ${apiOrigin}` : "'self'";
}
