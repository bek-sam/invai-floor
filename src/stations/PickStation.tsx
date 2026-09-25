import { BigButton, cn } from "@invai/ui";
import { ArrowRight, Box, ScanBarcode } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueueItem, ScanResult } from "../api/types";
import { submit } from "../app/actions";
import { useApp, useSession } from "../app/store";
import { ResultPanel } from "../components/ResultPanel";
import { invalidateQueues, useStationQueue } from "../hooks/useStationQueue";
import { parseCode } from "../lib/codes";
import { feedback } from "../lib/feedback";
import { uuid } from "../lib/uuid";
import { refusalText } from "../scan/result";
import { useScan } from "../scanner/useWedgeScanner";
import { Badges, QueueFooter } from "./common";

type Group = { key: string; blank: QueueItem["blank"]; items: QueueItem[]; shelf: string | null };

type PickView =
  | {
      phase: "list";
      selected: string | null;
      message: { tone: "warn" | "blocked"; text: string } | null;
    }
  | { phase: "tote"; item: QueueItem; queued: boolean }
  | { phase: "done"; item: QueueItem; bin: string | null; error: string | null };

/** Pick: blanks grouped by style/color/size. Scan a blank label, then a tote for that order. */
export function PickStation() {
  const { t } = useTranslation();
  const session = useSession();
  const api = useApp((s) => s.api);
  const queue = useStationQueue("pick");
  const [view, setView] = useState<PickView>({ phase: "list", selected: null, message: null });

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const item of queue.items) {
      const key = item.blank.variantId;
      const g = map.get(key) ?? { key, blank: item.blank, items: [], shelf: api.shelfOf(key) };
      g.items.push(item);
      map.set(key, g);
    }
    return [...map.values()].sort(
      (a, b) =>
        a.blank.style.localeCompare(b.blank.style) ||
        a.blank.color.localeCompare(b.blank.color) ||
        a.blank.size.localeCompare(b.blank.size),
    );
  }, [queue.items, api]);

  async function pick(group: Group, blankCode: string) {
    const item = group.items[0];
    if (!item) return;
    const outcome = await submit({
      kind: "scan",
      input: {
        clientScanId: uuid(),
        station: "pick",
        stationId: session.station.id,
        transferCode: item.transferId ?? item.orderItemId,
        blankCode,
        scannedAt: new Date().toISOString(),
      },
    });
    const result = outcome.status === "sent" ? (outcome.result as ScanResult) : null;
    if (outcome.status === "failed" || (result && !result.ok)) {
      feedback("error");
      const text = result?.mismatch
        ? t(`floor.mismatch.${result.mismatch}`)
        : outcome.status === "failed"
          ? refusalText(t, outcome.entry.errorCode)
          : "";
      setView({ phase: "list", selected: group.key, message: { tone: "blocked", text } });
      return;
    }
    feedback("ok");
    if (item.binCode) setView({ phase: "done", item, bin: item.binCode, error: null });
    else setView({ phase: "tote", item, queued: outcome.status === "queued" });
    invalidateQueues();
  }

  async function assignTote(item: QueueItem, code: string) {
    const outcome = await submit({ kind: "assignBin", code, orderId: item.orderId });
    if (outcome.status === "failed") {
      feedback("error");
      setView({ phase: "done", item, bin: null, error: refusalText(t, outcome.entry.errorCode) });
      return;
    }
    feedback("ok");
    setView({ phase: "done", item, bin: code, error: null });
    invalidateQueues();
  }

  useScan((code) => {
    const parsed = parseCode(code);
    if (view.phase === "tote") {
      if (parsed.kind === "bin") void assignTote(view.item, parsed.value);
      else feedback("warn");
      return;
    }
    if (parsed.kind === "bin") {
      feedback("warn");
      setView({
        phase: "list",
        selected: null,
        message: { tone: "warn", text: t("floor.pick.scanHint") },
      });
      return;
    }
    const group = groups.find((g) => g.key === parsed.value);
    if (!group) {
      feedback("error");
      setView({
        phase: "list",
        selected: null,
        message: { tone: "blocked", text: t("floor.pick.noMatch") },
      });
      return;
    }
    void pick(group, code);
  });

  const selected = view.phase === "list" ? view.selected : null;
  const left = queue.items.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <p className="flex items-center gap-3 text-2xl font-semibold">
          <ScanBarcode className="size-8 text-primary" /> {t("floor.pick.scanHint")}
        </p>
        <span className="text-xl text-muted-foreground">
          {t("floor.pick.left", { count: left })}
        </span>
      </div>
      {view.phase === "list" && view.message && (
        <p
          role="alert"
          className={cn(
            "px-6 py-3 text-2xl font-bold",
            view.message.tone === "blocked"
              ? "bg-danger text-danger-foreground"
              : "bg-warning text-warning-foreground",
          )}
        >
          {view.message.text}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-card text-sm uppercase text-muted-foreground">
            <tr>
              <th className="px-6 py-2">{t("floor.pick.location")}</th>
              <th className="px-2 py-2">{t("floor.common.blank")}</th>
              <th className="px-2 py-2 text-center">#</th>
              <th className="px-6 py-2">{t("floor.common.order")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.key}
                onClick={() => setView({ phase: "list", selected: g.key, message: null })}
                className={cn(
                  "border-b border-border text-2xl",
                  selected === g.key && "bg-accent outline outline-2 outline-primary",
                )}
              >
                <td className="px-6 py-4 font-mono font-bold">{g.shelf ?? "—"}</td>
                <td className="px-2 py-4">
                  <span className="mr-2 rounded-lg bg-foreground px-3 py-1 font-black text-background">
                    {g.blank.size}
                  </span>
                  <span className="font-bold">{g.blank.color}</span>
                  <span className="ml-2 text-lg text-muted-foreground">
                    {g.blank.brand} {g.blank.style}
                  </span>
                </td>
                <td className="px-2 py-4 text-center text-4xl font-black">{g.items.length}</td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-2 text-lg">
                    {g.items.map((i) => (
                      <span
                        key={i.orderItemId}
                        className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5"
                      >
                        {i.orderNo}
                        {i.binCode && <span className="text-muted-foreground">→ {i.binCode}</span>}
                        <Badges item={i} />
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {groups.length === 0 && !queue.loading && (
              <tr>
                <td colSpan={4} className="p-10 text-center text-2xl text-muted-foreground">
                  {t("floor.common.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueueFooter queue={queue} />

      {view.phase === "tote" && (
        <div className="absolute inset-0 z-20">
          <ResultPanel
            tone="ok"
            title={t("floor.pick.picked")}
            reason={t("floor.pick.toteHint", { orderNo: view.item.orderNo })}
          >
            <Box className="size-24" aria-hidden />
            {view.queued && <p className="text-2xl">{t("floor.press.queued")}</p>}
            <BigButton
              variant="outline"
              className="mt-4 max-w-md border-current bg-transparent"
              onClick={() => setView({ phase: "list", selected: null, message: null })}
            >
              {t("floor.pick.skipTote")}
            </BigButton>
          </ResultPanel>
        </div>
      )}
      {view.phase === "done" && (
        <div className="absolute inset-0 z-20">
          <ResultPanel
            tone={view.error ? "blocked" : "ok"}
            title={view.error ? t("floor.error.rejected") : t("floor.pick.picked")}
            reason={
              view.error ??
              (view.bin
                ? t("floor.pick.useTote", { bin: view.bin })
                : t("floor.pick.toteAssigned", { orderNo: view.item.orderNo, bin: "—" }))
            }
            actions={
              <BigButton
                autoFocus
                className="h-24 bg-background text-3xl text-foreground hover:bg-background/90"
                onClick={() => setView({ phase: "list", selected: null, message: null })}
              >
                {t("floor.common.next")} <ArrowRight />
              </BigButton>
            }
          >
            <p className="text-4xl font-bold">
              {view.item.orderNo} · {view.item.blank.size} {view.item.blank.color}
            </p>
          </ResultPanel>
        </div>
      )}
    </div>
  );
}
