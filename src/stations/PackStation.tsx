import { BigButton, cn, Dialog, DialogContent, DialogTitle, Textarea } from "@invai/ui";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  PackageCheck,
  Printer,
  RotateCw,
  ScanBarcode,
  UserRoundCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PackOrderResult, QueueItem, ScanResult } from "../api/types";
import { submit } from "../app/actions";
import { useApp, useSession } from "../app/store";
import { ResultPanel } from "../components/ResultPanel";
import { Thumbnail } from "../components/Thumbnail";
import { findCachedItem, invalidateQueues, useStationQueue } from "../hooks/useStationQueue";
import { parseCode, transferIdOf } from "../lib/codes";
import { feedback } from "../lib/feedback";
import { uuid } from "../lib/uuid";
import { kvDelete, kvGet, kvSet } from "../outbox/db";
import { refusalText } from "../scan/result";
import { useScan } from "../scanner/useWedgeScanner";
import { BlankChips, Prompt, QueueFooter } from "./common";

type Active = {
  orderId: string;
  orderNo: string;
  binCode: string | null;
  items: QueueItem[];
  /** Units of the order that aren't at the pack station yet (still pressing, QC...). */
  elsewhere: number;
  scanned: Set<string>;
};

/** A unit the server says isn't packed yet, with what this tablet knows about it. */
type MissingRow = {
  orderItemId: string;
  state: string;
  design: string | null;
  blank: string | null;
};

type Done =
  | { kind: "packed"; orderId: string; orderNo: string; label: string | null | "loading" }
  | { kind: "handed"; orderId: string; orderNo: string }
  | { kind: "queued"; orderId: string; orderNo: string };

type Flash = { tone: "ok" | "warn" | "blocked"; text: string } | null;

/** Pack progress is saved on the tablet, so a reload or a crash mid-order loses nothing. */
const PROGRESS_KEY = "packProgress";
type SavedProgress = Omit<Active, "scanned"> & { scanned: string[] };

function saveProgress(a: Active | null) {
  if (!a) return kvDelete(PROGRESS_KEY);
  const saved: SavedProgress = { ...a, scanned: [...a.scanned] };
  return kvSet(PROGRESS_KEY, saved);
}

async function loadProgress(): Promise<Active | null> {
  const saved = await kvGet<SavedProgress>(PROGRESS_KEY).catch(() => undefined);
  if (!saved?.orderId || !Array.isArray(saved.items)) return null;
  return { ...saved, scanned: new Set(saved.scanned ?? []) };
}

/**
 * Pack: scan the tote or items, then "Mark packed". The server checks that every unit of the
 * order is packed (decision 0002); when units are missing it blocks and lists them. A lead can
 * hand a short order over instead (decision 0010): it is not packed and doesn't ship.
 */
export function PackStation() {
  const { t } = useTranslation();
  const session = useSession();
  const api = useApp((s) => s.api);
  const queue = useStationQueue("pack");
  const [active, setActive] = useState<Active | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [checking, setChecking] = useState(false);
  const [missing, setMissing] = useState<MissingRow[] | null>(null);
  const [handOpen, setHandOpen] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const restored = useRef(false);
  const canHandOver = session.permissions.includes("production.override");

  const orders = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    for (const i of queue.items) map.set(i.orderId, [...(map.get(i.orderId) ?? []), i]);
    return map;
  }, [queue.items]);

  // Pick up an order that was in progress before a reload.
  useEffect(() => {
    if (restored.current) return;
    void loadProgress().then((saved) => {
      restored.current = true;
      if (!saved) return;
      setActive((cur) => cur ?? saved);
      setFlash({ tone: "ok", text: t("floor.pack.resumed") });
    });
  }, [t]);

  // Every change to the order in progress is saved; finishing or cancelling clears it.
  useEffect(() => {
    if (restored.current) void saveProgress(active);
  }, [active]);

  // Units of this order that reached the pack list since it was started (after a QC pass).
  useEffect(() => {
    const fresh = active ? orders.get(active.orderId) : undefined;
    if (!active || !fresh) return;
    const known = new Set(active.items.map((i) => i.orderItemId));
    const added = fresh.filter((i) => !known.has(i.orderItemId));
    if (!added.length) return;
    setActive((cur) =>
      cur && cur.orderId === active.orderId
        ? {
            ...cur,
            items: [...cur.items, ...added],
            elsewhere: Math.max(0, cur.elsewhere - added.length),
          }
        : cur,
    );
  }, [orders, active]);

  function start(orderId: string): Active | null {
    const items = orders.get(orderId);
    const first = items?.[0];
    if (!items || !first) return null;
    const a: Active = {
      orderId,
      orderNo: first.orderNo,
      binCode: items.find((i) => i.binCode)?.binCode ?? null,
      items,
      elsewhere: Math.max(0, first.orderOpenUnits - items.length),
      scanned: new Set(),
    };
    setActive(a);
    setDone(null);
    setMissing(null);
    return a;
  }

  async function scanItem(a: Active, item: QueueItem, code: string) {
    if (a.scanned.has(item.orderItemId)) {
      feedback("warn");
      setFlash({ tone: "warn", text: t("floor.pack.alreadyScanned") });
      return;
    }
    const outcome = await submit({
      kind: "scan",
      input: {
        clientScanId: uuid(),
        station: "pack",
        stationId: session.station.id,
        transferCode: code,
        blankCode: a.binCode ? `BIN:${a.binCode}` : null,
        scannedAt: new Date().toISOString(),
      },
    }).catch(() => null);
    if (!outcome) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.error.local") });
      return;
    }
    const result = outcome.status === "sent" ? (outcome.result as ScanResult) : null;
    const accepted =
      outcome.status === "queued" ||
      (result?.ok ?? false) ||
      result?.mismatch === "already_processed";
    if (!accepted) {
      feedback("error");
      const text = result?.mismatch
        ? t(`floor.mismatch.${result.mismatch}`)
        : outcome.status === "failed"
          ? refusalText(t, outcome.entry.errorCode)
          : t("floor.mismatch.unknown");
      setFlash({ tone: "blocked", text });
      return;
    }
    feedback("ok");
    setFlash({ tone: "ok", text: `${item.orderNo} · ${item.design.name}` });
    setActive((cur) =>
      cur && cur.orderId === a.orderId
        ? { ...cur, scanned: new Set([...cur.scanned, item.orderItemId]) }
        : cur,
    );
  }

  useScan((code) => {
    if (handOpen || checking) return;
    const parsed = parseCode(code);
    if (parsed.kind === "bin") {
      const item = queue.items.find((i) => i.binCode === parsed.value);
      if (!item) {
        feedback("error");
        setFlash({ tone: "blocked", text: t("floor.pack.unknownTote", { bin: parsed.value }) });
        return;
      }
      if (active && active.orderId !== item.orderId && active.scanned.size > 0) {
        feedback("warn");
        setFlash({ tone: "warn", text: t("floor.pack.otherOrder", { orderNo: item.orderNo }) });
        return;
      }
      feedback("tick");
      setFlash(null);
      if (active?.orderId !== item.orderId) start(item.orderId);
      return;
    }
    const id = transferIdOf(code);
    const match = (i: QueueItem) => i.transferId === id || i.orderItemId === id;
    const item = active?.items.find(match) ?? queue.items.find(match);
    if (!item) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.pack.notInOrder") });
      return;
    }
    let a = active;
    if (!a || (a.orderId !== item.orderId && a.scanned.size === 0)) a = start(item.orderId);
    else if (a.orderId !== item.orderId) {
      feedback("warn");
      setFlash({ tone: "warn", text: t("floor.pack.otherOrder", { orderNo: item.orderNo }) });
      return;
    }
    setMissing(null);
    if (a) void scanItem(a, item, code);
  });

  const total = active ? active.items.length + active.elsewhere : 0;
  const scannedCount = active?.scanned.size ?? 0;
  const complete = active !== null && scannedCount === total;

  useEffect(() => {
    if (complete) feedback("ok");
  }, [complete]);

  async function describeMissing(a: Active, rows: PackOrderResult["missing"]) {
    return Promise.all(
      rows.map(async (m): Promise<MissingRow> => {
        const unit =
          a.items.find((i) => i.orderItemId === m.orderItemId) ??
          (await findCachedItem((i) => i.orderItemId === m.orderItemId).catch(() => null));
        return {
          orderItemId: m.orderItemId,
          state: m.state,
          design: unit?.design.name ?? null,
          blank: unit ? `${unit.blank.style} · ${unit.blank.color} · ${unit.blank.size}` : null,
        };
      }),
    );
  }

  /** Mark packed; with a reason, hand the short order to a lead instead. */
  async function finish(handReason?: string) {
    if (!active || checking) return;
    const a = active;
    setHandOpen(false);
    setChecking(true);
    setFlash(null);
    // A new key per tap: a refusal stores nothing, so "Check again" must be a new request.
    const outcome = await submit({
      kind: "packOrder",
      input: {
        orderId: a.orderId,
        idempotencyKey: uuid(),
        ...(handReason ? { override: { reason: handReason } } : {}),
      },
    }).catch(() => null);
    setChecking(false);
    invalidateQueues();

    if (!outcome) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.error.local") });
      return;
    }
    if (outcome.status === "failed") {
      feedback("error");
      const code = outcome.entry.errorCode;
      setFlash({
        tone: "blocked",
        text:
          code === "CONFLICT"
            ? t("floor.pack.cantPack", { orderNo: a.orderNo })
            : refusalText(t, code),
      });
      return;
    }
    const base = { orderId: a.orderId, orderNo: a.orderNo };
    if (outcome.status === "queued") {
      feedback("warn");
      clearOrder();
      setDone({ kind: "queued", ...base });
      return;
    }
    const result = outcome.result as PackOrderResult;
    if (result.packed) {
      feedback("ok");
      clearOrder();
      setDone({ kind: "packed", ...base, label: "loading" });
      const label = await api.orderLabelUrl(session.sessionToken, a.orderId).catch(() => null);
      setDone((d) => (d?.kind === "packed" && d.orderId === a.orderId ? { ...d, label } : d));
      return;
    }
    if (result.override) {
      feedback("warn");
      clearOrder();
      setDone({ kind: "handed", ...base });
      return;
    }
    feedback("error");
    setMissing(await describeMissing(a, result.missing));
  }

  function clearOrder() {
    setActive(null);
    setMissing(null);
    setFlash(null);
  }

  if (done) return <DoneScreen done={done} onNext={() => setDone(null)} />;

  if (active && missing) {
    return (
      <div className="absolute inset-0 z-20">
        <ResultPanel
          tone="blocked"
          title={t("floor.pack.incompleteTitle")}
          reason={t("floor.pack.incomplete", { count: missing.length, orderNo: active.orderNo })}
          actions={
            <>
              <BigButton
                autoFocus
                className="h-24 flex-1 bg-background text-2xl text-foreground hover:bg-background/90"
                onClick={() => setMissing(null)}
              >
                {t("floor.pack.backToOrder")}
              </BigButton>
              <BigButton
                variant="outline"
                className="h-24 flex-1 border-current bg-transparent text-2xl"
                onClick={() => void finish()}
                disabled={checking}
              >
                <RotateCw /> {t("floor.pack.checkAgain")}
              </BigButton>
              {canHandOver && (
                <BigButton
                  variant="outline"
                  className="h-24 flex-1 border-current bg-transparent text-2xl"
                  onClick={() => setHandOpen(true)}
                  disabled={checking}
                >
                  <UserRoundCheck /> {t("floor.pack.handToLead")}
                </BigButton>
              )}
            </>
          }
        >
          <ul className="w-full max-w-3xl text-left text-2xl" data-testid="pack-missing">
            {missing.map((m) => (
              <li
                key={m.orderItemId}
                className="flex items-center justify-between gap-4 border-b border-current/30 py-2"
              >
                <span className="min-w-0 truncate font-semibold">
                  {m.design ?? t("floor.pack.unitNotHere")}
                  {m.blank && <span className="font-normal"> · {m.blank}</span>}
                </span>
                <span className="shrink-0 rounded-lg bg-black/20 px-3 py-1 font-bold">
                  {t(`orderState.${m.state}`, { defaultValue: m.state })}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-2xl">{t("floor.pack.findOrLead")}</p>
        </ResultPanel>
        <HandToLeadDialog
          open={handOpen}
          orderNo={active.orderNo}
          onCancel={() => setHandOpen(false)}
          onConfirm={(reason) => void finish(reason)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-[1.7] flex-col">
        {flash && (
          <p
            role="alert"
            className={cn(
              "px-6 py-3 text-2xl font-bold",
              flash.tone === "ok" && "bg-success text-success-foreground",
              flash.tone === "warn" && "bg-warning text-warning-foreground",
              flash.tone === "blocked" && "bg-danger text-danger-foreground",
            )}
          >
            {flash.text}
          </p>
        )}
        {!active ? (
          <Prompt icon={ScanBarcode} title={t("floor.pack.scanHint")} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-6xl font-black">{active.orderNo}</p>
                {active.binCode && (
                  <p className="text-2xl text-muted-foreground">
                    {t("floor.common.bin")} <b className="text-foreground">{active.binCode}</b>
                  </p>
                )}
              </div>
              <p
                className={cn("text-5xl font-black", complete ? "text-success" : "text-foreground")}
                data-testid="pack-progress"
              >
                {t("floor.pack.progress", { done: scannedCount, total })}
              </p>
            </div>
            <div className="h-4 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-success transition-all"
                style={{ width: `${total ? (scannedCount / total) * 100 : 0}%` }}
              />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {active.items.map((i) => {
                const ok = active.scanned.has(i.orderItemId);
                return (
                  <li
                    key={i.orderItemId}
                    className="flex items-center gap-4 border-b border-border py-3 text-2xl"
                  >
                    {ok ? (
                      <CheckCircle2 className="size-10 text-success" />
                    ) : (
                      <Circle className="size-10 text-muted-foreground" />
                    )}
                    <Thumbnail fileKey={i.artworkPreviewKey} alt="" className="size-16" />
                    <span
                      className={cn(
                        "flex-1 font-semibold",
                        ok && "text-muted-foreground line-through",
                      )}
                    >
                      {i.design.name}
                    </span>
                    <BlankChips blank={i.blank} className="text-xl" />
                  </li>
                );
              })}
              {active.elsewhere > 0 && (
                <li className="flex items-center gap-4 py-3 text-2xl text-warning-foreground">
                  <Circle className="size-10" />{" "}
                  {t("floor.common.units", { count: active.elsewhere })} — {t("floor.pack.missing")}
                </li>
              )}
            </ul>
            <div className="flex gap-4">
              <BigButton
                variant="outline"
                className="flex-1"
                onClick={clearOrder}
                disabled={checking}
              >
                {t("floor.common.cancel")}
              </BigButton>
              <BigButton
                variant={complete ? "success" : "default"}
                className="h-24 flex-[2] text-3xl"
                onClick={() => void finish()}
                disabled={scannedCount === 0 || checking}
              >
                {checking ? (
                  <>
                    <Loader2 className="animate-spin" /> {t("floor.pack.checking")}
                  </>
                ) : (
                  <>
                    <PackageCheck /> {t("floor.pack.markPacked")}
                  </>
                )}
              </BigButton>
            </div>
          </div>
        )}
      </section>
      <aside className="flex w-[34%] min-w-80 flex-col border-l border-border bg-card">
        <h2 className="px-4 pt-3 text-lg font-bold uppercase text-muted-foreground">
          {t("floor.press.queueTitle")}
        </h2>
        <ul className="flex-1 overflow-y-auto">
          {[...orders.entries()].map(([orderId, items]) => (
            <li key={orderId}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => (active?.scanned.size ? undefined : start(orderId))}
                className={cn(
                  "flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-xl",
                  active?.orderId === orderId && "bg-accent",
                )}
              >
                <span className="font-bold">{items[0]?.orderNo}</span>
                <span className="text-muted-foreground">
                  {items.find((i) => i.binCode)?.binCode ?? ""} ·{" "}
                  {t("floor.common.units", { count: items.length })}
                </span>
              </button>
            </li>
          ))}
          {orders.size === 0 && !queue.loading && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.common.empty")}
            </li>
          )}
        </ul>
        <QueueFooter queue={queue} />
      </aside>
    </div>
  );
}

function DoneScreen({ done, onNext }: { done: Done; onNext: () => void }) {
  const { t } = useTranslation();
  const next = (
    <BigButton
      autoFocus
      variant="outline"
      className="h-24 flex-1 border-current bg-transparent text-3xl"
      onClick={onNext}
    >
      {t("floor.common.next")} <ArrowRight />
    </BigButton>
  );
  if (done.kind === "handed") {
    return (
      <div className="absolute inset-0 z-20">
        <ResultPanel
          tone="warn"
          title={t("floor.pack.handed")}
          reason={t("floor.pack.handedOrder", { orderNo: done.orderNo })}
          actions={next}
        >
          <p className="max-w-3xl text-2xl">{t("floor.pack.handedBody")}</p>
        </ResultPanel>
      </div>
    );
  }
  if (done.kind === "queued") {
    return (
      <div className="absolute inset-0 z-20">
        <ResultPanel
          tone="warn"
          title={t("floor.pack.queuedTitle")}
          reason={`${t("floor.common.order")} ${done.orderNo}`}
          actions={next}
        >
          <p className="max-w-3xl text-2xl">{t("floor.pack.queuedBody")}</p>
        </ResultPanel>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-20">
      <ResultPanel
        tone="ok"
        title={t("floor.pack.packed", { orderNo: done.orderNo })}
        actions={
          <>
            {done.label && done.label !== "loading" && (
              <BigButton
                className="h-24 flex-1 bg-background text-3xl text-foreground hover:bg-background/90"
                onClick={() => window.open(done.label as string, "_blank", "noopener")}
              >
                <Printer /> {t("floor.pack.printLabel")}
              </BigButton>
            )}
            {next}
          </>
        }
      >
        {done.label === null && <p className="text-2xl">{t("floor.pack.noLabel")}</p>}
      </ResultPanel>
    </div>
  );
}

/** Owner or admin only: the reason is recorded with the order for the lead who sorts it out. */
function HandToLeadDialog({
  open,
  orderNo,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  orderNo: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  useScan(() => {}, open); // a stray scan must not act on the screen underneath
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const trimmed = reason.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl p-8">
        <DialogTitle className="text-3xl">{t("floor.pack.handTitle", { orderNo })}</DialogTitle>
        <p className="text-2xl">{t("floor.pack.handBody")}</p>
        <label htmlFor="hand-reason" className="text-xl font-semibold">
          {t("floor.pack.handReason")}
        </label>
        <Textarea
          value={reason}
          maxLength={500}
          rows={3}
          className="text-2xl"
          placeholder={t("floor.pack.handReasonPlaceholder")}
          onChange={(e) => setReason(e.target.value)}
          data-testid="hand-reason"
          id="hand-reason"
        />
        <div className="mt-2 flex gap-4">
          <BigButton variant="outline" className="flex-1" onClick={onCancel}>
            {t("floor.common.cancel")}
          </BigButton>
          <BigButton
            variant="destructive"
            className="flex-1"
            disabled={!trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            <UserRoundCheck /> {t("floor.pack.handToLead")}
          </BigButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
