import { ScanLine } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { emitScan } from "../scanner/bus";

/** Dev helper: type or paste a code and send it as if a scanner read it. */
export function SimulateScan() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("floor.dev.simulate")}
        className="fixed bottom-3 left-3 z-50 rounded-full bg-foreground/10 p-3 text-foreground/40 hover:text-foreground"
      >
        <ScanLine className="size-5" />
      </button>
    );
  }
  return (
    <form
      className="fixed bottom-3 left-3 z-50 flex gap-2 rounded-xl border border-border bg-card p-2 shadow-lg"
      onSubmit={(e) => {
        e.preventDefault();
        emitScan(code, "simulate");
        setCode("");
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: dev tool opened on purpose
        autoFocus
        data-testid="simulate-scan"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder={t("floor.dev.placeholder")}
        className="w-96 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
      />
      <button
        type="submit"
        className="rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
      >
        {t("floor.dev.send")}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="px-2 text-muted-foreground">
        ×
      </button>
    </form>
  );
}
