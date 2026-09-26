import { CONTRACT_VERSION } from "@invai/contracts";
import { BigButton } from "@invai/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { LangToggle } from "../components/LangToggle";
import { applyUpdate, useUpdateReady } from "../components/UpdatePrompt";

export type TooOld = { minVersion: string | null; current: string };

/**
 * The server answered CLIENT_TOO_OLD (426): this app's contract version is below the backend's
 * minimum (T-13-1, ADR 0012). Set once and kept until the page reloads on the new version.
 */
export const useTooOld = create<{ tooOld: TooOld | null }>(() => ({ tooOld: null }));

export function reportTooOld(data: unknown) {
  const min = (data as { minVersion?: unknown } | null)?.minVersion;
  useTooOld.setState({
    tooOld: { minVersion: typeof min === "string" ? min : null, current: CONTRACT_VERSION },
  });
}

/**
 * The whole tablet is blocked until it updates: an old app must not keep writing old shapes.
 * Update uses the T-4-4 service-worker prompt when a new version is waiting; otherwise it asks the
 * service worker to look for one (and reloads when there is no service worker at all). Queued
 * scans stay in IndexedDB and replay from the new version.
 */
export function UpdateNeededScreen() {
  const { t } = useTranslation();
  const tooOld = useTooOld((s) => s.tooOld);
  const apply = useUpdateReady();
  const [checking, setChecking] = useState(false);

  async function update() {
    if (apply) {
      applyUpdate(apply);
      return;
    }
    setChecking(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.update();
      // A new version found now shows up as `apply` (onNeedRefresh). Nothing to wait for without
      // a service worker, or if none was found: reload and ask the server again.
      if (!reg?.installing && !reg?.waiting) window.location.reload();
    } catch {
      window.location.reload();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div
      className="flex h-full items-center justify-center bg-background p-8"
      data-testid="update-needed"
    >
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-start justify-between gap-6">
          <h1 className="text-4xl font-bold">{t("floor.updateNeeded.title")}</h1>
          <LangToggle />
        </div>
        <p className="text-2xl">{t("floor.updateNeeded.body")}</p>
        <BigButton onClick={() => void update()} disabled={checking} data-testid="update-needed-go">
          <RefreshCw />{" "}
          {checking ? t("floor.updateNeeded.checking") : t("floor.updateNeeded.button")}
        </BigButton>
        {tooOld && (
          <p className="text-lg text-muted-foreground">
            {t("floor.updateNeeded.versions", {
              current: tooOld.current,
              min: tooOld.minVersion ?? "?",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
