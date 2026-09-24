/**
 * How the outbox and screens react to a failure:
 * - `offline`: no network or the API is down; keep the work queued and retry.
 * - `unavailable`: the procedure exists in the contract but the backend returns
 *   NOT_IMPLEMENTED (or 5xx); keep queued and retry later.
 * - `auth`: the floor session expired or was revoked; ask for the PIN again.
 * - `rejected`: the server refused this specific request (4xx); retrying won't help.
 */
export type FailureKind = "offline" | "unavailable" | "auth" | "rejected";

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
    return this.kind === "offline" || this.kind === "unavailable";
  }
}

export function classifyStatus(status: number | undefined, code: string): FailureKind {
  if (code === "NOT_IMPLEMENTED" || code === "RATE_LIMITED") return "unavailable";
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
