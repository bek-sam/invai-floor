import { cn } from "@invai/ui";
import { useTranslation } from "react-i18next";
import { changeLang } from "../app/actions";

export function LangToggle({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const lang = i18n.language === "es" ? "es" : "en";
  return (
    <div className={cn("flex overflow-hidden rounded-lg border border-border", className)}>
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => void changeLang(l)}
          aria-pressed={lang === l}
          className={cn(
            "h-12 min-w-14 px-3 text-lg font-bold uppercase",
            lang === l ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
