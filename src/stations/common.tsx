import { cn } from "@invai/ui";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QueueItem } from "../api/types";
import type { QueueState } from "../hooks/useStationQueue";
import { blankLabel } from "../scan/result";

export function Badges({ item }: { item: Pick<QueueItem, "isRush" | "isReprint"> }) {
  const { t } = useTranslation();
  return (
    <>
      {item.isRush && (
        <span className="rounded-md bg-danger px-2 py-0.5 text-sm font-black text-danger-foreground">
          {t("floor.common.rush")}
        </span>
      )}
      {item.isReprint && (
        <span className="rounded-md bg-info px-2 py-0.5 text-sm font-black text-info-foreground">
          {t("floor.common.reprint")}
        </span>
      )}
    </>
  );
}

/** Blank as big separate chips, so size and color can be read at a glance. */
export function BlankChips({
  blank,
  className,
}: {
  blank: QueueItem["blank"];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="rounded-lg bg-foreground px-3 py-1 font-black text-background">
        {blank.size}
      </span>
      <span className="rounded-lg border-2 border-foreground px-3 py-1 font-bold">
        {blank.color}
      </span>
      <span className="text-muted-foreground">
        {blank.brand} {blank.style}
      </span>
    </div>
  );
}

export function QueueFooter({ queue }: { queue: QueueState }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-sm text-muted-foreground">
      <span>
        {queue.counts
          ? `${t("floor.header.waiting", { count: queue.counts.waiting })} · ${t("floor.header.doneToday", { count: queue.counts.doneToday })}`
          : null}
        {queue.error && queue.cachedAt
          ? ` ${t("floor.common.cached", { time: new Date(queue.cachedAt).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" }) })}`
          : null}
        {queue.error && !queue.cachedAt
          ? ` ${t("floor.common.queueError")} (${queue.error.code})`
          : null}
      </span>
      <button
        type="button"
        onClick={queue.refetch}
        className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted"
      >
        {queue.loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        {t("floor.common.refresh")}
      </button>
    </div>
  );
}

export function describeBlank(item: QueueItem) {
  return blankLabel(item.blank) ?? "";
}

export function Prompt({
  icon: Icon,
  title,
  hint,
  tone = "muted",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string | null;
  tone?: "muted" | "warn";
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <Icon className="size-40 text-primary" aria-hidden />
      <p className="text-5xl font-bold">{title}</p>
      {hint && (
        <p
          className={cn(
            "rounded-xl px-6 py-3 text-2xl font-semibold",
            tone === "warn" ? "bg-warning text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
