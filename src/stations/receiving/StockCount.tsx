import { BigButton, cn, Dialog, DialogContent, DialogTitle } from "@invai/ui";
import { ArrowRight, Boxes, Plus, Save, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { submit } from "../../app/actions";
import { useApp } from "../../app/store";
import { ResultPanel } from "../../components/ResultPanel";
import { feedback } from "../../lib/feedback";
import { useScan } from "../../scanner/useWedgeScanner";
import { BlankChips, Prompt } from "../common";
import { type CountResult, receivingApi } from "./api";
import {
  type CountDraft,
  countOne,
  countRows,
  findStock,
  removeCountLine,
  setCounted,
} from "./logic";
import { type Flash, FlashBar, ListFooter, Stepper } from "./shared";
import { useCachedList } from "./useCachedList";

type Done = { queued: boolean; changed: number; lines: number };

/** Physical count of the stock location: scan every blank, check the difference, save. */
export function StockCount() {
  const { t } = useTranslation();
  const kind = useApp((s) => s.api.kind);
  const api = receivingApi(kind);
  const list = useCachedList("stock", (token) => api.stock(token));
  const [draft, setDraft] = useState<CountDraft>({ lines: [] });
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const inFlight = useRef(false);

  // The count is for one location: the one the stock list reports (the shop's default).
  const locationId = list.items[0]?.locationId;
  const stock = useMemo(
    () => list.items.filter((s) => s.locationId === locationId),
    [list.items, locationId],
  );
  const rows = countRows(draft, stock);
  const changed = rows.filter((r) => r.delta !== 0).length;

  useScan((code) => {
    if (busy || picking) return;
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
    const s = findStock(stock, code);
    if (!s) {
      feedback("error");
      setFlash({ tone: "blocked", text: t("floor.receiving.countUnknown") });
      return;
    }
    const next = countOne(draft, s.blankVariantId);
    setDraft(next);
    feedback("ok");
    const n = next.lines.find((l) => l.blankVariantId === s.blankVariantId)?.counted ?? 0;
    setFlash({ tone: "ok", text: `${s.blank.size} · ${s.blank.color} · ${n}` });
  });

  async function save() {
    if (inFlight.current || draft.lines.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await submit({
        kind: "receiving",
        action: {
          op: "count",
          label: t("floor.receiving.tabCount"),
          input: {
            locationId,
            lines: draft.lines.map((l) => ({
              blankVariantId: l.blankVariantId,
              counted: l.counted,
            })),
            note: null,
          },
        },
      });
      if (outcome.status === "failed") {
        feedback("error");
        setFlash({
          tone: "blocked",
          text: t("floor.receiving.notSaved", { reason: outcome.message }),
        });
        return;
      }
      const result = outcome.status === "sent" ? (outcome.result as CountResult) : null;
      feedback(result ? "ok" : "warn");
      setDone({
        queued: !result,
        changed: result ? result.variance.filter((v) => v.delta !== 0).length : changed,
        lines: draft.lines.length,
      });
      setDraft({ lines: [] });
      setFlash(null);
      if (result) list.refetch();
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
          title={done.queued ? t("floor.local.queued") : t("floor.receiving.countSaved")}
          reason={
            done.changed === 0
              ? t("floor.receiving.countNoChange")
              : t("floor.receiving.countChanged", { count: done.changed })
          }
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
          {done.queued && <p className="text-2xl">{t("floor.receiving.queued")}</p>}
        </ResultPanel>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <FlashBar flash={flash} />
      {rows.length === 0 ? (
        <div className="min-h-0 flex-1">
          <Prompt
            icon={Boxes}
            title={t("floor.receiving.countScanHint")}
            hint={!list.loaded && list.error ? t("floor.receiving.noList") : null}
            tone="warn"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-3">
          <div className="grid grid-cols-[1fr_7rem_auto_9rem_4rem] items-center gap-x-4 border-b border-border pb-1 text-base font-semibold uppercase text-muted-foreground">
            <span>{t("floor.common.blank")}</span>
            <span className="text-right">{t("floor.receiving.system")}</span>
            <span className="w-[16.5rem] text-center">{t("floor.receiving.counted")}</span>
            <span className="text-right">{t("floor.receiving.difference")}</span>
            <span />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((r) => (
              <li
                key={r.blankVariantId}
                data-testid="count-row"
                className="grid grid-cols-[1fr_7rem_auto_9rem_4rem] items-center gap-x-4 border-b border-border py-2 text-2xl"
              >
                {r.stock ? <BlankChips blank={r.stock.blank} className="text-xl" /> : <span />}
                <span className="text-right tabular-nums">{r.expected}</span>
                <Stepper
                  value={r.counted}
                  label={r.stock ? `${r.stock.blank.size} ${r.stock.blank.color}` : ""}
                  onChange={(n) => setDraft(setCounted(draft, r.blankVariantId, n))}
                />
                <span
                  data-testid="count-delta"
                  className={cn(
                    "text-right font-black tabular-nums",
                    r.delta === 0 && "text-success",
                    r.delta < 0 && "text-danger",
                    r.delta > 0 && "text-warning-foreground",
                  )}
                >
                  {r.delta === 0
                    ? t("floor.receiving.matches")
                    : r.delta > 0
                      ? `+${r.delta}`
                      : r.delta}
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("floor.common.cancel")}
                  onClick={() => setDraft(removeCountLine(draft, r.blankVariantId))}
                  className="flex size-16 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted"
                >
                  <X className="size-8" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-4 border-t border-border p-4">
        <BigButton
          variant="outline"
          className="flex-1"
          onClick={() => setPicking(true)}
          disabled={stock.length === 0}
        >
          <Plus /> {t("floor.receiving.addBlank")}
        </BigButton>
        <BigButton
          variant="outline"
          className="flex-1"
          disabled={rows.length === 0}
          onClick={() => {
            setDraft({ lines: [] });
            setFlash(null);
          }}
        >
          {t("floor.receiving.startOver")}
        </BigButton>
        <BigButton
          className="h-20 flex-[2] text-3xl"
          disabled={busy || rows.length === 0}
          onClick={() => void save()}
          data-testid="count-save"
        >
          <Save /> {t("floor.receiving.saveCount", { count: rows.length })}
        </BigButton>
      </div>
      <ListFooter list={list} />
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-6">
          <DialogTitle className="text-3xl">{t("floor.receiving.pickBlank")}</DialogTitle>
          <ul className="max-h-[70vh] overflow-y-auto">
            {stock.map((s) => (
              <li key={s.blankVariantId}>
                <button
                  type="button"
                  className="flex min-h-16 w-full items-center justify-between gap-4 border-b border-border px-2 py-2 text-left text-2xl hover:bg-muted"
                  onClick={() => {
                    if (!draft.lines.some((l) => l.blankVariantId === s.blankVariantId)) {
                      setDraft(setCounted(draft, s.blankVariantId, 0));
                    }
                    setPicking(false);
                  }}
                >
                  <BlankChips blank={s.blank} className="text-xl" />
                  <span className="text-muted-foreground tabular-nums">{s.onHand}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
