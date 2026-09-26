import { Button } from "@invai/ui";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

/**
 * A new app version is installed and waiting. It is applied only when someone taps Update,
 * never by itself, so a reload can't land in the middle of a pack or a press check.
 */
const useUpdate = create<{ apply: (() => void) | null }>(() => ({ apply: null }));
let asked = false;

/** The service worker has a new version waiting; `apply` activates it. */
export function setUpdateReady(apply: () => void) {
  useUpdate.setState({ apply });
}

/** The new version took control. Reload only if this tablet asked for it. */
export function reloadIfAsked() {
  if (asked) window.location.reload();
}

/** The waiting version's activate function, or null (the "Update needed" screen uses it too). */
export function useUpdateReady() {
  return useUpdate((s) => s.apply);
}

/** Activate the waiting version and reload when it takes control. */
export function applyUpdate(apply: () => void) {
  asked = true;
  apply();
}

export function UpdatePrompt() {
  const { t } = useTranslation();
  const apply = useUpdate((s) => s.apply);
  if (!apply) return null;
  return (
    <Button size="xl" variant="outline" data-testid="update-app" onClick={() => applyUpdate(apply)}>
      <RefreshCw /> {t("floor.header.update")}
    </Button>
  );
}
