import { BigButton, cn } from "@invai/ui";
import { ArrowRight, ClipboardList, PackageCheck, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { submit } from "../../app/actions";
import { useApp } from "../../app/store";
import { ResultPanel } from "../../components/ResultPanel";
import { parseCode } from "../../lib/codes";
import { feedback } from "../../lib/feedback";
import { useScan } from "../../scanner/useWedgeScanner";
import { BlankChips, Prompt } from "../common";
import { type PurchaseOrder, receivingApi } from "./api";
import {
  applyReceiptLines,
  capToOutstanding,
  completesPo,
  draftQty,
  findPo,
  lineForScan,
  newReceipt,
  outstanding,
  overLines,
  type ReceiptDraft,
  receiptLines,
  receiptTotal,
  setLineQty,
} from "./logic";
import { type Flash, FlashBar, ListFooter, Stepper, usePendingReceiving } from "./shared";
import { useCachedList } from "./useCachedList";

type Done = {
  tone: "ok" | "warn";
  poNo: string;
  count: number;
  left: number;
  queued: boolean;
};

/** Check in a blank purchase order: pick or scan the PO, count what arrived, receive it. */
export function PoReceive() {
  const { t, i18n } = useTranslation();
  const kind = useApp((s) => s.api.kind);
  const api = receivingApi(kind);
  const list = useCachedList("pos", (token) => api.openPurchaseOrders(token));
  const pending = usePendingReceiving(list.refetch);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [done, setDone] = useState<Done | null>(null);

  // Receipts still waiting to sync count as already in, so they can't be received twice.
  const pos = useMemo(() => {
    const out: PurchaseOrder[] = [];
    for (const po of list.items) {
      const lines = pending.flatMap((a) =>
        a.op === "receivePo" && a.input.purchaseOrderId === po.id ? a.input.lines : [],
      );
      const view = lines.length ? applyReceiptLines(po, lines) : po;
      if (view.status !== "received") out.push(view);
    }
    return out;
  }, [list.items, pending]);

  const po = draft ? (pos.find((p) => p.id === draft.poId) ?? null) : null;
  const over = po && draft ? overLines(po, draft) : [];
  const total = draft ? receiptTotal(draft) : 0;

  function open(p: PurchaseOrder) {
    setDraft(newReceipt(p));
    setDone(null);
    setFlash(null);
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
    const asPo = findPo(pos, code);
    if (asPo) {
      if (draft && total > 0 && draft.poId !== asPo.id) {
        feedback("warn");
        setFlash({ tone: "warn", text: t("floor.receiving.poFinishFirst", { poNo: po?.poNo }) });
        return;
      }
      feedback("tick");
      open(asPo);
      return;
    }
    if (!po || !draft) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.receiving.poUnknown", { code: code.trim() }) });
      return;
    }
    const parsed = parseCode(code);
    const line =
      parsed.kind === "blank" || parsed.kind === "unknown" ? lineForScan(po, draft, code) : null;
    if (!line) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.receiving.notOnPo", { poNo: po.poNo }) });
      return;
    }
    const next = setLineQty(draft, line.id, draftQty(draft, line.id) + 1);
    setDraft(next);
    const extra = draftQty(next, line.id) - outstanding(line);
    if (extra > 0) {
      feedback("warn");
      setFlash({
        tone: "warn",
        text: t("floor.receiving.over", {
          count: extra,
          blank: `${line.blank.size} ${line.blank.color}`,
        }),
      });
    } else {
      feedback("ok");
      setFlash({
        tone: "ok",
        text: `${line.blank.size} · ${line.blank.color} · ${draftQty(next, line.id)}/${outstanding(line)}`,
      });
    }
  });

  async function receive() {
    if (!po || !draft || inFlight.current || over.length || total === 0) return;
    inFlight.current = true;
    setBusy(true);
    const lines = receiptLines(po, draft);
    const completes = completesPo(po, draft);
    const left = po.lines.reduce((s, l) => s + outstanding(l), 0) - total;
    try {
      const outcome = await submit({
        kind: "receiving",
        action: {
          op: "receivePo",
          label: po.poNo,
          input: {
            purchaseOrderId: po.id,
            lines,
            note: null,
            idempotencyKey: draft.idempotencyKey,
          },
        },
      });
      if (outcome.status === "failed") {
        feedback("error");
        setFlash({
          tone: "blocked",
          text: t("floor.receiving.notSaved", { reason: outcome.message }),
        });
        // A new key: the next try is a new submission with whatever is fixed.
        setDraft({ ...draft, idempotencyKey: newReceipt(po).idempotencyKey });
        return;
      }
      if (outcome.status === "sent") {
        const updated = outcome.result as PurchaseOrder;
        list.update((items) =>
          updated.status === "received"
            ? items.filter((p) => p.id !== updated.id)
            : items.map((p) => (p.id === updated.id ? updated : p)),
        );
      }
      feedback(outcome.status === "sent" ? "ok" : "warn");
      setDone({
        tone: outcome.status === "sent" ? "ok" : "warn",
        poNo: po.poNo,
        count: total,
        left: completes ? 0 : left,
        queued: outcome.status === "queued",
      });
      setDraft(null);
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
          tone={done.tone}
          title={done.queued ? t("floor.local.queued") : t("floor.receiving.doneTitle")}
          reason={t("floor.receiving.received", { count: done.count, poNo: done.poNo })}
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
            {done.left === 0
              ? t("floor.receiving.poComplete", { poNo: done.poNo })
              : t("floor.receiving.poLeft", { count: done.left })}
          </p>
          {done.queued && <p className="text-2xl">{t("floor.receiving.queued")}</p>}
        </ResultPanel>
      </div>
    );
  }

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { month: "short", day: "numeric" });

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-[1.7] flex-col">
        <FlashBar flash={flash} />
        {!po || !draft ? (
          <Prompt icon={ClipboardList} title={t("floor.receiving.poScanHint")} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-5xl font-black" data-testid="po-number">
                  {po.poNo}
                </p>
                <p className="text-xl text-muted-foreground">{t("floor.receiving.lineHint")}</p>
              </div>
              <BigButton
                variant="outline"
                className="w-auto px-6 text-xl"
                onClick={() => {
                  let d = draft;
                  for (const l of po.lines) d = setLineQty(d, l.id, outstanding(l));
                  setDraft(d);
                  setFlash(null);
                }}
              >
                <PackageCheck /> {t("floor.receiving.allArrived")}
              </BigButton>
            </div>
            <div className="grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-x-4 border-b border-border pb-1 text-base font-semibold uppercase text-muted-foreground">
              <span>{t("floor.common.blank")}</span>
              <span className="text-right">{t("floor.receiving.ordered")}</span>
              <span className="text-right">{t("floor.receiving.alreadyIn")}</span>
              <span className="w-[16.5rem] text-center">{t("floor.receiving.now")}</span>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {po.lines.map((l) => {
                const qty = draftQty(draft, l.id);
                const isOver = qty > outstanding(l);
                const full = outstanding(l) === 0;
                return (
                  <li
                    key={l.id}
                    data-testid="po-line"
                    className={cn(
                      "grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-x-4 border-b border-border py-2 text-2xl",
                      isOver && "bg-warning/20",
                      full && "text-muted-foreground",
                    )}
                  >
                    <BlankChips blank={l.blank} className="text-xl" />
                    <span className="text-right font-bold tabular-nums">{l.qty}</span>
                    <span className="text-right tabular-nums">{l.receivedQty}</span>
                    <Stepper
                      value={qty}
                      tone={isOver ? "warn" : "default"}
                      label={`${l.blank.size} ${l.blank.color}`}
                      onChange={(n) => setDraft(setLineQty(draft, l.id, n))}
                    />
                  </li>
                );
              })}
            </ul>
            {over.length > 0 && (
              <div className="flex items-center gap-4 rounded-xl bg-warning px-4 py-3 text-warning-foreground">
                <TriangleAlert className="size-10 shrink-0" />
                <div className="flex-1 text-xl font-semibold">
                  {over.map(({ line, extra }) => (
                    <p key={line.id}>
                      {t("floor.receiving.over", {
                        count: extra,
                        blank: `${line.blank.size} ${line.blank.color}`,
                      })}
                    </p>
                  ))}
                  <p className="font-normal">{t("floor.receiving.overHelp")}</p>
                </div>
                <BigButton
                  variant="outline"
                  className="w-auto border-current bg-transparent px-4 text-xl"
                  onClick={() => setDraft(capToOutstanding(po, draft))}
                >
                  {t("floor.receiving.capToOrdered")}
                </BigButton>
              </div>
            )}
            <div className="flex gap-4">
              <BigButton
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setDraft(null);
                  setFlash(null);
                }}
              >
                {t("floor.common.cancel")}
              </BigButton>
              <BigButton
                variant={completesPo(po, draft) ? "success" : "default"}
                className="h-24 flex-[2] text-3xl"
                disabled={busy || total === 0 || over.length > 0}
                onClick={() => void receive()}
                data-testid="po-receive"
              >
                {completesPo(po, draft)
                  ? t("floor.receiving.receiveAll", { count: total })
                  : t("floor.receiving.receivePartial", { count: total })}
              </BigButton>
            </div>
          </div>
        )}
      </section>
      <aside className="flex w-[34%] min-w-80 flex-col border-l border-border bg-card">
        <h2 className="px-4 pt-3 text-lg font-bold uppercase text-muted-foreground">
          {t("floor.receiving.tabPo")}
        </h2>
        <ul className="flex-1 overflow-y-auto">
          {pos.map((p) => {
            const ordered = p.lines.reduce((s, l) => s + l.qty, 0);
            const received = p.lines.reduce((s, l) => s + l.receivedQty, 0);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="po-row"
                  onClick={() => (draft && total > 0 ? undefined : open(p))}
                  className={cn(
                    "flex min-h-20 w-full flex-col justify-center border-b border-border px-4 py-3 text-left",
                    draft?.poId === p.id && "bg-accent",
                  )}
                >
                  <span className="flex w-full items-center justify-between text-2xl font-bold">
                    {p.poNo}
                    <span className="text-lg font-semibold text-muted-foreground">
                      {t("floor.receiving.poIn", { received, ordered })}
                    </span>
                  </span>
                  <span className="text-lg text-muted-foreground">
                    {t("floor.receiving.poLines", { count: ordered })}
                    {p.expectedAt
                      ? ` · ${t("floor.receiving.expected", { date: fmtDate(p.expectedAt) })}`
                      : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {pos.length === 0 && list.loaded && (
            <li className="p-6 text-center text-xl text-muted-foreground">
              {t("floor.receiving.poEmpty")}
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
