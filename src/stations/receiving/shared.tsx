import { cn } from "@invai/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { floorDb } from "../../outbox/db";
import type { ReceivingAction } from "./commands";
import type { CachedList } from "./useCachedList";

export type Flash = { tone: "ok" | "warn" | "blocked"; text: string } | null;

export function FlashBar({ flash }: { flash: Flash }) {
  if (!flash) return null;
  return (
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
  );
}

/**
 * Receiving writes still waiting in the outbox. Screens fold them into server lists so a
 * receipt saved offline isn't offered again after a refresh.
 */
export function usePendingReceiving(onSynced?: () => void): ReceivingAction[] {
  const pending =
    useLiveQuery(async () => {
      const rows = await floorDb.outbox.where("status").equals("pending").sortBy("seq");
      return rows.flatMap((e) => (e.command.kind === "receiving" ? [e.command.action] : []));
    }, []) ?? EMPTY;
  // When a saved write leaves the queue, the server list is the truth again: reload it.
  const before = useRef(pending.length);
  const synced = useRef(onSynced);
  synced.current = onSynced;
  useEffect(() => {
    if (pending.length < before.current) synced.current?.();
    before.current = pending.length;
  }, [pending.length]);
  return pending;
}

const EMPTY: ReceivingAction[] = [];

export function ListFooter({
  list,
}: {
  list: Pick<CachedList<unknown>, "error" | "cachedAt" | "loading" | "refetch">;
}) {
  const { t, i18n } = useTranslation();
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-sm text-muted-foreground">
      <span>
        {list.error && list.cachedAt
          ? t("floor.common.cached", { time: time(list.cachedAt) })
          : null}
        {list.error && !list.cachedAt ? t("floor.receiving.noList") : null}
      </span>
      <button
        type="button"
        tabIndex={-1}
        onClick={list.refetch}
        className="flex min-h-12 items-center gap-1 rounded-md px-3 py-1 hover:bg-muted"
      >
        {list.loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        {t("floor.common.refresh")}
      </button>
    </div>
  );
}

const MAX_TYPED = 9999;

/** − n + with 64 px targets; the number can be typed too. */
export function Stepper({
  value,
  onChange,
  label,
  tone = "default",
  testId,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  tone?: "default" | "warn";
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${label} −1`}
        onClick={() => onChange(Math.max(0, value - 1))}
        className="flex size-16 items-center justify-center rounded-xl border-2 border-border bg-card active:bg-muted"
      >
        <Minus className="size-8" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={label}
        data-testid={testId}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          // A scanner firing into this box would type a whole UPC; ignore anything that big.
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n) && n <= MAX_TYPED) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={cn(
          "h-16 w-24 rounded-xl border-2 bg-background text-center text-3xl font-black tabular-nums",
          tone === "warn" ? "border-warning" : "border-border",
        )}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${label} +1`}
        onClick={() => onChange(value + 1)}
        className="flex size-16 items-center justify-center rounded-xl border-2 border-border bg-card active:bg-muted"
      >
        <Plus className="size-8" />
      </button>
    </div>
  );
}
