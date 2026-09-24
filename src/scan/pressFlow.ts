import type { QueueItem, ScanResult } from "../api/types";
import { parseCode } from "../lib/codes";
import { type ResultView, viewFromResult } from "./result";

/**
 * The press station's two-scan check as a pure state machine:
 * transfer QR -> blank/tote label -> server verdict -> Next.
 */
export type PressState =
  | { phase: "awaitTransfer"; hint: "scan_transfer_first" | "scan_next_transfer" | null }
  | { phase: "awaitBlank"; transferCode: string; preview: QueueItem | null }
  | {
      phase: "checking";
      transferCode: string;
      blankCode: string;
      preview: QueueItem | null;
      clientScanId: string;
    }
  | {
      phase: "result";
      transferCode: string;
      blankCode: string;
      preview: QueueItem | null;
      clientScanId: string;
      view: ResultView;
      result: ScanResult | null;
      hint: "scan_next_transfer" | null;
    };

export type PressEvent =
  /** Any scan. `preview` is the cached queue item for the code when it names a transfer. */
  | { type: "scan"; code: string; preview: QueueItem | null; clientScanId: string }
  /** The server answered the check with this clientScanId. */
  | { type: "result"; clientScanId: string; result: ScanResult }
  /** The check couldn't reach the server; `view` is the local/queued verdict. */
  | { type: "local"; clientScanId: string; view: ResultView }
  | { type: "next" };

export const initialPressState: PressState = { phase: "awaitTransfer", hint: null };

export function pressReducer(state: PressState, event: PressEvent): PressState {
  switch (event.type) {
    case "next":
      return initialPressState;

    case "scan": {
      const kind = parseCode(event.code).kind;
      const asTransfer = (): PressState => ({
        phase: "awaitBlank",
        transferCode: event.code,
        preview: event.preview,
      });
      const check = (transferCode: string, preview: QueueItem | null): PressState => ({
        phase: "checking",
        transferCode,
        blankCode: event.code,
        preview,
        clientScanId: event.clientScanId,
      });

      switch (state.phase) {
        case "awaitTransfer":
          if (kind === "blank" || kind === "bin")
            return { phase: "awaitTransfer", hint: "scan_transfer_first" };
          return asTransfer();
        case "awaitBlank":
          if (kind === "transfer") return asTransfer(); // picked up a different transfer
          if (event.code === state.transferCode) return state; // same QR scanned twice
          return check(state.transferCode, state.preview);
        case "checking":
          return state; // one check at a time
        case "result":
          if (kind === "transfer" || kind === "unknown") return asTransfer(); // implicit Next
          // Blocked for the wrong blank: grab the right one and scan it against the same transfer.
          if (state.view.tone !== "ok") return check(state.transferCode, state.preview);
          return { ...state, hint: "scan_next_transfer" };
      }
      return state;
    }

    case "result":
      if (state.phase !== "checking" || state.clientScanId !== event.clientScanId) return state;
      return {
        phase: "result",
        transferCode: state.transferCode,
        blankCode: state.blankCode,
        preview: state.preview,
        clientScanId: state.clientScanId,
        view: viewFromResult(event.result),
        result: event.result,
        hint: null,
      };

    case "local":
      if (state.phase !== "checking" || state.clientScanId !== event.clientScanId) return state;
      return {
        phase: "result",
        transferCode: state.transferCode,
        blankCode: state.blankCode,
        preview: state.preview,
        clientScanId: state.clientScanId,
        view: event.view,
        result: null,
        hint: null,
      };
  }
}
