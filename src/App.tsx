import { Toaster } from "@invai/ui";
import { useApp } from "./app/store";
import { DemoBanner } from "./components/DemoBanner";
import { SimulateScan } from "./components/SimulateScan";
import { useIdleLock } from "./hooks/useIdleLock";
import { useRealtime } from "./hooks/useRealtime";
import { devToolsEnabled } from "./lib/config";
import { useWedgeListener } from "./scanner/useWedgeScanner";
import { LoginScreen } from "./screens/LoginScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { StationShell } from "./screens/StationShell";

export function App() {
  const ready = useApp((s) => s.ready);
  const station = useApp((s) => s.station);
  const signedIn = useApp((s) => s.session !== null);
  const demo = useApp((s) => s.station?.demo ?? false);

  useWedgeListener();
  useIdleLock();
  useRealtime();

  if (!ready) return null;
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <DemoBanner />
      <div className="relative min-h-0 flex-1">
        {!station ? <SetupScreen /> : !signedIn ? <LoginScreen /> : <StationShell />}
      </div>
      {(devToolsEnabled() || demo) && <SimulateScan />}
      <Toaster position="top-center" richColors toastOptions={{ className: "text-lg" }} />
    </div>
  );
}
