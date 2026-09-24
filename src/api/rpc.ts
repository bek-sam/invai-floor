import type { Contract } from "@invai/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { API_URL } from "../lib/config";
import { ApiFailure, toFailure } from "./errors";
import type { FloorApi } from "./types";

type Auth = { scheme: "Station" | "Bearer"; token: string };
type Ctx = { auth?: Auth };

const TIMEOUT_MS = 10_000;

export function rpcUrl() {
  const origin =
    API_URL || (typeof location === "undefined" ? "http://localhost" : location.origin);
  return `${origin}/rpc`;
}

export function createRpcApi(): FloorApi {
  const link = new RPCLink<Ctx>({
    url: rpcUrl,
    headers: ({ context }) =>
      context.auth ? { Authorization: `${context.auth.scheme} ${context.auth.token}` } : {},
  });
  const client: ContractRouterClient<Contract, Ctx> = createORPCClient(link);

  const station = (token: string) => ({
    context: { auth: { scheme: "Station", token } as Auth },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bearer = (token: string) => ({
    context: { auth: { scheme: "Bearer", token } as Auth },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  /** Normalizes transport errors, timeouts and oRPC errors into ApiFailure. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        throw new ApiFailure("offline", "TIMEOUT", "The server took too long to answer");
      }
      throw toFailure(err);
    }
  }

  return {
    kind: "rpc",

    stationStaff: (token) => call(async () => (await client.floor.staff({}, station(token))).items),

    login: (token, pin) =>
      call(() => client.floor.login({ stationToken: token, pin }, station(token))),

    logout: (token) =>
      call(async () => {
        await client.floor.logout({}, bearer(token));
      }),

    org: (token) =>
      call(async () => {
        const me = await client.me.get({}, bearer(token));
        return { name: me.org.name, demo: me.org.demo };
      }),

    queue: (token, stationKind) =>
      call(() => client.production.queue({ station: stationKind, limit: 200 }, bearer(token))),

    scan: (token, input) => call(() => client.production.scan(input, bearer(token))),

    qc: (token, input) =>
      call(async () => {
        const res = await client.production.qc(
          {
            orderItemId: input.orderItemId,
            result: input.result,
            reprintReason: input.reprintReason,
            blankReusable: input.blankReusable ?? false,
            note: input.note ?? null,
          },
          bearer(token),
        );
        return { reprintId: res.reprint?.id ?? null };
      }),

    assignBin: (token, code, orderId) =>
      call(() => client.production.bins.assign({ code, orderId }, bearer(token))),

    releaseBin: (token, code) =>
      call(() => client.production.bins.release({ code }, bearer(token))),

    fileUrl: (token, key) =>
      call(
        async () =>
          (await client.files.downloadUrl({ fileKey: key, disposition: "inline" }, bearer(token)))
            .url,
      ),

    orderLabelUrl: (token, orderId) =>
      call(async () => {
        const order = await client.orders.get({ id: orderId }, bearer(token));
        const shipmentIds = [
          ...new Set(order.items.map((i) => i.shipmentId).filter((id): id is string => !!id)),
        ];
        for (const id of shipmentIds) {
          const shipment = await client.shipping.shipments.get({ id }, bearer(token));
          if (shipment.labelKey && shipment.status !== "voided") {
            return (
              await client.files.downloadUrl(
                { fileKey: shipment.labelKey, disposition: "inline" },
                bearer(token),
              )
            ).url;
          }
        }
        return null;
      }),

    requestReprint: (token, orderItemId, reason, note) =>
      call(async () => {
        await client.production.reprints.request({ orderItemId, reason, note }, bearer(token));
      }),

    shelfOf: () => null,
  };
}
