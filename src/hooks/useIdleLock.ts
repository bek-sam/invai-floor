import { useEffect } from "react";
import { lock, touchActivity } from "../app/actions";
import { useApp } from "../app/store";

const EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/** Locks back to the PIN pad after `autoLockMinutes` without a touch or a scan. */
export function useIdleLock() {
  const signedIn = useApp((s) => s.session !== null);
  const minutes = useApp((s) => s.autoLockMinutes);

  useEffect(() => {
    if (!signedIn || minutes <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void lock(), minutes * 60_000);
      void touchActivity();
    };
    arm();
    for (const e of EVENTS) window.addEventListener(e, arm, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, arm, { capture: true });
    };
  }, [signedIn, minutes]);
}
