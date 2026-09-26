import { CONTRACT_VERSION } from "@invai/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiFailure, classifyStatus } from "../api/errors";
import type { ScanInput, ScanResult } from "../api/types";
import { uuid } from "../lib/uuid";
import { FloorDB, type OutboxCommand, type OutboxEntry } from "./db";
import {
  canRetry,
  canSendAsMe,
  discardEntry,
  enqueue,
  flushOutbox,
  isStaleVersion,
  MAX_ATTEMPTS,
  parkedCount,
  parkForForgottenStation,
  resumeOwnEntries,
  retryParked,
  sendAsMe,
  unresolvedEntries,
} from "./outbox";
import { SyncEngine, useSyncStore } from "./sync";

const session = { sessionToken: "tok-a", staffName: "Ana" };

function scan(code: string, clientScanId = uuid()): OutboxCommand {
  const input: ScanInput = {
    clientScanId,
    station: "press",
    transferCode: code,
    blankCode: "B:blank",
    scannedAt: new Date().toISOString(),
  };
  return { kind: "scan", input };
}

/**
 * A fake server that behaves like the real one: it applies scans once per clientScanId and
 * returns the stored result for a repeat.
 */
function fakeServer() {
  const stored = new Map<string, ScanResult>();
  const applied: string[] = [];
  let down = false;
  const send = async (command: OutboxCommand, token: string) => {
    if (down) throw new ApiFailure("offline", "NETWORK", "offline");
    if (token === "expired") throw new ApiFailure("auth", "UNAUTHORIZED", "expired", 401);
    if (command.kind !== "scan") return { ok: true };
    const { clientScanId, transferCode } = command.input;
    if (transferCode === "T:bad") throw new ApiFailure("rejected", "BAD_REQUEST", "bad input", 400);
    const prior = stored.get(clientScanId);
    if (prior) return prior;
    applied.push(transferCode);
    const result = {
      ok: true,
      clientScanId,
      orderNo: `#${applied.length}`,
    } as unknown as ScanResult;
    stored.set(clientScanId, result);
    return result;
  };
  return {
    send,
    applied,
    stored,
    setDown: (v: boolean) => {
      down = v;
    },
  };
}

let db: FloorDB;

beforeEach(() => {
  db = new FloorDB(`test-${uuid()}`);
});

afterEach(async () => {
  await db.delete();
});

describe("outbox", () => {
  it("replays queued scans in the order they were taken", async () => {
    const server = fakeServer();
    server.setDown(true);
    for (const code of ["T:1", "T:2", "T:3", "T:4"]) await enqueue(scan(code), session, db);

    const offline = await flushOutbox(server.send, { db });
    expect(offline.stoppedBy?.kind).toBe("offline");
    expect(await db.outbox.where("status").equals("pending").count()).toBe(4);

    server.setDown(false);
    const report = await flushOutbox(server.send, { db });
    expect(report).toMatchObject({ sent: 4, parked: [], stoppedBy: null });
    expect(server.applied).toEqual(["T:1", "T:2", "T:3", "T:4"]);
  });

  it("stops at the first retryable failure so later scans never overtake earlier ones", async () => {
    let calls = 0;
    const flaky = async (command: OutboxCommand) => {
      calls++;
      if (command.kind === "scan" && command.input.transferCode === "T:2") {
        throw new ApiFailure("unavailable", "NOT_IMPLEMENTED", "not yet", 501);
      }
      return { ok: true };
    };
    for (const code of ["T:1", "T:2", "T:3"]) await enqueue(scan(code), session, db);
    const report = await flushOutbox(flaky, { db });
    expect(report.sent).toBe(1);
    expect(report.stoppedBy?.code).toBe("NOT_IMPLEMENTED");
    expect(calls).toBe(2);
    const rows = await db.outbox.orderBy("seq").toArray();
    expect(rows.map((r) => r.status)).toEqual(["done", "pending", "pending"]);
  });

  it("parks a rejected command at once and keeps going", async () => {
    const server = fakeServer();
    for (const code of ["T:1", "T:bad", "T:3"]) await enqueue(scan(code), session, db);
    const report = await flushOutbox(server.send, { db });
    expect(report.sent).toBe(2);
    expect(report.parked.map((e) => e.parkReason)).toEqual(["rejected"]);
    expect(server.applied).toEqual(["T:1", "T:3"]);
    const bad = (await db.outbox.orderBy("seq").toArray())[1];
    expect(bad).toMatchObject({ status: "parked", errorCode: "BAD_REQUEST", attempts: 1 });
    expect(bad?.parkedAt).toBeTruthy();
  });

  it("is idempotent: enqueueing the same clientScanId twice sends it once", async () => {
    const server = fakeServer();
    const id = uuid();
    await enqueue(scan("T:1", id), session, db);
    await enqueue(scan("T:1", id), session, db);
    expect(await db.outbox.count()).toBe(1);
    await flushOutbox(server.send, { db });
    expect(server.applied).toEqual(["T:1"]);
  });

  it("a replay after a lost response gets the original result back", async () => {
    const server = fakeServer();
    const id = uuid();
    const first = await server.send(scan("T:7", id), "tok-a");
    // The tablet crashed before recording the response, so the entry is still pending.
    await enqueue(scan("T:7", id), session, db);
    await flushOutbox(server.send, { db });
    const row = await db.outbox.where("id").equals(id).first();
    expect(row?.status).toBe("done");
    expect(row?.result).toEqual(first);
    expect(server.applied).toEqual(["T:7"]);
  });

  it("treats an already-applied QC replay as done", async () => {
    const send = async () => {
      throw new ApiFailure("rejected", "INVALID_TRANSITION", "already packed", 409);
    };
    await enqueue({ kind: "qc", input: { orderItemId: uuid(), result: "pass" } }, session, db);
    const report = await flushOutbox(send, { db });
    expect(report.sent).toBe(1);
    expect((await db.outbox.toArray())[0]?.status).toBe("done");
  });
});

const ana = { sessionToken: "tok-ana", staffName: "Ana", staffId: "u-ana", stationId: "st-1" };
const lead = { token: "tok-lead", userId: "u-lead", stationId: "st-1" };

async function rows() {
  return db.outbox.orderBy("seq").toArray();
}

describe("parking: nothing jams the queue", () => {
  it("retries a 5xx with backoff up to 5 attempts, then parks it and moves on", async () => {
    let calls = 0;
    const send = async (command: OutboxCommand) => {
      calls++;
      if (command.kind === "scan" && command.input.transferCode === "T:1") {
        throw new ApiFailure("unavailable", "INTERNAL_SERVER_ERROR", "boom", 500);
      }
      return { ok: true };
    };
    for (const code of ["T:1", "T:2"]) await enqueue(scan(code), session, db);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = await flushOutbox(send, { db });
      expect(r.stoppedBy?.code).toBe("INTERNAL_SERVER_ERROR");
      expect((await rows()).map((e) => e.status)).toEqual(["pending", "pending"]);
      expect((await rows())[0]?.attempts).toBe(i);
    }
    const last = await flushOutbox(send, { db });
    expect(last.stoppedBy).toBeNull();
    expect(last.parked.map((e) => e.parkReason)).toEqual(["gave_up"]);
    expect(last.sent).toBe(1);
    expect((await rows()).map((e) => e.status)).toEqual(["parked", "done"]);
    expect(calls).toBe(MAX_ATTEMPTS + 1);
  });

  it.each([
    [408, "TIMEOUT_408"],
    [429, "RATE_LIMITED"],
  ])("treats a %i like a 5xx (retry, then park)", async (status, code) => {
    const send = async () => {
      throw new ApiFailure("unavailable", code, "slow down", status);
    };
    await enqueue(scan("T:1"), session, db);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await flushOutbox(send, { db });
    expect((await rows())[0]).toMatchObject({ status: "parked", parkReason: "gave_up" });
  });

  it("counts a timeout as an attempt, but not being offline", async () => {
    let failure = new ApiFailure("offline", "NETWORK", "offline");
    const send = async () => {
      throw failure;
    };
    await enqueue(scan("T:1"), session, db);
    for (let i = 0; i < 20; i++) await flushOutbox(send, { db });
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
    failure = new ApiFailure("offline", "TIMEOUT", "too slow");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await flushOutbox(send, { db });
    expect((await rows())[0]).toMatchObject({ status: "parked", parkReason: "gave_up" });
  });

  it("parks any other 4xx at once, including 403 and 404", async () => {
    const send = async (command: OutboxCommand) => {
      if (command.kind === "qc") throw new ApiFailure("rejected", "FORBIDDEN", "no", 403);
      if (command.kind === "reprint") throw new ApiFailure("rejected", "NOT_FOUND", "gone", 404);
      return { ok: true };
    };
    await enqueue({ kind: "qc", input: { orderItemId: uuid(), result: "pass" } }, session, db);
    await enqueue(
      { kind: "reprint", orderItemId: uuid(), reason: "misprint", note: null },
      session,
      db,
    );
    await enqueue(scan("T:3"), session, db);
    const r = await flushOutbox(send, { db });
    expect(r.sent).toBe(1);
    expect((await rows()).map((e) => [e.status, e.errorCode])).toEqual([
      ["parked", "FORBIDDEN"],
      ["parked", "NOT_FOUND"],
      ["done", null],
    ]);
  });

  it("parks a replayed scan the server BLOCKED, but not one seen live", async () => {
    const send = async (command: OutboxCommand) => {
      const id = command.kind === "scan" ? command.input.clientScanId : "";
      return { ok: false, clientScanId: id, mismatch: "item_on_hold", orderNo: "#1042" };
    };
    const live = await enqueue(scan("T:1"), session, db);
    const replayed = await enqueue(scan("T:2"), session, db);
    await db.outbox.update(replayed.seq as number, { replay: true });
    const r = await flushOutbox(send, { db });
    expect(r.parked.map((e) => e.id)).toEqual([replayed.id]);
    const [a, b] = await rows();
    expect(a).toMatchObject({ id: live.id, status: "done" });
    expect(b).toMatchObject({ status: "parked", parkReason: "blocked", errorCode: "item_on_hold" });
    expect((b?.result as ScanResult | undefined)?.orderNo).toBe("#1042");
  });

  it("prunes sent entries after a minute and never counts them", async () => {
    const server = fakeServer();
    await enqueue(scan("T:1"), session, db);
    await flushOutbox(server.send, { db });
    expect(await db.outbox.count()).toBe(1);
    const [done] = await rows();
    await db.outbox.update(done?.seq as number, {
      sentAt: new Date(Date.now() - 61_000).toISOString(),
    });
    await flushOutbox(server.send, { db });
    expect(await db.outbox.count()).toBe(0);
  });

  it("reads rows saved before parking existed (status failed, no parkedAt) as parked", async () => {
    const legacy = {
      id: uuid(),
      command: scan("T:old"),
      sessionToken: "tok-a",
      staffName: "Ana",
      createdAt: new Date().toISOString(),
      status: "failed",
      attempts: 1,
      lastError: "bad input",
      result: null,
      sentAt: null,
    } as OutboxEntry;
    await db.outbox.add(legacy);
    await enqueue(scan("T:new"), session, db);
    expect(await parkedCount(db)).toBe(1);
    const list = await unresolvedEntries(db);
    expect(list.map((e) => e.status)).toEqual(["failed", "pending"]);
    const [old] = list;
    expect(old?.parkedAt ?? null).toBeNull();
    expect(canRetry(old as OutboxEntry, lead)).toBe(true);
    expect(await retryParked([old?.id as string], lead, db)).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0, parkedAt: null });
  });
});

describe("attribution", () => {
  function authServer(valid: Set<string>) {
    const sentWith: string[] = [];
    const send = async (_c: OutboxCommand, token: string) => {
      if (!valid.has(token)) throw new ApiFailure("auth", "UNAUTHORIZED", "ended", 401);
      sentWith.push(token);
      return { ok: true };
    };
    return { send, sentWith };
  }

  it("never sends an entry as whoever is signed in now", async () => {
    const server = authServer(new Set(["tok-lead"]));
    await enqueue(scan("T:1"), ana, db);
    await enqueue(scan("T:2"), { ...ana, sessionToken: "tok-lead", staffId: "u-lead" }, db);
    const r = await flushOutbox(server.send, { db, currentSession: () => lead });
    expect(server.sentWith).toEqual(["tok-lead"]); // only the lead's own entry
    expect(r.parked.map((e) => e.parkReason)).toEqual(["session"]);
    expect((await rows()).map((e) => e.status)).toEqual(["parked", "done"]);
  });

  it("re-sends under the same person's new session on the same station", async () => {
    const server = authServer(new Set(["tok-ana-2"]));
    await enqueue(scan("T:1"), ana, db);
    const again = { token: "tok-ana-2", userId: "u-ana", stationId: "st-1" };
    await flushOutbox(server.send, { db, currentSession: () => again });
    expect(server.sentWith).toEqual(["tok-ana-2"]);
    expect((await rows())[0]).toMatchObject({ status: "done", sessionToken: "tok-ana-2" });
  });

  it("does not re-send as the same person on another station", async () => {
    const server = authServer(new Set(["tok-ana-2"]));
    await enqueue(scan("T:1"), ana, db);
    const elsewhere = { token: "tok-ana-2", userId: "u-ana", stationId: "st-2" };
    await flushOutbox(server.send, { db, currentSession: () => elsewhere });
    expect(server.sentWith).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "parked", parkReason: "session" });
  });

  it("resumes parked entries when their author signs in again", async () => {
    const server = authServer(new Set(["tok-ana-2"]));
    await enqueue(scan("T:1"), ana, db);
    await enqueue(scan("T:2"), { ...ana, staffId: "u-bo", staffName: "Bo" }, db);
    await flushOutbox(server.send, { db, currentSession: () => null });
    expect(await parkedCount(db)).toBe(2);
    const again = { token: "tok-ana-2", userId: "u-ana", stationId: "st-1" };
    expect(await resumeOwnEntries(again, db)).toBe(1);
    await flushOutbox(server.send, { db, currentSession: () => again });
    expect(server.sentWith).toEqual(["tok-ana-2"]);
    expect((await rows()).map((e) => [e.staffName, e.status])).toEqual([
      ["Ana", "done"],
      ["Bo", "parked"],
    ]);
  });

  it("a lead can send an ended-session entry only under their own name, explicitly", async () => {
    const server = authServer(new Set(["tok-lead"]));
    const e = await enqueue(scan("T:1"), ana, db);
    await flushOutbox(server.send, { db, currentSession: () => lead });
    const parked = (await rows())[0] as OutboxEntry;
    expect(canRetry(parked, lead)).toBe(false);
    expect(canSendAsMe(parked, lead)).toBe(true);
    expect(canSendAsMe(parked, { ...lead, stationId: "st-2" })).toBe(false);
    expect(await sendAsMe(e.id, { ...lead, staffName: "Lee" }, db)).toBe(true);
    await flushOutbox(server.send, { db, currentSession: () => lead });
    expect((await rows())[0]).toMatchObject({
      status: "done",
      staffName: "Lee",
      staffId: "u-lead",
    });
  });
});

describe("lead actions and forgetting the station", () => {
  it("retry puts a rejected entry back; discard removes it", async () => {
    let reject = true;
    const send = async () => {
      if (reject) throw new ApiFailure("rejected", "CONFLICT", "busy", 409);
      return { ok: true };
    };
    const a = await enqueue(scan("T:1"), ana, db);
    const b = await enqueue(scan("T:2"), ana, db);
    await flushOutbox(send, { db });
    expect(await parkedCount(db)).toBe(2);
    reject = false;
    expect(await retryParked([a.id], lead, db)).toBe(1);
    await flushOutbox(send, { db });
    expect(await discardEntry(b.id, db)).toBe(true);
    expect((await rows()).map((e) => e.status)).toEqual(["done"]);
    expect(await unresolvedEntries(db)).toEqual([]);
  });

  it("a BLOCKED replay can't be retried (same scan id, same answer), only removed", async () => {
    const e = await enqueue(scan("T:1"), ana, db);
    await db.outbox.update(e.seq as number, { replay: true });
    await flushOutbox(async () => ({ ok: false, mismatch: "wrong_size" }), { db });
    const parked = (await rows())[0] as OutboxEntry;
    expect(parked.parkReason).toBe("blocked");
    expect(canRetry(parked, lead)).toBe(false);
    expect(await retryParked([e.id], lead, db)).toBe(0);
  });

  it("forgetting the station parks unsent entries so they are never replayed", async () => {
    const server = fakeServer();
    server.setDown(true);
    await enqueue(scan("T:1"), ana, db);
    await enqueue(scan("T:2"), ana, db);
    await flushOutbox(server.send, { db });
    expect(await parkForForgottenStation(db)).toBe(2);
    server.setDown(false);
    const r = await flushOutbox(server.send, { db });
    expect(r.sent).toBe(0);
    expect(server.applied).toEqual([]);
    const [first] = await rows();
    expect(first?.parkReason).toBe("station_forgotten");
    expect(canRetry(first as OutboxEntry, { ...lead, stationId: "st-new" })).toBe(false);
    expect(canSendAsMe(first as OutboxEntry, lead)).toBe(false);
    expect(await retryParked([first?.id as string], lead, db)).toBe(0);
  });
});

describe("sync engine", () => {
  it("flags an entry saved offline and raises an alert when the server later refuses it", async () => {
    let down = true;
    const send = async (command: OutboxCommand) => {
      if (down) throw new ApiFailure("offline", "NETWORK", "offline");
      if (command.kind === "scan" && command.input.transferCode === "T:2") {
        return { ok: false, clientScanId: command.input.clientScanId, mismatch: "item_on_hold" };
      }
      return { ok: true };
    };
    const rejected: OutboxEntry[][] = [];
    const engine = new SyncEngine({
      send,
      db,
      currentSession: () => null,
      onReplayRejected: (e) => rejected.push(e),
    });
    useSyncStore.setState({ alerts: [] });
    const outcomes = [];
    for (const code of ["T:1", "T:2", "T:3"]) outcomes.push(await engine.submit(scan(code), ana));
    expect(outcomes.map((o) => o.status)).toEqual(["queued", "queued", "queued"]);
    expect((await rows()).every((e) => e.replay)).toBe(true);
    expect(useSyncStore.getState().pending).toBe(3);

    down = false;
    await engine.flush();
    const state = useSyncStore.getState();
    expect(state).toMatchObject({ pending: 0, parked: 1 });
    expect(state.alerts.map((e) => e.errorCode)).toEqual(["item_on_hold"]);
    expect(rejected).toHaveLength(1);
    expect((await rows()).map((e) => e.status)).toEqual(["done", "parked", "done"]);
    engine.stop();
  });

  it("an ended sign-in parks replayed entries without the rejected alert", async () => {
    let down = true;
    const engine = new SyncEngine({
      send: async () => {
        if (down) throw new ApiFailure("offline", "NETWORK", "offline");
        throw new ApiFailure("auth", "UNAUTHORIZED", "ended", 401);
      },
      db,
      currentSession: () => null,
    });
    useSyncStore.setState({ alerts: [] });
    await engine.submit(scan("T:1"), ana);
    down = false;
    await engine.flush();
    expect(useSyncStore.getState()).toMatchObject({ parked: 1, alerts: [] });
    engine.stop();
  });

  it("a server that never answers (permanent 500) parks the entry without an alert", async () => {
    let down = true;
    const rejected: OutboxEntry[][] = [];
    const engine = new SyncEngine({
      send: async () => {
        if (down) throw new ApiFailure("offline", "NETWORK", "offline");
        throw new ApiFailure("unavailable", "INTERNAL_SERVER_ERROR", "boom", 500);
      },
      db,
      currentSession: () => null,
      onReplayRejected: (e) => rejected.push(e),
    });
    useSyncStore.setState({ alerts: [] });
    await engine.submit(scan("T:1"), ana);
    expect((await rows())[0]?.replay).toBe(true);
    down = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await engine.flush();
    expect((await rows())[0]).toMatchObject({ status: "parked", parkReason: "gave_up" });
    expect(useSyncStore.getState()).toMatchObject({ parked: 1, alerts: [] });
    expect(rejected).toEqual([]);
    engine.stop();
  });

  it("an online BLOCKED scan is a normal result, not an alert", async () => {
    const engine = new SyncEngine({
      send: async () => ({ ok: false, mismatch: "wrong_size" }),
      db,
      currentSession: () => null,
    });
    useSyncStore.setState({ alerts: [] });
    const out = await engine.submit(scan("T:1"), ana);
    expect(out.status).toBe("sent");
    expect(useSyncStore.getState().alerts).toEqual([]);
    engine.stop();
  });
});

describe("contract version (T-13-1)", () => {
  const OLD = "0.2.0";
  const NOW = "0.3.0";
  const all = () => db.outbox.orderBy("seq").toArray();

  it("classifies CLIENT_TOO_OLD / 426 as tooOld, never retried", () => {
    expect(classifyStatus(426, "CLIENT_TOO_OLD")).toBe("tooOld");
    expect(classifyStatus(undefined, "CLIENT_TOO_OLD")).toBe("tooOld");
    expect(new ApiFailure("tooOld", "CLIENT_TOO_OLD", "old", 426).retryable).toBe(false);
  });

  it("stamps each entry with the contract version it was saved under", async () => {
    const e = await enqueue(scan("T:1"), session, db);
    expect(e.contractVersion).toBe(CONTRACT_VERSION);
    const old = await enqueue(scan("T:2"), session, db, null, OLD);
    expect(old.contractVersion).toBe(OLD);
  });

  it("an old entry the server still accepts replays normally", async () => {
    const server = fakeServer();
    await enqueue(scan("T:1"), session, db, null, OLD);
    const report = await flushOutbox(server.send, { db, appVersion: NOW });
    expect(report.sent).toBe(1);
    expect(server.applied).toEqual(["T:1"]);
  });

  it("an old entry the server refuses parks as stale_version; a current one as rejected", async () => {
    const server = fakeServer();
    await enqueue(scan("T:bad"), session, db, null, OLD);
    await enqueue(scan("T:bad"), session, db, null, NOW);
    // Rows from before the handshake have no stamp: older than any version.
    const legacy = await enqueue(scan("T:bad"), session, db, null, NOW);
    await db.outbox.update(legacy.seq as number, { contractVersion: undefined });
    const report = await flushOutbox(server.send, { db, appVersion: NOW });
    expect(report.parked.map((e) => e.parkReason)).toEqual([
      "stale_version",
      "rejected",
      "stale_version",
    ]);
    expect(isStaleVersion({ contractVersion: OLD }, NOW)).toBe(true);
    expect(isStaleVersion({ contractVersion: NOW }, NOW)).toBe(false);
  });

  it("CLIENT_TOO_OLD stops the flush and keeps everything pending, without an attempt", async () => {
    const send = async () => {
      throw new ApiFailure("tooOld", "CLIENT_TOO_OLD", "old", 426, { minVersion: "9.0.0" });
    };
    await enqueue(scan("T:1"), session, db);
    await enqueue(scan("T:2"), session, db);
    const report = await flushOutbox(send, { db });
    expect(report.stoppedBy?.kind).toBe("tooOld");
    expect(report.parked).toEqual([]);
    expect((await all()).map((e) => [e.status, e.attempts])).toEqual([
      ["pending", 0],
      ["pending", 0],
    ]);
  });

  it("the sync engine raises the lead alert for a stale_version park", async () => {
    const server = fakeServer();
    const alerted: OutboxEntry[][] = [];
    const engine = new SyncEngine({
      send: server.send,
      db,
      currentSession: () => null,
      onReplayRejected: (e) => alerted.push(e),
    });
    useSyncStore.setState({ alerts: [] });
    await enqueue(scan("T:bad"), session, db, null, "0.0.1");
    await engine.flush();
    expect(useSyncStore.getState().alerts.map((e) => e.parkReason)).toEqual(["stale_version"]);
    expect(alerted).toHaveLength(1);
    engine.stop();
  });
});
