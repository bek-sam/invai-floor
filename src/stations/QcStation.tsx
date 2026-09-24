import { BigButton } from "@invai/ui";
import { ArrowRight, Check, QrCode, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueueItem } from "../api/types";
import { submit } from "../app/actions";
import { useApp } from "../app/store";
import { type FLOOR_REASONS, ReasonDialog } from "../components/ProblemDialog";
import { ResultPanel } from "../components/ResultPanel";
import { Thumbnail } from "../components/Thumbnail";
import { invalidateQueues, useStationQueue } from "../hooks/useStationQueue";
import { transferIdOf } from "../lib/codes";
import { feedback } from "../lib/feedback";
import { useScan } from "../scanner/useWedgeScanner";
import { Badges, BlankChips, Prompt, QueueFooter } from "./common";

type QcView =
  | { phase: "scan"; error: string | null }
  | { phase: "inspect"; item: QueueItem }
  | {
      phase: "done";
      item: QueueItem;
      result: "pass" | "fail";
      queued: boolean;
      error: string | null;
    };

/** QC: scan the pressed shirt, then Pass, or Fail with a reason (which requests a reprint). */
export function QcStation() {
  const { t } = useTranslation();
  const queue = useStationQueue("qc");
  const api = useApp((s) => s.api);
  const token = useApp((s) => s.session?.sessionToken ?? "");
  const [view, setView] = useState<QcView>({ phase: "scan", error: null });
  const [reasonOpen, setReasonOpen] = useState(false);
  const passBtn = useRef<HTMLButtonElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);

  async function lookup(code: string): Promise<QueueItem | null> {
    const id = transferIdOf(code);
    const match = (i: QueueItem) => i.transferId === id || i.orderItemId === id;
    const hit = queue.items.find(match);
    if (hit) return hit;
    try {
      return (await api.queue(token, "qc")).items.find(match) ?? null;
    } catch {
      return null;
    }
  }

  useScan(async (code) => {
    if (reasonOpen) return;
    const item = await lookup(code);
    if (!item) {
      feedback("error");
      setView({ phase: "scan", error: t("floor.qc.notFound") });
      return;
    }
    feedback("tick");
    setView({ phase: "inspect", item });
  });

  useEffect(() => {
    if (view.phase === "inspect") passBtn.current?.focus();
    if (view.phase === "done") nextBtn.current?.focus();
  }, [view.phase]);

  async function decide(
    item: QueueItem,
    result: "pass" | "fail",
    reason?: (typeof FLOOR_REASONS)[number],
  ) {
    setReasonOpen(false);
    const outcome = await submit({
      kind: "qc",
      input: {
        orderItemId: item.orderItemId,
        result,
        reprintReason: reason?.reason,
        note: reason?.note ?? null,
      },
    });
    const error = outcome.status === "failed" ? outcome.message : null;
    feedback(error ? "error" : result === "pass" ? "ok" : "warn");
    setView({ phase: "done", item, result, queued: outcome.status === "queued", error });
    invalidateQueues();
  }

  return (
    <div className="flex h-full">
      <section className="relative min-w-0 flex-[1.7]">
        {view.phase === "scan" && (
          <Prompt icon={QrCode} title={t("floor.qc.scanHint")} hint={view.error} tone="warn" />
        )}
        {view.phase === "inspect" && (
          <div className="flex h-full flex-col gap-6 p-6">
            <div className="flex flex-1 gap-6 rounded-2xl bg-card p-6 ring-1 ring-border">
              <Thumbnail
                fileKey={view.item.artworkPreviewKey}
                alt={view.item.design.name}
                className="size-72 shrink-0"
              />
              <div className="flex min-w-0 flex-col justify-center gap-4">
                <div className="flex items-center gap-3">
                  <span className="text-6xl font-black">{view.item.orderNo}</span>
                  <Badges item={view.item} />
                </div>
                <p className="text-3xl font-semibold">
                  {view.item.design.name} · {t(`floor.placement.${view.item.placement}`)}
                </p>
                <BlankChips blank={view.item.blank} className="text-3xl" />
              </div>
            </div>
            <div className="flex gap-6">
              <BigButton
                ref={passBtn}
                variant="success"
                className="h-32 flex-1 text-4xl"
                onClick={() => void decide(view.item, "pass")}
              >
                <Check className="!size-12" /> {t("floor.qc.pass")}
              </BigButton>
              <BigButton
                variant="destructive"
                className="h-32 flex-1 text-4xl"
                onClick={() => setReasonOpen(true)}
              >
                <X className="!size-12" /> {t("floor.qc.fail")}
              </BigButton>
            </div>
          </div>
        )}
        {view.phase === "done" && (
          <ResultPanel
            tone={view.error ? "blocked" : view.result === "pass" ? "ok" : "warn"}
            title={view.result === "pass" ? t("floor.qc.pass") : t("floor.qc.fail")}
            reason={
              view.error ??
              (view.result === "pass"
                ? t("floor.qc.passed", { orderNo: view.item.orderNo })
                : t("floor.qc.failed", { orderNo: view.item.orderNo }))
            }
            actions={
              <BigButton
                ref={nextBtn}
                className="h-24 bg-background text-3xl text-foreground hover:bg-background/90"
                onClick={() => setView({ phase: "scan", error: null })}
              >
                {t("floor.common.next")} <ArrowRight />
              </BigButton>
            }
          >
            {view.queued && <p className="text-2xl">{t("floor.press.queued")}</p>}
          </ResultPanel>
        )}
      </section>
      <aside className="flex w-[34%] min-w-80 flex-col border-l border-border bg-card">
        <h2 className="px-4 pt-3 text-lg font-bold uppercase text-muted-foreground">
          {t("floor.press.queueTitle")}
        </h2>
        <ul className="flex-1 overflow-y-auto">
          {queue.items.length === 0 && !queue.loading && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.common.empty")}
            </li>
          )}
          {queue.items.map((item) => (
            <li
              key={item.orderItemId}
              className="flex items-center gap-3 border-b border-border px-4 py-3"
            >
              <Thumbnail fileKey={item.artworkPreviewKey} alt="" className="size-14 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xl font-bold">
                  {item.orderNo} <Badges item={item} />
                </div>
                <div className="truncate text-muted-foreground">{item.design.name}</div>
              </div>
              <BlankChips blank={item.blank} className="text-sm" />
            </li>
          ))}
        </ul>
        <QueueFooter queue={queue} />
      </aside>
      <ReasonDialog
        open={reasonOpen}
        title={t("floor.qc.reasonTitle")}
        onPick={(r) => view.phase === "inspect" && void decide(view.item, "fail", r)}
        onClose={() => setReasonOpen(false)}
      />
    </div>
  );
}
