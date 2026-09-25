import type { TFunction } from "i18next";
import type { MismatchReason, QueueItem, ScanResult } from "../api/types";
import { parseCode } from "../lib/codes";

export type ResultTone = "ok" | "blocked" | "warn";

/** What the full-screen result panel shows; strings are i18n keys, filled in by the screen. */
export type ResultView = {
  tone: ResultTone;
  /** `mismatch.<reason>` / `local.*` / `error.*` key for the big reason line, null when OK. */
  reasonKey: string | null;
  /** Extra detail, already translated (never the server's English text). */
  message: string | null;
  orderNo: string | null;
  designName: string | null;
  expected: string | null;
  scanned: string | null;
  placement: string | null;
  binCode: string | null;
  isReprint: boolean;
  orderOpenUnits: number | null;
  /** Decided on the tablet while offline; the server confirms on replay. */
  provisional: boolean;
  /** Waiting in the outbox, not yet checked by anyone. */
  queued: boolean;
};

type BlankLike = { brand: string; style: string; color: string; size: string };

export function blankLabel(b: BlankLike | null | undefined): string | null {
  if (!b) return null;
  return `${b.brand} ${b.style} · ${b.color} · ${b.size}`;
}

const EMPTY: Omit<ResultView, "tone"> = {
  reasonKey: null,
  message: null,
  orderNo: null,
  designName: null,
  expected: null,
  scanned: null,
  placement: null,
  binCode: null,
  isReprint: false,
  orderOpenUnits: null,
  provisional: false,
  queued: false,
};

export function viewFromResult(r: ScanResult): ResultView {
  return {
    tone: r.ok ? "ok" : "blocked",
    reasonKey: r.ok ? null : `mismatch.${r.mismatch ?? "unknown"}`,
    // The server's `message` is English; the reason and needs/scanned lines say it in both.
    message: null,
    orderNo: r.orderNo,
    designName: r.design?.name ?? null,
    expected: blankLabel(r.expected),
    scanned: blankLabel(r.scannedBlank),
    placement: r.placement,
    binCode: r.binCode,
    isReprint: r.isReprint,
    orderOpenUnits: r.orderOpenUnits,
    provisional: false,
    queued: false,
  };
}

export function viewFromPreview(p: QueueItem | null): Partial<ResultView> {
  if (!p) return {};
  return {
    orderNo: p.orderNo,
    designName: p.design.name,
    expected: blankLabel(p.blank),
    placement: p.placement,
    binCode: p.binCode,
    isReprint: p.isReprint,
  };
}

/**
 * The offline press check: compare the scanned blank label with the blank the cached queue
 * says this transfer needs. Only `B:<variantId>` labels can be checked here; anything else
 * (a UPC, a tote) waits for the server.
 */
export function localPressCheck(
  preview: QueueItem | null,
  blankCode: string,
  knownBlanks: QueueItem["blank"][] = [],
): ResultView {
  const base = { ...EMPTY, ...viewFromPreview(preview), provisional: true, queued: true };
  const code = parseCode(blankCode);
  if (!preview || code.kind !== "blank" || !/^[0-9a-f-]{36}$/i.test(code.value)) {
    return { ...base, tone: "warn", reasonKey: "local.cannot_verify" };
  }
  if (code.value === preview.blank.variantId) return { ...base, tone: "ok" };
  const scanned = knownBlanks.find((b) => b.variantId === code.value) ?? null;
  let reason: MismatchReason | "wrong_blank" = "wrong_blank";
  if (scanned) {
    if (scanned.style !== preview.blank.style) reason = "wrong_style";
    else if (scanned.color !== preview.blank.color) reason = "wrong_color";
    else if (scanned.size !== preview.blank.size) reason = "wrong_size";
  }
  return {
    ...base,
    tone: "blocked",
    reasonKey: reason === "wrong_blank" ? "local.wrong_blank" : `mismatch.${reason}`,
    scanned: blankLabel(scanned),
  };
}

export function queuedView(preview: QueueItem | null): ResultView {
  return {
    ...EMPTY,
    ...viewFromPreview(preview),
    tone: "warn",
    reasonKey: "local.queued",
    queued: true,
  };
}

export function errorView(reasonKey: string, message: string | null): ResultView {
  return { ...EMPTY, tone: "blocked", reasonKey, message };
}

/**
 * A server refusal in the reader's language, from its code: "The server refused it: this
 * person isn't allowed to do this". The server's own message is English, so it is never shown.
 */
export function refusalText(t: TFunction, code: string | null | undefined): string {
  const error = t(`floor.outbox.code.${code}`, {
    defaultValue: t("floor.outbox.code.other", { code: code || "?" }),
  });
  return t("floor.outbox.reason.rejected", { error });
}
