import { STATIONS, type Station } from "@invai/contracts";
import { BigButton } from "@invai/ui";
import { QrCode } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toFailure } from "../api/errors";
import { connectDemoStation, connectStation } from "../app/actions";
import { LangToggle } from "../components/LangToggle";
import { parseStationQr } from "../lib/codes";
import { useScan } from "../scanner/useWedgeScanner";

/** First run: pair the tablet with a station by scanning its QR (or pasting the token). */
export function SetupScreen() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(raw: string) {
    const payload = parseStationQr(raw);
    if (!payload) return setError(t("floor.setup.invalid"));
    setBusy(true);
    setError(null);
    try {
      const kind = STATIONS.includes(payload.stationKind as Station)
        ? (payload.stationKind as Station)
        : null;
      await connectStation({
        token: payload.token,
        stationId: null,
        stationName: payload.stationName ?? null,
        stationKind: kind,
        companyName: payload.companyName ?? null,
      });
    } catch (err) {
      const f = toFailure(err);
      setError(f.retryable ? t("floor.setup.offline") : `${t("floor.setup.rejected")} (${f.code})`);
    } finally {
      setBusy(false);
    }
  }

  useScan((code) => {
    setText(code);
    void connect(code);
  });

  return (
    <div className="flex h-full items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-4xl font-bold">{t("floor.setup.title")}</h1>
            <p className="mt-2 text-xl text-muted-foreground">{t("floor.setup.subtitle")}</p>
          </div>
          <LangToggle />
        </div>
        <div className="flex items-center gap-6 rounded-2xl border-2 border-dashed border-border p-6">
          <QrCode className="size-24 shrink-0 text-muted-foreground" aria-hidden />
          <form
            className="flex flex-1 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void connect(text);
            }}
          >
            <label htmlFor="station-token" className="text-lg font-semibold">
              {t("floor.setup.tokenLabel")}
            </label>
            <input
              id="station-token"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-16 rounded-xl border border-input bg-background px-4 font-mono text-lg"
            />
            <BigButton type="submit" disabled={busy || !text.trim()}>
              {busy ? t("floor.setup.checking") : t("floor.setup.connect")}
            </BigButton>
          </form>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-danger p-4 text-xl font-semibold text-danger-foreground"
          >
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => void connectDemoStation()}
          className="self-center text-lg text-muted-foreground underline underline-offset-4"
        >
          {t("floor.setup.tryDemo")}
        </button>
      </div>
    </div>
  );
}
