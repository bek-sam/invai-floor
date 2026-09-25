import type { Contract } from "@invai/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  ContractRouterClient,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { ApiFailure, toFailure } from "../../api/errors";
import { rpcUrl } from "../../api/rpc";
import { createReceivingDemo } from "./demo";

type Out = InferContractRouterOutputs<Contract>;
type In = InferContractRouterInputs<Contract>;

export type PurchaseOrder = Out["inventory"]["purchaseOrders"]["get"];
export type PoLine = PurchaseOrder["lines"][number];
export type GangSheet = Out["production"]["sheets"]["markReceived"];
export type SheetItem = Out["production"]["sheets"]["items"]["items"][number];
export type StockLevel = Out["inventory"]["stock"]["get"];
export type CountResult = Out["inventory"]["count"];
export type ReceiveInput = In["inventory"]["purchaseOrders"]["receive"];
export type CountInput = In["inventory"]["count"];

/** POs a receiver can still check in. */
export const OPEN_PO_STATES = ["submitted", "partially_received"] as const;
/** Sheets whose transfers can be marked arrived (SHEET_TRANSITIONS: printed/shipped → received). */
export const ARRIVING_SHEET_STATES = ["printed", "shipped"] as const;

/** What the receiving station asks of the backend, over oRPC or the demo mock. */
export interface ReceivingApi {
  openPurchaseOrders(token: string): Promise<PurchaseOrder[]>;
  receivePo(token: string, input: ReceiveInput): Promise<PurchaseOrder>;
  arrivingSheets(token: string): Promise<GangSheet[]>;
  /** Transfer ids on a sheet, so scanning any transfer QR finds its sheet. */
  sheetTransferIds(token: string, sheetId: string): Promise<string[]>;
  markSheetReceived(token: string, sheetId: string): Promise<GangSheet>;
  stock(token: string): Promise<StockLevel[]>;
  count(token: string, input: CountInput): Promise<CountResult>;
}

const TIMEOUT_MS = 10_000;

export function createRpcReceivingApi(): ReceivingApi {
  type Ctx = { token?: string };
  const link = new RPCLink<Ctx>({
    url: rpcUrl,
    headers: ({ context }) => (context.token ? { Authorization: `Bearer ${context.token}` } : {}),
  });
  const client: ContractRouterClient<Contract, Ctx> = createORPCClient(link);
  const opts = (token: string) => ({
    context: { token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

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

  /** Follows `nextCursor` so a long list isn't cut off at one page. */
  async function all<T>(
    page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await page(cursor);
      out.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  return {
    openPurchaseOrders: (token) =>
      call(() =>
        all((cursor) =>
          client.inventory.purchaseOrders.list(
            { status: [...OPEN_PO_STATES], limit: 100, cursor },
            opts(token),
          ),
        ),
      ),
    receivePo: (token, input) =>
      call(() => client.inventory.purchaseOrders.receive(input, opts(token))),
    arrivingSheets: (token) =>
      call(() =>
        all((cursor) =>
          client.production.sheets.list(
            { status: [...ARRIVING_SHEET_STATES], limit: 100, cursor },
            opts(token),
          ),
        ),
      ),
    sheetTransferIds: (token, sheetId) =>
      call(async () => {
        const res = await client.production.sheets.items({ id: sheetId }, opts(token));
        return res.items.map((i) => i.transferId).filter((id): id is string => !!id);
      }),
    markSheetReceived: (token, sheetId) =>
      call(() => client.production.sheets.markReceived({ id: sheetId }, opts(token))),
    stock: (token) =>
      call(() => all((cursor) => client.inventory.stock.list({ limit: 500, cursor }, opts(token)))),
    count: (token, input) => call(() => client.inventory.count(input, opts(token))),
  };
}

let rpc: ReceivingApi | null = null;
let demo: ReceivingApi | null = null;

/** The receiving backend matching the floor app's current backend (real or `?demo=1`). */
export function receivingApi(kind: "rpc" | "demo"): ReceivingApi {
  if (kind === "demo") {
    demo ??= createReceivingDemo();
    return demo;
  }
  rpc ??= createRpcReceivingApi();
  return rpc;
}
