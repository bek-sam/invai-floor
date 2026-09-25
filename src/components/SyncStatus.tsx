import {
  BigButton,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@invai/ui";
import { useLiveQuery } from "dexie-react-hooks";
import type { TFunction } from "i18next";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  CloudOff,
  CloudUpload,
  Radio,
  RefreshCw,
  Trash2,
  TriangleAlert,
  UserCheck,
  Wifi,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  currentSession,
  discardParked,
  engine,
  isLead,
  retryEntries,
  sendEntryAsMe,
} from "../app/actions";
import { useApp } from "../app/store";
import type { OutboxEntry } from "../outbox/db";
import {
  canRetry,
  canSendAsMe,
  isParked,
  MAX_ATTEMPTS,
  parkReasonOf,
  unresolvedEntries,
} from "../outbox/outbox";
import { dismissAlerts, setProblemsOpen, useSyncStore } from "../outbox/sync";
import { useScan } from "../scanner/useWedgeScanner";

/**
 * Online/offline, live-update state and the unsent count, in the header. Tapping it opens the
 * list of everything not sent yet. It also hosts the alert for offline scans the server refused.
 */
export function SyncStatus({ hideOnline = false }: { hideOnline?: boolean }) {
  const { t } = useTranslation();
  const { online, pending, parked } = useSyncStore();
  const live = useApp((s) => s.live);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          engine.kick();
          setProblemsOpen(true);
        }}
        className="flex min-h-16 items-center gap-3 rounded-lg px-2 py-1 text-sm font-semibold"
        data-testid="sync-status"
      >
        {!hideOnline && (
          <span className={cn("flex items-center gap-1", online ? "text-success" : "text-danger")}>
            {online ? <Wifi className="size-5" /> : <CloudOff className="size-5" />}
            {online ? t("common.online") : t("common.offline")}
          </span>
        )}
        {live !== "off" && (
          <span
            className={cn(
              "flex items-center gap-1",
              live === "open" ? "text-success" : "text-muted-foreground",
            )}
          >
            <Radio className="size-4" />
            {live === "open" ? t("floor.header.live") : t("floor.header.notLive")}
          </span>
        )}
        {pending > 0 ? (
          <span
            className="flex items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-warning-foreground"
            data-testid="sync-pending"
          >
            <CloudUpload className="size-4" />
            {t("floor.header.pending", { count: pending })}
          </span>
        ) : null}
        {pending === 0 && parked === 0 ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CircleCheck className="size-4" />
            {t("floor.header.synced")}
          </span>
        ) : null}
        {parked > 0 ? (
          <span
            className="flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-danger-foreground"
            data-testid="sync-parked"
          >
            <CircleAlert className="size-4" />
            {t("floor.outbox.parked", { count: parked })}
          </span>
        ) : null}
      </button>
      <ProblemsSheet />
      <ReplayAlert />
    </>
  );
}

/** A strip under the header while scans can't reach the server. */
export function OfflineStrip() {
  const { t } = useTranslation();
  const { online, lastFailure } = useSyncStore();
  if (online && lastFailure?.kind !== "unavailable") return null;
  const text =
    lastFailure?.kind === "unavailable"
      ? t("floor.offline.unavailable", { code: lastFailure.code })
      : t("floor.offline.banner");
  return (
    <div className="shrink-0 bg-warning px-4 py-2 text-center text-lg font-bold text-warning-foreground">
      {text}
    </div>
  );
}

function formatWhen(iso: string, lang: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** "Scan · Press", "QC pass", … */
function describeWhat(e: OutboxEntry, t: TFunction): string {
  const c = e.command;
  switch (c.kind) {
    case "scan":
      return t("floor.outbox.what.scan", { station: t(`floor.station.${c.input.station}`) });
    case "qc":
      return t(
        c.input.result === "pass" ? "floor.outbox.what.qc_pass" : "floor.outbox.what.qc_fail",
      );
    case "assignBin":
    case "releaseBin":
    case "reprint":
      return t(`floor.outbox.what.${c.kind}`);
    case "receiving":
      return t("floor.station.receiving");
  }
}

/** "Order #1042 · Sunset Tee · Bella 3001 Black M · Tote A3" */
function describeUnit(e: OutboxEntry, t: TFunction): string {
  const r = e.result as { orderNo?: string | null } | null;
  const orderNo = r?.orderNo ?? e.unit?.orderNo ?? null;
  const parts = [
    orderNo ? `${t("floor.common.order")} ${orderNo}` : null,
    e.unit?.design ?? null,
    e.unit?.blank ?? null,
    e.unit?.bin ? t("floor.outbox.tote", { bin: e.unit.bin }) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function describeError(e: OutboxEntry, t: TFunction): string {
  if (!isParked(e)) {
    return e.attempts > 0 && e.errorCode
      ? t("floor.outbox.status.retrying", { n: e.attempts, max: MAX_ATTEMPTS })
      : t("floor.outbox.status.pending");
  }
  const code = e.errorCode ?? "";
  switch (parkReasonOf(e)) {
    case "blocked":
      return t("floor.outbox.reason.blocked", {
        mismatch: t(`floor.mismatch.${code}`, { defaultValue: t("floor.mismatch.unknown") }),
      });
    case "gave_up":
      return t("floor.outbox.reason.gave_up", { max: MAX_ATTEMPTS });
    case "session":
      return t("floor.outbox.reason.session", { name: e.staffName });
    case "station_forgotten":
      return t("floor.outbox.reason.station_forgotten");
    case "rejected":
      return t("floor.outbox.reason.rejected", {
        error: t(`floor.outbox.code.${code}`, {
          defaultValue: t("floor.outbox.code.other", { code: code || "?" }),
        }),
      });
  }
}

type Confirming = { id: string; action: "discard" | "sendAsMe" } | null;

/** Everything not sent yet, oldest first: what, when, who and why. Leads can act on parked ones. */
function ProblemsSheet() {
  const { t, i18n } = useTranslation();
  const open = useSyncStore((s) => s.sheetOpen);
  const session = useApp((s) => s.session);
  const lead = isLead(session);
  const current = session ? currentSession() : null;
  const entries = useLiveQuery(() => (open ? unresolvedEntries() : []), [open]) ?? [];
  const [confirming, setConfirming] = useState<Confirming>(null);
  useScan(() => {}, open); // scans don't reach the station underneath while this is open

  const retriable = entries.filter((e) => canRetry(e, current));

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setProblemsOpen(o);
        if (!o) setConfirming(null);
      }}
    >
      <SheetContent
        side="right"
        showClose={false}
        className="flex w-[46rem] flex-col gap-4 sm:max-w-[46rem]"
        data-testid="problems-sheet"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <SheetTitle className="text-3xl font-bold">{t("floor.outbox.title")}</SheetTitle>
            <SheetDescription className="text-lg">{t("floor.outbox.subtitle")}</SheetDescription>
          </div>
          <Button
            size="xl"
            variant="outline"
            className="h-16"
            onClick={() => setProblemsOpen(false)}
          >
            <X /> {t("floor.common.close")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button size="xl" className="h-16" onClick={engine.kick}>
            <RefreshCw /> {t("floor.outbox.syncNow")}
          </Button>
          {lead && retriable.length > 1 && (
            <Button
              size="xl"
              variant="outline"
              className="h-16"
              onClick={() => void retryEntries(retriable.map((e) => e.id))}
            >
              <RefreshCw /> {t("floor.outbox.retryAll")}
            </Button>
          )}
        </div>
        {!lead && entries.some(isParked) && (
          <p className="text-lg text-muted-foreground">{t("floor.outbox.leadOnly")}</p>
        )}
        {entries.length === 0 ? (
          <p className="py-12 text-center text-2xl text-muted-foreground">
            {t("floor.outbox.allSynced")}
          </p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {entries.map((e) => {
              const parked = isParked(e);
              const unit = describeUnit(e, t);
              const ask = confirming?.id === e.id ? confirming.action : null;
              return (
                <li
                  key={e.id}
                  data-testid="problem-row"
                  data-status={parked ? "parked" : "pending"}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border-2 p-4",
                    parked ? "border-danger bg-danger/5" : "border-warning bg-warning/5",
                  )}
                >
                  <div className="flex items-start gap-3">
                    {parked ? (
                      <TriangleAlert className="mt-1 size-7 shrink-0 text-danger" aria-hidden />
                    ) : (
                      <Clock className="mt-1 size-7 shrink-0 text-warning-foreground" aria-hidden />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="text-xl font-bold">{describeWhat(e, t)}</p>
                      {unit && <p className="text-lg">{unit}</p>}
                      <p className="text-base text-muted-foreground">
                        {formatWhen(e.createdAt, i18n.language)} ·{" "}
                        {t("floor.outbox.by", { name: e.staffName })}
                      </p>
                      <p
                        className={cn(
                          "text-lg font-semibold",
                          parked ? "text-danger" : "text-warning-foreground",
                        )}
                      >
                        {describeError(e, t)}
                      </p>
                    </div>
                  </div>
                  {lead && parked && (
                    <RowActions
                      entry={e}
                      ask={ask}
                      canRetry={canRetry(e, current)}
                      canSendAsMe={canSendAsMe(e, current)}
                      myName={session?.user.name ?? ""}
                      onAsk={(action) => setConfirming(action ? { id: e.id, action } : null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RowActions({
  entry,
  ask,
  canRetry: retry,
  canSendAsMe: asMe,
  myName,
  onAsk,
}: {
  entry: OutboxEntry;
  ask: "discard" | "sendAsMe" | null;
  canRetry: boolean;
  canSendAsMe: boolean;
  myName: string;
  onAsk: (action: "discard" | "sendAsMe" | null) => void;
}) {
  const { t } = useTranslation();
  if (ask) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3">
        <p className="flex-1 text-lg font-semibold">
          {ask === "discard"
            ? t("floor.outbox.discardConfirm")
            : t("floor.outbox.sendAsMeConfirm", { name: myName })}
        </p>
        <Button size="xl" variant="outline" className="h-16" onClick={() => onAsk(null)}>
          {t("floor.common.cancel")}
        </Button>
        <Button
          size="xl"
          variant={ask === "discard" ? "destructive" : "default"}
          className="h-16"
          onClick={() => {
            onAsk(null);
            if (ask === "discard") void discardParked(entry.id);
            else void sendEntryAsMe(entry.id);
          }}
        >
          {t("action.confirm")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      {retry && (
        <Button size="xl" className="h-16" onClick={() => void retryEntries([entry.id])}>
          <RefreshCw /> {t("floor.outbox.retry")}
        </Button>
      )}
      {asMe && (
        <Button size="xl" variant="outline" className="h-16" onClick={() => onAsk("sendAsMe")}>
          <UserCheck /> {t("floor.outbox.sendAsMe")}
        </Button>
      )}
      <Button size="xl" variant="outline" className="h-16" onClick={() => onAsk("discard")}>
        <Trash2 /> {t("floor.outbox.discard")}
      </Button>
    </div>
  );
}

/**
 * Offline scans (or QC, tote, reprint changes) that the server refused on replay: a big red
 * alert with each unit, until someone taps OK. The error sound plays from the sync engine.
 */
function ReplayAlert() {
  const { t, i18n } = useTranslation();
  const alerts = useSyncStore((s) => s.alerts);
  const open = alerts.length > 0;
  useScan(() => {}, open);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismissAlerts()}>
      <DialogContent
        showClose={false}
        className="max-w-3xl border-4 border-danger p-8"
        data-testid="replay-alert"
      >
        <DialogTitle className="flex items-center gap-3 text-3xl font-bold text-danger">
          <TriangleAlert className="size-10 shrink-0" aria-hidden />
          {t("floor.outbox.alert.title", { count: alerts.length })}
        </DialogTitle>
        <DialogDescription className="text-xl text-foreground">
          {t("floor.outbox.alert.body")}
        </DialogDescription>
        <ul className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto">
          {alerts.map((e) => (
            <li key={e.id} className="rounded-xl bg-danger/10 p-4">
              <p className="text-2xl font-bold">{describeUnit(e, t) || describeWhat(e, t)}</p>
              <p className="text-xl font-semibold text-danger">{describeError(e, t)}</p>
              <p className="text-base text-muted-foreground">
                {describeWhat(e, t)} · {formatWhen(e.createdAt, i18n.language)} ·{" "}
                {t("floor.outbox.by", { name: e.staffName })}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-2 grid grid-cols-2 gap-4">
          <BigButton
            variant="outline"
            onClick={() => {
              dismissAlerts();
              setProblemsOpen(true);
            }}
          >
            {t("floor.outbox.alert.see")}
          </BigButton>
          <BigButton autoFocus onClick={dismissAlerts}>
            {t("floor.outbox.alert.ok")}
          </BigButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
