import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiFailure } from "../api/errors";
import type { ScanInput, ScanResult } from "../api/types";
import { uuid } from "../lib/uuid";
import { FloorDB, type OutboxCommand } from "./db";
import { enqueue, flushOutbox } from "./outbox";

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
    expect(report).toMatchObject({ sent: 4, failed: 0, stoppedBy: null });
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

  it("marks a rejected command failed and keeps going", async () => {
    const server = fakeServer();
    for (const code of ["T:1", "T:bad", "T:3"]) await enqueue(scan(code), session, db);
    const report = await flushOutbox(server.send, { db });
    expect(report).toMatchObject({ sent: 2, failed: 1 });
    expect(server.applied).toEqual(["T:1", "T:3"]);
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

  it("retries with the current session when the original one expired", async () => {
    const server = fakeServer();
    await enqueue(scan("T:1"), { sessionToken: "expired", staffName: "Ana" }, db);
    const report = await flushOutbox(server.send, { db, currentSessionToken: () => "tok-b" });
    expect(report.sent).toBe(1);
  });

  it("stops on an expired session when nobody is logged in", async () => {
    const server = fakeServer();
    await enqueue(scan("T:1"), { sessionToken: "expired", staffName: "Ana" }, db);
    await enqueue(scan("T:2"), session, db);
    const report = await flushOutbox(server.send, { db, currentSessionToken: () => null });
    expect(report.stoppedBy?.kind).toBe("auth");
    expect(server.applied).toEqual([]);
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
