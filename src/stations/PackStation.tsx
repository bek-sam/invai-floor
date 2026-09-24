import { BigButton, cn, Dialog, DialogContent, DialogTitle } from "@invai/ui";
import { ArrowRight, CheckCircle2, Circle, PackageCheck, Printer, ScanBarcode } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueueItem, ScanResult } from "../api/types";
import { submit } from "../app/actions";
import { useApp, useSession } from "../app/store";
import { ResultPanel } from "../components/ResultPanel";
import { Thumbnail } from "../components/Thumbnail";
import { invalidateQueues, useStationQueue } from "../hooks/useStationQueue";
import { parseCode, transferIdOf } from "../lib/codes";
import { feedback } from "../lib/feedback";
import { uuid } from "../lib/uuid";
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

type Flash = { tone: "ok" | "warn" | "blocked"; text: string } | null;

/** Pack: scan the tote or items until the order is complete, then mark it packed and print the label. */
export function PackStation() {
  const { t } = useTranslation();
  const session = useSession();
  const api = useApp((s) => s.api);
  const queue = useStationQueue("pack");
  const [active, setActive] = useState<Active | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [packed, setPacked] = useState<{
    orderId: string;
    orderNo: string;
    label: string | null | "loading";
  } | null>(null);

  const orders = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    for (const i of queue.items) map.set(i.orderId, [...(map.get(i.orderId) ?? []), i]);
    return map;
  }, [queue.items]);

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
    setPacked(null);
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
    });
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
          ? outcome.message
          : "";
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
    if (confirmMissing) return;
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
      start(item.orderId);
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
    if (a) void scanItem(a, item, code);
  });

  const total = active ? active.items.length + active.elsewhere : 0;
  const done = active?.scanned.size ?? 0;
  const missing = active ? active.items.filter((i) => !active.scanned.has(i.orderItemId)) : [];
  const complete = active !== null && done === total;

  useEffect(() => {
    if (complete) feedback("ok");
  }, [complete]);

  async function finish() {
    if (!active) return;
    setConfirmMissing(false);
    const { orderId, orderNo, binCode } = active;
    if (binCode) await submit({ kind: "releaseBin", code: binCode });
    setActive(null);
    setFlash(null);
    setPacked({ orderId, orderNo, label: "loading" });
    invalidateQueues();
    const label = await api.orderLabelUrl(session.sessionToken, orderId).catch(() => null);
    setPacked((p) => (p && p.orderId === orderId ? { ...p, label } : p));
  }

  if (packed) {
    return (
      <div className="absolute inset-0 z-20">
        <ResultPanel
          tone="ok"
          title={t("floor.pack.packed", { orderNo: packed.orderNo })}
          actions={
            <>
              {packed.label && packed.label !== "loading" && (
                <BigButton
                  className="h-24 flex-1 bg-background text-3xl text-foreground hover:bg-background/90"
                  onClick={() => window.open(packed.label as string, "_blank", "noopener")}
                >
                  <Printer /> {t("floor.pack.printLabel")}
                </BigButton>
              )}
              <BigButton
                autoFocus
                variant="outline"
                className="h-24 flex-1 border-current bg-transparent text-3xl"
                onClick={() => setPacked(null)}
              >
                {t("floor.common.next")} <ArrowRight />
              </BigButton>
            </>
          }
        >
          {packed.label === null && <p className="text-2xl">{t("floor.pack.noLabel")}</p>}
        </ResultPanel>
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
                {t("floor.pack.progress", { done, total })}
              </p>
            </div>
            <div className="h-4 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-success transition-all"
                style={{ width: `${total ? (done / total) * 100 : 0}%` }}
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
              <BigButton variant="outline" className="flex-1" onClick={() => setActive(null)}>
                {t("floor.common.cancel")}
              </BigButton>
              <BigButton
                variant={complete ? "success" : "default"}
                className="h-24 flex-[2] text-3xl"
                onClick={() => (complete ? void finish() : setConfirmMissing(true))}
                disabled={done === 0}
              >
                <PackageCheck /> {t("floor.pack.markPacked")}
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
      <Dialog open={confirmMissing} onOpenChange={setConfirmMissing}>
        <DialogContent className="max-w-2xl p-8">
          <DialogTitle className="text-3xl">{t("floor.pack.missing")}</DialogTitle>
          <p className="text-2xl">
            {t("floor.pack.missingWarn", { count: missing.length + (active?.elsewhere ?? 0) })}
          </p>
          <ul className="text-xl text-muted-foreground">
            {missing.map((i) => (
              <li key={i.orderItemId}>
                {i.design.name} · {i.blank.size} {i.blank.color}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-4">
            <BigButton variant="outline" onClick={() => setConfirmMissing(false)}>
              {t("floor.common.cancel")}
            </BigButton>
            <BigButton variant="destructive" onClick={() => void finish()}>
              {t("floor.pack.packAnyway")}
            </BigButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
