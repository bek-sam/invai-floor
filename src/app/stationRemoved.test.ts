import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../api/errors";
import type { FloorApi, FloorSession } from "../api/types";
import { floorDb, kvGet, kvSet } from "../outbox/db";
import { enqueue } from "../outbox/outbox";
import { login, onAuthFailure } from "./actions";
import { type StationConfig, useApp } from "./store";

const station: StationConfig = {
  token: "st1.revoked",
  stationId: "s1",
  stationName: "Pack 1",
  stationKind: "pack",
  companyName: "Desert Bloom Tees",
  demo: false,
  connectedAt: new Date().toISOString(),
};
const session = {
  sessionToken: "fs1",
  user: { id: "u1", name: "Ana", role: "packer" },
  station: { id: "s1", name: "Pack 1", kind: "pack" },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
} as unknown as FloorSession;

const unauthorized = () =>
  new ApiFailure("auth", "UNAUTHORIZED", "Station token not recognized", 401);

function fakeApi(stationKnown: boolean, loginError: ApiFailure): FloorApi {
  return {
    kind: "rpc",
    stationStaff: vi.fn(async () => {
      if (!stationKnown) throw unauthorized();
      return [];
    }),
    login: vi.fn(async () => {
      throw loginError;
    }),
    logout: vi.fn(async () => {}),
  } as unknown as FloorApi;
}

async function pairWith(api: FloorApi, signedIn: boolean) {
  await kvSet("station", station);
  useApp.setState({ station, api, session: signedIn ? session : null, stationRemoved: false });
}

describe("a tablet whose station token was revoked", () => {
  beforeEach(async () => {
    await floorDb.outbox.clear();
  });

  it("a 401 while signed in unpairs it, keeps the outbox and says why", async () => {
    await pairWith(fakeApi(false, unauthorized()), true);
    await enqueue(
      {
        kind: "releaseBin",
        code: "BIN-1",
      },
      { sessionToken: "fs1", staffName: "Ana", staffId: "u1", stationId: "s1" },
    );
    await onAuthFailure();
    const s = useApp.getState();
    expect(s.station).toBeNull();
    expect(s.session).toBeNull();
    expect(s.stationRemoved).toBe(true);
    expect(await kvGet("station")).toBeUndefined();
    const entries = await floorDb.outbox.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "parked", parkReason: "station_forgotten" });
  });

  it("a 401 with the station still known only ends the session", async () => {
    await pairWith(fakeApi(true, unauthorized()), true);
    await onAuthFailure();
    const s = useApp.getState();
    expect(s.station).toEqual(station);
    expect(s.session).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(s.stationRemoved).toBe(false);
  });

  it("PIN login on a revoked station goes to setup, not 'wrong PIN'", async () => {
    await pairWith(fakeApi(false, unauthorized()), false);
    await expect(login("1234")).rejects.toMatchObject({ code: "STATION_REVOKED" });
    expect(useApp.getState()).toMatchObject({ station: null, stationRemoved: true });
  });

  it("a wrong PIN stays a wrong PIN", async () => {
    const api = fakeApi(true, new ApiFailure("rejected", "INVALID_PIN", "PIN not recognized", 401));
    await pairWith(api, false);
    await expect(login("0000")).rejects.toMatchObject({ code: "INVALID_PIN" });
    expect(useApp.getState().station).toEqual(station);
    expect(api.stationStaff).not.toHaveBeenCalled();
  });
});
