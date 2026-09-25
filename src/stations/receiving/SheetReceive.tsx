import { BigButton, cn } from "@invai/ui";
import { ArrowRight, Layers, PackageCheck, Truck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { submit } from "../../app/actions";
import { useApp } from "../../app/store";
import { ResultPanel } from "../../components/ResultPanel";
import { invalidateQueues } from "../../hooks/useStationQueue";
import { transferIdOf } from "../../lib/codes";
import { feedback } from "../../lib/feedback";
import { kvGet, kvSet } from "../../outbox/db";
import { useScan } from "../../scanner/useWedgeScanner";
import { Prompt } from "../common";
import { type GangSheet, receivingApi } from "./api";
import { findSheetByCode } from "./logic";
import { type Flash, FlashBar, ListFooter, usePendingReceiving } from "./shared";
import { useCachedList } from "./useCachedList";

type Done = { name: string; queued: boolean };

/** Vendor transfers arrived: find the sheet (tap it, or scan any transfer on it) and mark it received. */
export function SheetReceive() {
  const { t, i18n } = useTranslation();
  const kind = useApp((s) => s.api.kind);
  const token = useApp((s) => s.session?.sessionToken ?? null);
  const stationKey = useApp((s) => (s.station?.demo ? "demo" : (s.station?.token ?? "none")));
  const api = receivingApi(kind);
  const list = useCachedList("sheets", (tk) => api.arrivingSheets(tk));
  const pending = usePendingReceiving(list.refetch);
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const inFlight = useRef(false);
  /** sheetId -> transfer ids, fetched on the first transfer scan and saved for offline use. */
  const transfers = useRef(new Map<string, Set<string>>());

  const sheets = useMemo(() => {
    const waiting = new Set(pending.flatMap((a) => (a.op === "sheetReceived" ? [a.sheetId] : [])));
    return list.items.filter((s) => !waiting.has(s.id));
  }, [list.items, pending]);
  const sheet = sheets.find((s) => s.id === selected) ?? null;

  async function transferIndex(): Promise<Map<string, Set<string>>> {
    const key = `receiving:${stationKey}:sheetTransfers`;
    const map = transfers.current;
    const missing = sheets.filter((s) => !map.has(s.id));
    if (missing.length && token) {
      const saved = (await kvGet<Record<string, string[]>>(key)) ?? {};
      await Promise.all(
        missing.map(async (s) => {
          try {
            map.set(s.id, new Set(await api.sheetTransferIds(token, s.id)));
          } catch {
            if (saved[s.id]) map.set(s.id, new Set(saved[s.id]));
          }
        }),
      );
      const out: Record<string, string[]> = {};
      for (const s of sheets) {
        const ids = map.get(s.id);
        if (ids) out[s.id] = [...ids];
      }
      await kvSet(key, out);
    }
    return map;
  }

  useScan((code) => {
    if (busy) return;
    setDone(null);
    if (!list.loaded) {
      // The list isn't here yet; don't call a real code unknown.
      feedback("warn");
      setFlash({
        tone: "warn",
        text: t(list.loading ? "floor.common.loading" : "floor.receiving.noList"),
      });
      return;
    }
    const direct = findSheetByCode(sheets, code);
    if (direct) {
      feedback("tick");
      setSelected(direct.id);
      setFlash(null);
      return;
    }
    const id = transferIdOf(code);
    setFlash({ tone: "ok", text: t("floor.receiving.sheetLooking") });
    void transferIndex().then((map) => {
      const hit = sheets.find((s) => map.get(s.id)?.has(id));
      if (!hit) {
        feedback("error");
        setFlash({ tone: "blocked", text: t("floor.receiving.sheetUnknown") });
        return;
      }
      feedback("tick");
      setSelected(hit.id);
      setFlash(null);
    });
  });

  async function markReceived(s: GangSheet) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await submit({
        kind: "receiving",
        action: { op: "sheetReceived", sheetId: s.id, label: s.name },
      });
      if (outcome.status === "failed") {
        feedback("error");
        setFlash({
          tone: "blocked",
          text: t("floor.receiving.notSaved", { reason: outcome.message }),
        });
        return;
      }
      if (outcome.status === "sent") {
        list.update((items) => items.filter((x) => x.id !== s.id));
        invalidateQueues(); // its transfers are now at the press
      }
      feedback(outcome.status === "sent" ? "ok" : "warn");
      setDone({ name: s.name, queued: outcome.status === "queued" });
      setSelected(null);
      setFlash(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="absolute inset-0 z-20">
        <ResultPanel
          tone={done.queued ? "warn" : "ok"}
          title={done.queued ? t("floor.local.queued") : t("floor.receiving.doneTitle")}
          reason={t("floor.receiving.sheetReceived", { name: done.name })}
          actions={
            <BigButton
              autoFocus
              variant="outline"
              className="h-24 flex-1 border-current bg-transparent text-3xl"
              onClick={() => setDone(null)}
            >
              {t("floor.common.next")} <ArrowRight />
            </BigButton>
          }
        >
          <p className="text-3xl font-semibold">
            {done.queued ? t("floor.receiving.queued") : t("floor.receiving.sheetReady")}
          </p>
        </ResultPanel>
      </div>
    );
  }

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-[1.7] flex-col">
        <FlashBar flash={flash} />
        {!sheet ? (
          <Prompt icon={Layers} title={t("floor.receiving.sheetScanHint")} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
            <Truck className="size-32 text-primary" aria-hidden />
            <p className="text-5xl font-black" data-testid="sheet-question">
              {t("floor.receiving.sheetArrived", { name: sheet.name })}
            </p>
            <p className="text-2xl text-muted-foreground">
              {sheet.vendorName ?? ""} ·{" "}
              {t("floor.receiving.transfers", { count: sheet.transferCount })}
              {sheet.tracking ? ` · ${sheet.tracking.carrier} ${sheet.tracking.code}` : ""}
            </p>
            <div className="flex w-full max-w-3xl gap-4">
              <BigButton variant="outline" className="flex-1" onClick={() => setSelected(null)}>
                {t("floor.common.cancel")}
              </BigButton>
              <BigButton
                variant="success"
                className="h-24 flex-[2] text-3xl"
                disabled={busy}
                onClick={() => void markReceived(sheet)}
                data-testid="sheet-receive"
              >
                <PackageCheck /> {t("floor.receiving.markReceived")}
              </BigButton>
            </div>
          </div>
        )}
      </section>
      <aside className="flex w-[34%] min-w-80 flex-col border-l border-border bg-card">
        <h2 className="px-4 pt-3 text-lg font-bold uppercase text-muted-foreground">
          {t("floor.receiving.tabSheets")}
        </h2>
        <ul className="flex-1 overflow-y-auto">
          {sheets.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                tabIndex={-1}
                data-testid="sheet-row"
                onClick={() => {
                  setSelected(s.id);
                  setFlash(null);
                }}
                className={cn(
                  "flex min-h-20 w-full flex-col justify-center border-b border-border px-4 py-3 text-left",
                  selected === s.id && "bg-accent",
                )}
              >
                <span className="flex w-full items-center justify-between text-2xl font-bold">
                  {s.name}
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-base font-bold",
                      s.status === "shipped" ? "bg-info text-info-foreground" : "bg-muted",
                    )}
                  >
                    {s.status === "shipped"
                      ? t("floor.receiving.shipped")
                      : t("floor.receiving.printed")}
                  </span>
                </span>
                <span className="text-lg text-muted-foreground">
                  {s.vendorName ?? ""} ·{" "}
                  {t("floor.receiving.transfers", { count: s.transferCount })}
                  {s.shippedAt || s.printedAt ? ` · ${fmt(s.shippedAt ?? s.printedAt)}` : ""}
                </span>
              </button>
            </li>
          ))}
          {sheets.length === 0 && list.loaded && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.receiving.sheetEmpty")}
            </li>
          )}
          {!list.loaded && list.error && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.receiving.loadError")}
            </li>
          )}
        </ul>
        <ListFooter list={list} />
      </aside>
    </div>
  );
}
