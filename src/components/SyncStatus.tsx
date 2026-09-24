import { cn } from "@invai/ui";
import { CloudOff, CloudUpload, Radio, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { engine } from "../app/actions";
import { useApp } from "../app/store";
import { useSyncStore } from "../outbox/sync";

/** Online/offline, live-update state and the outbox pending count, in the header. */
export function SyncStatus({ hideOnline = false }: { hideOnline?: boolean }) {
  const { t } = useTranslation();
  const { online, pending, failed } = useSyncStore();
  const live = useApp((s) => s.live);
  return (
    <button
      type="button"
      onClick={engine.kick}
      className="flex items-center gap-3 rounded-lg px-2 py-1 text-sm font-semibold"
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
        <span className="flex items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-warning-foreground">
          <CloudUpload className="size-4" />
          {t("floor.header.pending", { count: pending })}
        </span>
      ) : null}
      {failed > 0 ? (
        <span className="rounded-full bg-danger px-2 py-0.5 text-danger-foreground">
          {t("floor.header.failed", { count: failed })}
        </span>
      ) : null}
    </button>
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
