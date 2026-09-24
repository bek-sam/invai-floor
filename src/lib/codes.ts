/**
 * Scanner code formats (see ScanInput in @invai/contracts): transfer QR `T:<transferId>`,
 * blank label `B:<blankVariantId>` or a supplier UPC, tote/bin `BIN:<code>`. Raw codes are
 * always sent to the server unchanged; this only helps the tablet decide which step a scan
 * belongs to.
 */
export type CodeKind = "transfer" | "blank" | "bin" | "unknown";

export type ParsedCode = { kind: CodeKind; value: string; raw: string };

export function parseCode(raw: string): ParsedCode {
  const code = raw.trim();
  const upper = code.toUpperCase();
  if (upper.startsWith("BIN:")) return { kind: "bin", value: code.slice(4), raw: code };
  if (upper.startsWith("T:")) return { kind: "transfer", value: code.slice(2), raw: code };
  if (upper.startsWith("B:")) return { kind: "blank", value: code.slice(2), raw: code };
  if (/^\d{12,14}$/.test(code)) return { kind: "blank", value: code, raw: code }; // UPC/EAN/GTIN
  return { kind: "unknown", value: code, raw: code };
}

/** Transfer id from a code, if the code names one (`T:<id>` or a bare id). */
export function transferIdOf(raw: string): string {
  const p = parseCode(raw);
  return p.kind === "transfer" ? p.value : p.raw;
}

export type StationQrPayload = {
  token: string;
  stationName?: string;
  stationKind?: string;
  companyName?: string;
};

/**
 * The station-token QR shown by the web app. Accepts, in order: JSON
 * `{"token","station","kind","company"}`, a URL with `?token=&station=&kind=&company=`,
 * `STATION:<token>`, or the bare token.
 */
export function parseStationQr(raw: string): StationQrPayload | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const token = typeof j.token === "string" ? j.token : null;
      if (!token) return null;
      const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
      return {
        token,
        stationName: s("station") ?? s("stationName") ?? s("name"),
        stationKind: s("kind") ?? s("stationKind"),
        companyName: s("company") ?? s("companyName"),
      };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      const token = u.searchParams.get("token") ?? u.hash.replace(/^#/, "");
      if (!token) return null;
      return {
        token,
        stationName: u.searchParams.get("station") ?? undefined,
        stationKind: u.searchParams.get("kind") ?? undefined,
        companyName: u.searchParams.get("company") ?? undefined,
      };
    } catch {
      return null;
    }
  }
  if (/^STATION:/i.test(text)) return { token: text.slice(8) };
  if (/\s/.test(text)) return null;
  return { token: text };
}
