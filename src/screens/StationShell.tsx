import { STATIONS, type Station } from "@invai/contracts";
import {
  BigButton,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StationHeader,
} from "@invai/ui";
import { Lock, Menu, Package, ScanLine, ShieldCheck, Shirt, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { lock, setActiveStation, setAutoLockMinutes } from "../app/actions";
import { useApp, useSession } from "../app/store";
import { LangToggle } from "../components/LangToggle";
import { OfflineStrip, SyncStatus } from "../components/SyncStatus";
import { useSyncStore } from "../outbox/sync";
import { PackStation } from "../stations/PackStation";
import { PickStation } from "../stations/PickStation";
import { PressStation } from "../stations/PressStation";
import { QcStation } from "../stations/QcStation";

const ICONS = { pick: Shirt, press: ScanLine, qc: ShieldCheck, pack: Package } as const;

export function StationShell() {
  const { t } = useTranslation();
  const session = useSession();
  const station = useApp((s) => s.station);
  const active = useApp((s) => s.activeStation);
  const online = useSyncStore((s) => s.online);
  const fixedKind = station?.stationKind ?? null;

  if (!active) {
    return (
      <div className="flex h-full flex-col bg-background">
        <header className="flex h-16 items-center justify-between border-b border-border bg-card px-6">
          <span className="text-2xl font-bold">{t("floor.station.choose")}</span>
          <div className="flex items-center gap-3">
            <span className="text-lg text-muted-foreground">{session.user.name}</span>
            <LangToggle />
            <Button size="xl" variant="outline" onClick={() => void lock()}>
              <Lock /> {t("floor.header.lock")}
            </Button>
          </div>
        </header>
        <div className="grid flex-1 grid-cols-2 gap-6 p-8">
          {STATIONS.map((s) => {
            const Icon = ICONS[s];
            return (
              <BigButton
                key={s}
                className="h-full text-4xl"
                onClick={() => void setActiveStation(s)}
              >
                <Icon className="!size-14" aria-hidden />
                {t(`floor.station.${s}`)}
              </BigButton>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <StationHeader
        station={active}
        stationLabel={t(`floor.station.${active}`)}
        operatorName={session.user.name}
        online={online}
        className="h-18"
        actions={
          <>
            <SyncStatus hideOnline />
            <LangToggle />
            <Button
              size="xl"
              variant="outline"
              onClick={() => void lock()}
              data-testid="switch-staff"
            >
              <Users /> {t("floor.header.switchStaff")}
            </Button>
            <ShellMenu active={active} canSwitch={!fixedKind} />
          </>
        }
      />
      <OfflineStrip />
      <main className="relative min-h-0 flex-1">
        {active === "press" && <PressStation />}
        {active === "pick" && <PickStation />}
        {active === "qc" && <QcStation />}
        {active === "pack" && <PackStation />}
      </main>
    </div>
  );
}

function ShellMenu({ active, canSwitch }: { active: Station; canSwitch: boolean }) {
  const { t } = useTranslation();
  const minutes = useApp((s) => s.autoLockMinutes);
  const station = useApp((s) => s.station);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xl" variant="ghost" aria-label={t("floor.header.settings")}>
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 text-lg">
        <DropdownMenuLabel className="text-base">
          {station?.companyName} · {station?.stationName}
        </DropdownMenuLabel>
        {canSwitch && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("floor.header.stations")}</DropdownMenuLabel>
            {STATIONS.map((s) => (
              <DropdownMenuItem
                key={s}
                className="py-3 text-lg"
                disabled={s === active}
                onSelect={() => void setActiveStation(s)}
              >
                {t(`floor.station.${s}`)}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("floor.header.autoLock")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(minutes)}
          onValueChange={(v) => void setAutoLockMinutes(Number(v))}
        >
          {[2, 5, 10, 15, 30].map((m) => (
            <DropdownMenuRadioItem key={m} value={String(m)} className="py-2 text-lg">
              {t("floor.header.minutes", { count: m })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="py-3 text-lg" onSelect={() => void lock()}>
          <Lock /> {t("floor.header.lock")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
