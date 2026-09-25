import { type CountInput, type ReceiveInput, receivingApi } from "./api";

/**
 * Receiving writes, queued in the floor outbox like every other station's writes.
 * `label` is what the tablet shows for a queued or failed entry (a PO or sheet name).
 */
export type ReceivingAction =
  | { op: "receivePo"; input: ReceiveInput; label: string }
  | { op: "sheetReceived"; sheetId: string; label: string }
  | { op: "count"; input: CountInput; label: string };

export type ReceivingCommand = { kind: "receiving"; action: ReceivingAction };

export function sendReceiving(
  command: ReceivingCommand,
  token: string,
  kind: "rpc" | "demo",
): Promise<unknown> {
  const api = receivingApi(kind);
  const { action } = command;
  switch (action.op) {
    case "receivePo":
      return api.receivePo(token, action.input);
    case "sheetReceived":
      return api.markSheetReceived(token, action.sheetId);
    case "count":
      return api.count(token, action.input);
  }
}
