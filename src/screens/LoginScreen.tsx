import { BigButton, PinPad } from "@invai/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toFailure } from "../api/errors";
import { forgetStation, login } from "../app/actions";
import { useApp } from "../app/store";
import { LangToggle } from "../components/LangToggle";
import { SyncStatus } from "../components/SyncStatus";
import { floorDb } from "../outbox/db";
import { useScan } from "../scanner/useWedgeScanner";

/** PIN login on a paired station. Scanning a badge with the PIN encoded works too. */
export function LoginScreen() {
  const { t } = useTranslation();
  const station = useApp((s) => s.station);
  const expired = useApp((s) => s.sessionExpired);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = useLiveQuery(
    () => floorDb.staffPrefs.orderBy("lastLoginAt").reverse().limit(6).toArray(),
    [],
  );

  async function submit(value: string) {
    setBusy(true);
    setError(null);
    try {
      await login(value);
    } catch (err) {
      const f = toFailure(err);
      setPin("");
      if (f.code === "INVALID_PIN" || f.kind === "auth") setError(t("floor.login.wrongPin"));
      else if (f.code === "STATION_INACTIVE") setError(t("floor.login.stationInactive"));
      else if (f.retryable)
        setError(
          f.code === "NOT_IMPLEMENTED"
            ? t("floor.common.notImplemented", { code: f.code })
            : t("floor.login.offline"),
        );
      else setError(`${f.message} (${f.code})`);
    } finally {
      setBusy(false);
    }
  }

  // Physical keyboards: digits, Backspace and Enter work on the PIN pad too.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy) return;
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 6 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter" && pin.length >= 4) void submit(pin);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A badge barcode carrying the PIN (e.g. `PIN:1155`) logs in directly.
  useScan((code) => {
    const m = /^(?:PIN:)?(\d{4,6})$/i.exec(code);
    if (m?.[1]) void submit(m[1]);
  });

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-[38%] flex-col justify-between border-r border-border bg-card p-8">
        <div className="flex flex-col gap-2">
          <p className="text-lg text-muted-foreground">
            {station?.companyName ?? t("floor.app.title")}
          </p>
          <h1 className="text-4xl font-bold">{station?.stationName ?? t("floor.setup.station")}</h1>
          {station?.stationKind && (
            <p className="text-2xl font-semibold text-primary">
              {t(`floor.station.${station.stationKind}`)}
            </p>
          )}
        </div>
        {recent && recent.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold uppercase text-muted-foreground">
              {t("floor.login.recent")}
            </p>
            <ul className="flex flex-wrap gap-2">
              {recent.map((r) => (
                <li key={r.userId} className="rounded-full bg-muted px-4 py-2 text-lg">
                  {r.name} <span className="text-sm uppercase text-muted-foreground">{r.lang}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <SyncStatus />
          <button
            type="button"
            className="text-sm text-muted-foreground underline"
            onClick={() => {
              if (window.confirm(t("floor.setup.forgetConfirm"))) void forgetStation();
            }}
          >
            {t("floor.setup.forget")}
          </button>
        </div>
      </aside>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 [&>*]:shrink-0">
        <div className="flex w-full max-w-md items-center justify-between">
          <h2 className="text-3xl font-bold">
            {busy ? t("floor.login.signingIn") : t("floor.login.title")}
          </h2>
          <LangToggle />
        </div>
        {expired && (
          <p className="max-w-md text-center text-lg text-warning-foreground">
            {t("floor.offline.sessionExpired")}
          </p>
        )}
        {/* PINs are 4-6 digits, so the pad is 6 long and Enter submits (PinPad only auto-completes at a fixed length). */}
        <PinPad
          length={6}
          value={pin}
          onChange={(v) => {
            setError(null);
            setPin(v);
          }}
          onComplete={(v) => void submit(v)}
          disabled={busy}
          error={!!error}
          className="[&_button]:size-[5.25rem] [&_button]:text-4xl"
        />
        <BigButton
          className="max-w-[20.5rem]"
          disabled={busy || pin.length < 4}
          onClick={() => void submit(pin)}
        >
          <LogIn aria-hidden />
          {t("action.confirm")}
        </BigButton>
        <p role="alert" className="h-8 text-2xl font-semibold text-danger">
          {error}
        </p>
      </main>
    </div>
  );
}
