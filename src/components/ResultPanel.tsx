import { cn } from "@invai/ui";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type * as React from "react";
import type { ResultTone } from "../scan/result";

const TONE = {
  ok: { Icon: CheckCircle2, cls: "bg-success text-success-foreground" },
  blocked: { Icon: XCircle, cls: "bg-danger text-danger-foreground" },
  warn: { Icon: AlertTriangle, cls: "bg-warning text-warning-foreground" },
} as const;

/**
 * Full-screen scan verdict, readable from arm's length. Like `ScanResult` from @invai/ui,
 * plus an amber "saved offline" tone and a slot for the order/blank details.
 */
export function ResultPanel({
  tone,
  title,
  reason,
  children,
  actions,
}: {
  tone: ResultTone;
  title: string;
  reason?: string | null;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { Icon, cls } = TONE[tone];
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-tone={tone}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center",
        cls,
      )}
    >
      <div className="flex items-center gap-5">
        <Icon className="size-24 shrink-0" strokeWidth={1.75} aria-hidden />
        <h1 className="text-7xl font-black uppercase tracking-wide">{title}</h1>
      </div>
      {reason && <p className="text-4xl font-bold">{reason}</p>}
      {children}
      {actions && <div className="mt-2 flex w-full max-w-3xl gap-4">{actions}</div>}
    </div>
  );
}
