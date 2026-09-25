import { toast } from "@invai/ui";
import { DEMO_STATION_TOKEN } from "../api/demo";
import type { ApiFailure } from "../api/errors";
import type { FloorSession, ScanResult, Station } from "../api/types";
import { i18n, type Lang, setLang } from "../i18n";
import { demoRequested } from "../lib/config";
import { feedback } from "../lib/feedback";
import {
  floorDb,
  kvDelete,
  kvGet,
  kvSet,
  type OutboxCommand,
  type OutboxEntry,
} from "../outbox/db";
import { type SubmitOutcome, SyncEngine } from "../outbox/sync";
import { sendReceiving } from "../stations/receiving/commands";
import {
  type AppState,
  currentToken,
  getDemoApi,
  rpcApi,
  type StationConfig,
  useApp,
} from "./store";

const K = {
  station: "station",
  session: "session",
  activeStation: "activeStation",
  autoLock: "autoLockMinutes",
  lastActivity: "lastActivityAt",
} as const;

function apiFor(station: StationConfig | null) {
  return station?.demo ? getDemoApi() : rpcApi;
}

/** Scans that were saved offline; when they replay, a red result must still reach someone. */
const awaitingReplay = new Set<string>();

export const engine = new SyncEngine({
  send: (command, token) => sendCommand(command, token),
  currentSessionToken: currentToken,
  onAuthExpired: () => {
    if (useApp.getState().session) void lock({ expired: true });
  },
  onReplayed: (entries) => notifyReplayed(entries),
});

function sendCommand(command: OutboxCommand, token: string): Promise<unknown> {
  const api = useApp.getState().api;
  switch (command.kind) {
    case "scan":
      return api.scan(token, command.input);
    case "qc":
      return api.qc(token, command.input);
    case "assignBin":
      return api.assignBin(token, command.code, command.orderId);
    case "releaseBin":
      return api.releaseBin(token, command.code);
    case "reprint":
      return api.requestReprint(token, command.orderItemId, command.reason, command.note);
    case "receiving":
      return sendReceiving(command, token, api.kind);
  }
}

function notifyReplayed(entries: OutboxEntry[]) {
  for (const e of entries) {
    if (!awaitingReplay.delete(e.id)) continue;
    if (e.command.kind !== "scan") continue;
    const r = e.result as ScanResult | null;
    if (e.status === "failed" || (r && !r.ok)) {
      feedback("error");
      const reason = r?.mismatch ? i18n.t(`floor.mismatch.${r.mismatch}`) : (e.lastError ?? "");
      toast.error(i18n.t("floor.press.replayBlocked", { orderNo: r?.orderNo ?? "?", reason }), {
        duration: 20_000,
      });
    }
  }
}

/** Every write goes through the outbox, online or not. */
export async function submit(command: OutboxCommand): Promise<SubmitOutcome> {
  const session = useApp.getState().session;
  if (!session) throw new Error("Not signed in");
  const outcome = await engine.submit(command, {
    sessionToken: session.sessionToken,
    staffName: session.user.name,
  });
  if (outcome.status === "queued") awaitingReplay.add(outcome.entry.id);
  return outcome;
}

export function queuedReason(outcome: SubmitOutcome): ApiFailure | null {
  return outcome.status === "queued" ? outcome.reason : null;
}

export async function bootstrap() {
  const [station, session, activeStation, autoLock, lastActivity] = await Promise.all([
    kvGet<StationConfig>(K.station),
    kvGet<FloorSession>(K.session),
    kvGet<Station>(K.activeStation),
    kvGet<number>(K.autoLock),
    kvGet<string>(K.lastActivity),
  ]);
  const autoLockMinutes = autoLock ?? useApp.getState().autoLockMinutes;
  const fresh =
    session &&
    Date.parse(session.expiresAt) > Date.now() &&
    lastActivity !== undefined &&
    Date.now() - Date.parse(lastActivity) < autoLockMinutes * 60_000;

  let st = station ?? null;
  if (!st && demoRequested()) st = demoStationConfig();

  useApp.setState({
    ready: true,
    station: st,
    api: apiFor(st),
    session: st && fresh ? session : null,
    activeStation: st?.stationKind ?? activeStation ?? null,
    autoLockMinutes,
  });
  if (st && fresh && session) await applyStaffLang(session.user.id, session.user.name);
  if (!fresh && session) await kvDelete(K.session);
}

function demoStationConfig(): StationConfig {
  return {
    token: DEMO_STATION_TOKEN,
    stationId: null,
    stationName: "Demo station",
    stationKind: null,
    companyName: "Desert Bloom Tees (demo)",
    demo: true,
    connectedAt: new Date().toISOString(),
  };
}

export async function connectStation(
  config: Omit<StationConfig, "connectedAt" | "demo">,
  demo = false,
) {
  const station: StationConfig = { ...config, demo, connectedAt: new Date().toISOString() };
  const api = apiFor(station);
  await api.stationStaff(station.token); // throws when the token is wrong or the API is down
  await kvSet(K.station, station);
  useApp.setState({ station, api, activeStation: station.stationKind, session: null });
}

export async function connectDemoStation() {
  const d = demoStationConfig();
  await connectStation(d, true);
}

export async function forgetStation() {
  await logout();
  await Promise.all([kvDelete(K.station), kvDelete(K.activeStation), floorDb.queueCache.clear()]);
  useApp.setState({ station: null, api: rpcApi, activeStation: null });
}

export async function login(pin: string): Promise<FloorSession> {
  const { station, api } = useApp.getState();
  if (!station) throw new Error("No station");
  const session = await api.login(station.token, pin);
  // The session knows the real station; the org name comes from me.get.
  const org = await api.org(session.sessionToken).catch(() => null);
  const updated: StationConfig = {
    ...station,
    stationId: session.station.id,
    stationName: session.station.name,
    stationKind: session.station.kind ?? station.stationKind,
    companyName: org?.name ?? station.companyName,
  };
  await Promise.all([kvSet(K.station, updated), kvSet(K.session, session), touchActivity(true)]);
  useApp.setState((s: AppState) => ({
    session,
    station: updated,
    sessionExpired: false,
    activeStation: updated.stationKind ?? s.activeStation,
  }));
  await applyStaffLang(session.user.id, session.user.name);
  engine.kick(); // sync anything saved while nobody was signed in
  return session;
}

async function applyStaffLang(userId: string, name: string) {
  const pref = await floorDb.staffPrefs.get(userId);
  const lang: Lang = pref?.lang ?? ((i18n.language as Lang) === "es" ? "es" : "en");
  await floorDb.staffPrefs.put({ userId, name, lang, lastLoginAt: new Date().toISOString() });
  await setLang(lang, false);
}

export async function changeLang(lang: Lang) {
  const session = useApp.getState().session;
  await setLang(lang, !session);
  if (session) {
    await floorDb.staffPrefs.put({
      userId: session.user.id,
      name: session.user.name,
      lang,
      lastLoginAt: new Date().toISOString(),
    });
  }
}

/** Back to the PIN pad. Queued scans stay in the outbox and sync after the next login. */
export async function lock(opts: { expired?: boolean } = {}) {
  const { session, api } = useApp.getState();
  useApp.setState({ session: null, sessionExpired: !!opts.expired });
  await kvDelete(K.session);
  if (session && !opts.expired) {
    // Revoking is best effort: offline tablets just drop the token.
    void api.logout(session.sessionToken).catch(() => {});
  }
}

export const logout = () => lock();

export async function setActiveStation(station: Station | null) {
  useApp.setState({ activeStation: station });
  if (station) await kvSet(K.activeStation, station);
  else await kvDelete(K.activeStation);
}

export async function setAutoLockMinutes(minutes: number) {
  useApp.setState({ autoLockMinutes: minutes });
  await kvSet(K.autoLock, minutes);
}

let lastWrite = 0;
/** Records activity (throttled to one IndexedDB write per 15 s) so a reload honors auto-lock. */
export async function touchActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 15_000) return;
  lastWrite = now;
  await kvSet(K.lastActivity, new Date(now).toISOString());
}
