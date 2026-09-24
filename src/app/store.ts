import { create } from "zustand";
import { createDemoApi } from "../api/demo";
import { createRpcApi } from "../api/rpc";
import type { FloorApi, FloorSession, Station } from "../api/types";
import { DEFAULT_AUTO_LOCK_MINUTES } from "../lib/config";

export type StationConfig = {
  token: string;
  /** From the QR payload before the first login, then from the floor session. */
  stationId: string | null;
  stationName: string | null;
  stationKind: Station | null;
  companyName: string | null;
  demo: boolean;
  connectedAt: string;
};

export type LiveStatus = "off" | "connecting" | "open" | "closed";

export type AppState = {
  ready: boolean;
  api: FloorApi;
  station: StationConfig | null;
  session: FloorSession | null;
  /** The screen in use: the station's fixed kind, or what staff picked when it has none. */
  activeStation: Station | null;
  autoLockMinutes: number;
  live: LiveStatus;
  /** Set when the outbox hit an expired session; the PIN screen explains why. */
  sessionExpired: boolean;
};

export const rpcApi = createRpcApi();
let demoApi: FloorApi | null = null;
export function getDemoApi() {
  demoApi ??= createDemoApi();
  return demoApi;
}

export const useApp = create<AppState>(() => ({
  ready: false,
  api: rpcApi,
  station: null,
  session: null,
  activeStation: null,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  live: "off",
  sessionExpired: false,
}));

/** The signed-in session; screens under the station shell can rely on it. */
export function useSession(): FloorSession {
  const session = useApp((s) => s.session);
  if (!session) throw new Error("No floor session");
  return session;
}

export function currentToken(): string | null {
  return useApp.getState().session?.sessionToken ?? null;
}
