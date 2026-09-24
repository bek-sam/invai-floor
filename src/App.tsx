import { STATIONS, type Station } from "@invai/contracts";
import { Button } from "@invai/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StationScreen } from "./stations/StationScreen";

export function App() {
  const { t } = useTranslation();
  const [station, setStation] = useState<Station | null>(null);

  if (station) return <StationScreen station={station} onExit={() => setStation(null)} />;

  return (
    <div className="grid h-screen grid-cols-2 gap-6 bg-background p-10">
      {STATIONS.map((s) => (
        <Button key={s} size="floor" className="h-full" onClick={() => setStation(s)}>
          {t(`station.${s}`)}
        </Button>
      ))}
    </div>
  );
}
