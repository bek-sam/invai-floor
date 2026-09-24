import { useTranslation } from "react-i18next";
import { forgetStation } from "../app/actions";
import { useApp } from "../app/store";

export function DemoBanner() {
  const { t } = useTranslation();
  const demo = useApp((s) => s.station?.demo ?? false);
  if (!demo) return null;
  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-4 bg-info text-sm font-bold uppercase tracking-wide text-info-foreground">
      <span>{t("floor.demo.banner")}</span>
      <button
        type="button"
        className="rounded bg-black/20 px-2 py-0.5 text-xs"
        onClick={() => void forgetStation()}
      >
        {t("floor.demo.exit")}
      </button>
    </div>
  );
}
