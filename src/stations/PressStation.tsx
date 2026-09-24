import { BigButton, cn, toast } from "@invai/ui";
import { ArrowRight, Loader2, QrCode, ScanBarcode, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueueItem, ScanResult } from "../api/types";
import { submit } from "../app/actions";
import { useSession } from "../app/store";
import { ReasonDialog } from "../components/ProblemDialog";
import { ResultPanel } from "../components/ResultPanel";
import { Thumbnail } from "../components/Thumbnail";
import {
  cachedBlanks,
  findCachedItem,
  invalidateQueues,
  useStationQueue,
} from "../hooks/useStationQueue";
import { parseCode, transferIdOf } from "../lib/codes";
import { feedback } from "../lib/feedback";
import { uuid } from "../lib/uuid";
import {
  initialPressState,
  type PressEvent,
  type PressState,
  pressReducer,
} from "../scan/pressFlow";
import { errorView, localPressCheck, queuedView, type ResultView } from "../scan/result";
import { useScan } from "../scanner/useWedgeScanner";
import { Badges, BlankChips, Prompt, QueueFooter } from "./common";

/**
 * Press: scan the transfer QR, then the blank or tote label. The server checks design, size
 * and color; the tablet shows a full-screen PRESS or BLOCKED with a sound.
 */
export function PressStation() {
  const { t } = useTranslation();
  const session = useSession();
  const queue = useStationQueue("press");
  const [state, setState] = useState<PressState>(initialPressState);
  const ref = useRef(state);
  const [problemOpen, setProblemOpen] = useState(false);
  const nextBtn = useRef<HTMLButtonElement>(null);

  const apply = (event: PressEvent) => {
    const next = pressReducer(ref.current, event);
    ref.current = next;
    setState(next);
    return next;
  };

  function findPreview(code: string): QueueItem | null {
    const id = transferIdOf(code);
    return queue.items.find((i) => i.transferId === id || i.orderItemId === id) ?? null;
  }

  async function runCheck(s: Extract<PressState, { phase: "checking" }>) {
    let view: ResultView;
    let result: ScanResult | null = null;
    try {
      const outcome = await submit({
        kind: "scan",
        input: {
          clientScanId: s.clientScanId,
          station: "press",
          stationId: session.station.id,
          transferCode: s.transferCode,
          blankCode: s.blankCode,
          scannedAt: new Date().toISOString(),
        },
      });
      if (outcome.status === "sent") {
        result = outcome.result as ScanResult;
        apply({ type: "result", clientScanId: s.clientScanId, result });
        view = ref.current.phase === "result" ? ref.current.view : queuedView(s.preview);
      } else if (outcome.status === "queued") {
        const preview =
          s.preview ?? (await findCachedItem((i) => i.transferId === transferIdOf(s.transferCode)));
        view = preview
          ? localPressCheck(preview, s.blankCode, await cachedBlanks())
          : queuedView(null);
        apply({ type: "local", clientScanId: s.clientScanId, view });
      } else {
        view = errorView("floor.error.rejected", outcome.message);
        apply({ type: "local", clientScanId: s.clientScanId, view });
      }
    } catch (err) {
      view = errorView("floor.error.server", String(err));
      apply({ type: "local", clientScanId: s.clientScanId, view });
    }
    feedback(view.tone === "ok" ? "ok" : view.tone === "warn" ? "warn" : "error");
    invalidateQueues();
  }

  function handle(code: string) {
    if (problemOpen) return;
    const kind = parseCode(code).kind;
    const preview = kind === "transfer" || kind === "unknown" ? findPreview(code) : null;
    const before = ref.current;
    const next = apply({ type: "scan", code, preview, clientScanId: uuid() });
    if (next.phase === "checking" && before.phase !== "checking") void runCheck(next);
    else if (next.phase === "awaitBlank" && next !== before) feedback("tick");
    else if (
      (next.phase === "awaitTransfer" && next.hint) ||
      (next.phase === "result" && next.hint)
    )
      feedback("warn");
  }

  useScan(handle);

  // Keyboard-only: Esc = Next. Enter on the focused Next button works (scanner Enters are swallowed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !problemOpen) apply({ type: "next" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (state.phase === "result") nextBtn.current?.focus();
  }, [state.phase]);

  async function reportProblem(
    reason: Parameters<Parameters<typeof ReasonDialog>[0]["onPick"]>[0],
  ) {
    setProblemOpen(false);
    const orderItemId =
      (state.phase === "result" && state.result?.orderItemId) ||
      ("preview" in state && state.preview?.orderItemId) ||
      null;
    if (orderItemId) {
      await submit({ kind: "reprint", orderItemId, reason: reason.reason, note: reason.note });
      toast.success(t("floor.press.problemSent"));
    }
    apply({ type: "next" });
  }

  const preview = "preview" in state ? state.preview : null;

  return (
    <div className="flex h-full">
      <section className="relative min-w-0 flex-[1.7]">
        {state.phase === "awaitTransfer" && (
          <Prompt
            icon={QrCode}
            title={t("floor.press.step1")}
            hint={state.hint === "scan_transfer_first" ? t("floor.press.hintTransferFirst") : null}
            tone="warn"
          />
        )}

        {(state.phase === "awaitBlank" || state.phase === "checking") && (
          <div className="flex h-full flex-col gap-4 p-6">
            <TransferCard code={state.transferCode} item={preview} />
            <div
              className={cn(
                "flex flex-1 items-center justify-center gap-6 rounded-2xl border-4 border-dashed p-6",
                state.phase === "checking" ? "border-muted" : "border-primary",
              )}
            >
              {state.phase === "checking" ? (
                <>
                  <Loader2 className="size-20 animate-spin text-primary" aria-hidden />
                  <span className="text-5xl font-bold">{t("floor.press.checking")}</span>
                </>
              ) : (
                <>
                  <ScanBarcode className="size-24 text-primary" aria-hidden />
                  <span className="text-5xl font-bold">{t("floor.press.step2")}</span>
                </>
              )}
            </div>
            <div className="flex gap-4">
              <BigButton variant="outline" onClick={() => apply({ type: "next" })}>
                {t("floor.common.cancel")}
              </BigButton>
              <BigButton variant="outline" onClick={() => setProblemOpen(true)} disabled={!preview}>
                <TriangleAlert /> {t("floor.common.problem")}
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
          {queue.items.length === 0 && !queue.loading && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.common.empty")}
            </li>
          )}
          {queue.items.map((item) => (
            <li key={item.orderItemId}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => item.transferId && handle(`T:${item.transferId}`)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left",
                  preview?.orderItemId === item.orderItemId && "bg-accent",
                )}
              >
                <Thumbnail fileKey={item.artworkPreviewKey} alt="" className="size-14 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xl font-bold">
                    {item.orderNo} <Badges item={item} />
                  </div>
                  <div className="truncate text-muted-foreground">{item.design.name}</div>
                  <BlankChips blank={item.blank} className="mt-1 text-sm" />
                </div>
              </button>
            </li>
          ))}
        </ul>
        <QueueFooter queue={queue} />
      </aside>

      {state.phase === "result" && (
        <div className="absolute inset-0 z-20">
          <PressResult
            view={state.view}
            hint={state.hint}
            item={preview}
            nextRef={nextBtn}
            onNext={() => apply({ type: "next" })}
            onProblem={() => setProblemOpen(true)}
          />
        </div>
      )}

      <ReasonDialog
        open={problemOpen}
        title={t("floor.press.problemTitle")}
        onPick={(r) => void reportProblem(r)}
        onClose={() => setProblemOpen(false)}
      />
    </div>
  );
}

const BLANK_MISMATCHES = new Set([
  "mismatch.wrong_size",
  "mismatch.wrong_color",
  "mismatch.wrong_design",
  "mismatch.wrong_style",
  "mismatch.unknown_blank",
  "local.wrong_blank",
]);

function TransferCard({ code, item }: { code: string; item: QueueItem | null }) {
  const { t } = useTranslation();
  if (!item) {
    return (
      <div className="flex items-center gap-4 rounded-2xl bg-muted p-6">
        <QrCode className="size-16" aria-hidden />
        <div>
          <p className="font-mono text-2xl">{code}</p>
          <p className="text-xl text-muted-foreground">{t("floor.press.unknownTransfer")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-6 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border">
      <Thumbnail
        fileKey={item.artworkPreviewKey}
        alt={item.design.name}
        className="size-48 shrink-0"
      />
      <div className="flex min-w-0 flex-col justify-center gap-3">
        <div className="flex items-center gap-3">
          <span className="text-6xl font-black">{item.orderNo}</span>
          <Badges item={item} />
        </div>
        <p className="truncate text-3xl font-semibold">
          {item.design.name}{" "}
          <span className="text-muted-foreground">· {t(`floor.placement.${item.placement}`)}</span>
        </p>
        <BlankChips blank={item.blank} className="text-3xl" />
        {item.binCode && (
          <p className="text-xl text-muted-foreground">
            {t("floor.common.bin")}: <b className="text-foreground">{item.binCode}</b>
          </p>
        )}
      </div>
    </div>
  );
}

function PressResult({
  view,
  hint,
  item,
  nextRef,
  onNext,
  onProblem,
}: {
  view: ResultView;
  hint: "scan_next_transfer" | null;
  item: QueueItem | null;
  nextRef: React.RefObject<HTMLButtonElement | null>;
  onNext: () => void;
  onProblem: () => void;
}) {
  const { t } = useTranslation();
  const title =
    view.tone === "ok"
      ? t("floor.press.ok")
      : view.tone === "warn"
        ? t("floor.press.wait")
        : t("floor.press.blocked");
  const reason = view.reasonKey
    ? t(view.reasonKey.startsWith("floor.") ? view.reasonKey : `floor.${view.reasonKey}`)
    : null;
  const orderNo = view.orderNo ?? item?.orderNo;
  const design = view.designName ?? item?.design.name;
  return (
    <ResultPanel
      tone={view.tone}
      title={title}
      reason={reason}
      actions={
        <>
          <BigButton
            ref={nextRef}
            className="h-24 flex-[2] bg-background text-3xl text-foreground hover:bg-background/90"
            onClick={onNext}
          >
            {t("floor.common.next")} <ArrowRight />
          </BigButton>
          <BigButton
            variant="outline"
            className="h-24 flex-1 border-current bg-transparent text-2xl"
            onClick={onProblem}
          >
            <TriangleAlert /> {t("floor.common.problem")}
          </BigButton>
        </>
      }
    >
      <div className="flex flex-col items-center gap-1 text-2xl">
        {(orderNo || design) && (
          <p className="text-4xl font-bold">
            {orderNo} {design && <span className="font-medium">· {design}</span>}
            {view.placement && (
              <span className="font-medium"> · {t(`floor.placement.${view.placement}`)}</span>
            )}
          </p>
        )}
        {view.tone !== "ok" && view.expected && (
          <p>
            {t("floor.common.expected")}: <b>{view.expected}</b>
          </p>
        )}
        {view.tone !== "ok" && view.scanned && (
          <p>
            {t("floor.common.scanned")}: <b>{view.scanned}</b>
          </p>
        )}
        {view.tone === "ok" && view.expected && (
          <p className="text-3xl font-semibold">{view.expected}</p>
        )}
        {view.message && <p className="opacity-80">{view.message}</p>}
        {view.provisional && view.tone !== "warn" && (
          <p className="mt-2 rounded-lg bg-black/15 px-4 py-2">{t("floor.press.provisional")}</p>
        )}
        {view.queued && view.tone === "warn" && (
          <p className="mt-2 rounded-lg bg-black/10 px-4 py-2">{t("floor.press.queued")}</p>
        )}
        {view.tone === "blocked" && !view.queued && BLANK_MISMATCHES.has(view.reasonKey ?? "") && (
          <p className="mt-2 opacity-90">{t("floor.press.rescan")}</p>
        )}
        {hint === "scan_next_transfer" && (
          <p className="mt-2 rounded-lg bg-black/15 px-4 py-2 font-bold">
            {t("floor.press.hintNextTransfer")}
          </p>
        )}
      </div>
    </ResultPanel>
  );
}
