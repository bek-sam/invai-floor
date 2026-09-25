import { DEMO_STATION_TOKEN } from "../api/demo";
import type { ApiFailure } from "../api/errors";
import type { FloorSession, QueueItem, Station } from "../api/types";
import { findCachedItem, invalidateQueues } from "../hooks/useStationQueue";
import { i18n, type Lang, setLang } from "../i18n";
import { transferIdOf } from "../lib/codes";
import { demoRequested } from "../lib/config";
import { feedback } from "../lib/feedback";
import { floorDb, kvDelete, kvGet, kvSet, type OutboxCommand, type OutboxUnit } from "../outbox/db";
import {
  type CurrentSession,
  discardEntry,
  parkForForgottenStation,
  resumeOwnEntries,
  retryParked,
  sendAsMe,
} from "../outbox/outbox";
import { type SubmitOutcome, SyncEngine } from "../outbox/sync";
import { sendReceiving } from "../stations/receiving/commands";
import { type AppState, getDemoApi, rpcApi, type StationConfig, useApp } from "./store";

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

/** The signed-in person, as the outbox needs it to tell whose entries are whose. */
export function currentSession(): CurrentSession | null {
  const s = useApp.getState().session;
  return s ? { token: s.sessionToken, userId: s.user.id, stationId: s.station.id } : null;
}

/** Leads (owner, admin, office) can retry or discard parked entries. */
export function isLead(session: FloorSession | null): boolean {
  return !!session && ["owner", "admin", "office"].includes(session.user.role);
}

export const engine = new SyncEngine({
  send: (command, token) => sendCommand(command, token),
  currentSession,
  onAuthExpired: () => {
    if (useApp.getState().session) void lock({ expired: true });
  },
  // The alert itself is on screen (SyncStatus); this is the sound.
  onReplayRejected: () => feedback("error"),
  onSent: () => invalidateQueues(),
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

/** Every write goes through the outbox, online or not. */
export async function submit(command: OutboxCommand): Promise<SubmitOutcome> {
  const session = useApp.getState().session;
  if (!session) throw new Error("Not signed in");
  return engine.submit(
    command,
    {
      sessionToken: session.sessionToken,
      staffName: session.user.name,
      staffId: session.user.id,
      stationId: session.station.id,
    },
    await unitOf(command).catch(() => null),
  );
}

/** Order, design and blank for the problems list, from the queues cached on this tablet. */
async function unitOf(command: OutboxCommand): Promise<OutboxUnit | null> {
  let item: QueueItem | null = null;
  let bin: string | null = null;
  switch (command.kind) {
    case "scan": {
      const id = transferIdOf(command.input.transferCode);
      item = await findCachedItem((i) => i.transferId === id || i.orderItemId === id);
      break;
    }
    case "qc":
      item = await findCachedItem((i) => i.orderItemId === command.input.orderItemId);
      break;
    case "reprint":
      item = await findCachedItem((i) => i.orderItemId === command.orderItemId);
      break;
    case "assignBin":
      bin = command.code;
      item = await findCachedItem((i) => i.orderId === command.orderId);
      break;
    case "releaseBin":
      bin = command.code;
      break;
    default:
      return null;
  }
  if (!item && !bin) return null;
  return {
    orderNo: item?.orderNo ?? null,
    design: item?.design.name ?? null,
    blank: item
      ? `${item.blank.brand} ${item.blank.style} ${item.blank.color} ${item.blank.size}`
      : null,
    bin: bin ?? item?.binCode ?? null,
  };
}

async function afterOutboxChange() {
  await engine.refreshCounts();
  engine.kick();
}

/** Lead: put parked entries back in the queue as they were. */
export async function retryEntries(ids: string[]) {
  const n = await retryParked(ids, currentSession());
  await afterOutboxChange();
  return n;
}

/** Lead: send an entry whose author's sign-in ended, recorded under the lead's own name. */
export async function sendEntryAsMe(id: string) {
  const s = useApp.getState().session;
  const current = currentSession();
  if (!s || !current || !isLead(s)) return false;
  const ok = await sendAsMe(id, { ...current, staffName: s.user.name });
  await afterOutboxChange();
  return ok;
}

/** Lead: drop a parked entry for good. */
export async function discardParked(id: string) {
  if (!isLead(useApp.getState().session)) return false;
  const ok = await discardEntry(id);
  await afterOutboxChange();
  return ok;
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
  void requestPersistentStorage();
}

/** Ask the browser not to evict IndexedDB (the outbox) under storage pressure. */
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return;
    const granted = (await navigator.storage.persisted?.()) || (await navigator.storage.persist());
    await kvSet("storagePersisted", granted);
  } catch {
    // Not supported (old WebView, private mode): the outbox still works, just evictable.
  }
}

export async function connectDemoStation() {
  const d = demoStationConfig();
  await connectStation(d, true);
}

/**
 * Unsent entries are parked as `station_forgotten` first, so they are never replayed under the
 * next station; the login screen warns with the count before calling this.
 */
export async function forgetStation() {
  await parkForForgottenStation();
  await engine.refreshCounts();
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
  // Their own entries parked because their earlier sign-in ended go back in the queue.
  await resumeOwnEntries({
    token: session.sessionToken,
    userId: session.user.id,
    stationId: session.station.id,
  });
  await engine.refreshCounts();
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
