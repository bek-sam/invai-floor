/**
 * How the outbox and screens react to a failure:
 * - `offline`: no network or the API is down; keep the work queued and retry.
 * - `unavailable`: the procedure exists in the contract but the backend returns
 *   NOT_IMPLEMENTED (or 5xx, or a timeout); keep queued and retry later.
 * - `busy`: the server is reachable and refused only because this company is over its rate
 *   limit (429 RATE_LIMITED). The server says how long to wait (`retryAfterSec`); never "offline"
 *   wording, and it never counts toward `MAX_ATTEMPTS` parking (T-P3-2, B-237).
 * - `auth`: the floor session expired or was revoked; ask for the PIN again.
 * - `rejected`: the server refused this specific request (4xx); retrying won't help.
 * - `tooOld`: the server refuses this app version (CLIENT_TOO_OLD, 426). Nothing is retried or
 *   parked; the tablet shows "Update needed" and the outbox waits for the new version (T-13-1).
 */
export type FailureKind = "offline" | "unavailable" | "busy" | "auth" | "rejected" | "tooOld";

export class ApiFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }

  get retryable() {
    return this.kind === "offline" || this.kind === "unavailable" || this.kind === "busy";
  }

  /** How many seconds the server asked us to wait (RATE_LIMITED's `data.retryAfterSec`), for a
   * `busy` failure only. Null when the server didn't say (fall back to a short fixed wait). */
  get retryAfterSec(): number | null {
    if (this.kind !== "busy") return null;
    const n = (this.data as { retryAfterSec?: unknown } | null | undefined)?.retryAfterSec;
    return typeof n === "number" && n > 0 ? n : null;
  }
}

export function classifyStatus(status: number | undefined, code: string): FailureKind {
  if (code === "RATE_LIMITED") return "busy";
  if (code === "NOT_IMPLEMENTED") return "unavailable";
  if (status === 426 || code === "CLIENT_TOO_OLD") return "tooOld";
  if (status === undefined || status === 0) return "offline";
  if (status === 401 || code === "UNAUTHORIZED") return "auth";
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  return "rejected";
}

export function toFailure(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  const e = err as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    data?: unknown;
    name?: unknown;
  };
  if (err instanceof TypeError || e?.name === "AbortError") {
    return new ApiFailure("offline", "NETWORK", String(e.message ?? "Network error"));
  }
  const code = typeof e?.code === "string" ? e.code : "UNKNOWN";
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);
  return new ApiFailure(classifyStatus(status, code), code, message, status, e?.data);
}
