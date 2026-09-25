import type {
  Contract,
  MISMATCH_REASONS,
  NEXT_ACTIONS,
  PackOrderInput,
  PackOrderResult,
  QueueItem,
  REPRINT_REASONS,
  ScanInput,
  ScanResult,
  Station,
} from "@invai/contracts";
import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";

type Out = InferContractRouterOutputs<Contract>;
type In = InferContractRouterInputs<Contract>;

export type { PackOrderInput, PackOrderResult, QueueItem, ScanInput, ScanResult, Station };
export type MismatchReason = (typeof MISMATCH_REASONS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];
export type ReprintReason = (typeof REPRINT_REASONS)[number];

export type StationQueue = Out["production"]["queue"];
export type FloorSession = Out["floor"]["login"];
export type StaffMember = Out["floor"]["staff"]["items"][number];
export type Bin = Out["production"]["bins"]["assign"];
export type QcInput = Pick<
  In["production"]["qc"],
  "orderItemId" | "result" | "reprintReason" | "blankReusable" | "note"
>;

/** Everything the floor app asks of the backend. Implemented over oRPC and by the demo mock. */
export interface FloorApi {
  readonly kind: "rpc" | "demo";
  /** Validates a station token (station auth) and lists who can log in there. */
  stationStaff(stationToken: string): Promise<StaffMember[]>;
  login(stationToken: string, pin: string): Promise<FloorSession>;
  logout(sessionToken: string): Promise<void>;
  /** The org behind a floor session (name, demo flag). */
  org(sessionToken: string): Promise<{ name: string; demo: boolean }>;
  queue(sessionToken: string, station: Station): Promise<StationQueue>;
  scan(sessionToken: string, input: ScanInput): Promise<ScanResult>;
  qc(sessionToken: string, input: QcInput): Promise<{ reprintId: string | null }>;
  assignBin(sessionToken: string, code: string, orderId: string): Promise<Bin>;
  releaseBin(sessionToken: string, code: string): Promise<Bin>;
  /**
   * "Mark packed" (or, with `override`, hand a short order to a lead). A refusal because units
   * are missing is a result (`packed: false`, `override: null`), like a BLOCKED scan, not an error.
   */
  packOrder(sessionToken: string, input: PackOrderInput): Promise<PackOrderResult>;
  /** A signed URL for an S3 key (artwork thumbnails, label PDFs). */
  fileUrl(sessionToken: string, key: string): Promise<string>;
  /** The printable label for an order, when one has been bought. */
  orderLabelUrl(sessionToken: string, orderId: string): Promise<string | null>;
  requestReprint(
    sessionToken: string,
    orderItemId: string,
    reason: ReprintReason,
    note: string | null,
  ): Promise<void>;
  /** Shelf/bin location of a blank for the pick list; the contract has none yet (null). */
  shelfOf(blankVariantId: string): string | null;
}
