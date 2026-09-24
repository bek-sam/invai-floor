import type { Station } from "@invai/contracts";
import { Button } from "@invai/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { queueScan } from "../outbox/db";
import { useWedgeScanner } from "../scanner/useWedgeScanner";

export function StationScreen({ station, onExit }: { station: Station; onExit: () => void }) {
  const { t } = useTranslation();
  const [last, setLast] = useState<string | null>(null);

  useWedgeScanner(async (code) => {
    setLast(code);
    await queueScan({ station, code });
    // TODO: show the server's match/mismatch result as a full-screen green or red panel
  });

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-8 bg-background">
      <h1 className="text-4xl font-semibold">{t(`station.${station}`)}</h1>
      <p className="text-3xl">{last ?? t("scan.ready")}</p>
      <Button size="floor" variant="outline" onClick={onExit}>
        ←
      </Button>
    </div>
  );
}
