import { cn } from "@invai/ui";
import { Boxes, ClipboardList, Layers } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PoReceive } from "./PoReceive";
import { SheetReceive } from "./SheetReceive";
import { StockCount } from "./StockCount";

type Mode = "po" | "sheets" | "count";

const MODES = [
  { mode: "po", Icon: ClipboardList, key: "floor.receiving.tabPo" },
  { mode: "sheets", Icon: Layers, key: "floor.receiving.tabSheets" },
  { mode: "count", Icon: Boxes, key: "floor.receiving.tabCount" },
] as const;

/** Receiving desk: blank purchase orders, vendor transfer sheets and stock counts. */
export function ReceivingStation() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("po");
  return (
    <div className="flex h-full flex-col">
      <div role="tablist" className="flex shrink-0 gap-2 border-b border-border bg-card px-4 py-2">
        {MODES.map(({ mode: m, Icon, key }) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`receiving-tab-${m}`}
            onClick={() => setMode(m)}
            className={cn(
              "flex h-16 flex-1 items-center justify-center gap-3 rounded-xl text-2xl font-bold",
              mode === m
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted",
            )}
          >
            <Icon className="size-8" aria-hidden />
            {t(key)}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {mode === "po" && <PoReceive />}
        {mode === "sheets" && <SheetReceive />}
        {mode === "count" && <StockCount />}
      </div>
    </div>
  );
}
