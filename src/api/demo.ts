import type { OrderItemState } from "@invai/contracts";
import { parseCode } from "../lib/codes";
import { ApiFailure } from "./errors";
import type {
  Bin,
  FloorApi,
  FloorSession,
  MismatchReason,
  QueueItem,
  ScanInput,
  ScanResult,
  Station,
} from "./types";

/**
 * An in-memory stand-in for the backend: "Desert Bloom Tees" with a few orders at every
 * station and the same scan rules the server applies. Used by demo mode (`?demo=1`) and
 * while the real procedures aren't built yet.
 */
export const DEMO_STATION_TOKEN = "demo-station";

const uid = (prefix: number, n: number) =>
  `00000000-0000-4000-8${prefix.toString(16).padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

const STAFF = [
  { id: uid(1, 1), name: "Olivia Owner", role: "owner", pin: "1111" },
  { id: uid(1, 2), name: "Adam Admin", role: "admin", pin: "1122" },
  { id: uid(1, 3), name: "Omar Office", role: "office", pin: "1133" },
  { id: uid(1, 4), name: "Dana Designer", role: "designer", pin: "1144" },
  { id: uid(1, 5), name: "Pedro Presser", role: "presser", pin: "1155" },
  { id: uid(1, 6), name: "Paula Packer", role: "packer", pin: "1166" },
  { id: uid(1, 7), name: "Rico Receiver", role: "receiver", pin: "1177" },
] as const;

type Blank = QueueItem["blank"];
const blank = (n: number, style: string, color: string, size: string): Blank => ({
  variantId: uid(2, n),
  brand: style === "1717" ? "Comfort Colors" : style === "3001" ? "Bella+Canvas" : "Gildan",
  style,
  color,
  size,
});
const BLANKS = {
  blackL: blank(1, "64000", "Black", "L"),
  blackM: blank(2, "64000", "Black", "M"),
  whiteL: blank(3, "64000", "White", "L"),
  pepperXL: blank(4, "1717", "Pepper", "XL"),
  sandS: blank(5, "3001", "Heather Dust", "S"),
  sageM: blank(6, "1717", "Sage", "M"),
};
export const DEMO_SHELVES: Record<string, string> = {
  [BLANKS.blackL.variantId]: "A-03",
  [BLANKS.blackM.variantId]: "A-02",
  [BLANKS.whiteL.variantId]: "B-07",
  [BLANKS.pepperXL.variantId]: "C-11",
  [BLANKS.sandS.variantId]: "D-01",
  [BLANKS.sageM.variantId]: "C-04",
};

const DESIGNS = [
  { id: uid(3, 1), name: "Desert Sun", code: "DS-01", color: "#f59e0b" },
  { id: uid(3, 2), name: "Saguaro Sunset", code: "SS-07", color: "#ef4444" },
  { id: uid(3, 3), name: "Coffee & Cacti", code: "CC-12", color: "#78350f" },
  { id: uid(3, 4), name: "Mama Bloom (custom)", code: "MB-P1", color: "#db2777" },
];

type DemoItem = QueueItem & { cancelled?: boolean; picked?: boolean };

function makeItems(): DemoItem[] {
  const shipBy = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  let n = 0;
  const item = (
    orderNo: string,
    orderN: number,
    state: OrderItemState,
    b: Blank,
    d: number,
    extra: Partial<DemoItem> = {},
  ): DemoItem => {
    n++;
    const design = DESIGNS[d] ?? DESIGNS[0];
    return {
      orderItemId: uid(4, n),
      orderId: uid(5, orderN),
      orderNo,
      state,
      shipBy: shipBy(4 + orderN * 3),
      isRush: orderN === 1,
      isReprint: false,
      design: { id: design?.id ?? uid(3, 1), name: design?.name ?? "", code: design?.code ?? "" },
      placement: "front",
      blank: b,
      artworkPreviewKey: `demo/${design?.code}`,
      transferId: uid(6, n),
      sheetId: uid(7, 1),
      sheetName: "2026-09-24 #1",
      binCode: null,
      orderOpenUnits: 1,
      ...extra,
    };
  };
  const items: DemoItem[] = [
    item("#1042", 1, "transfer_in", BLANKS.blackL, 0),
    item("#1042", 1, "transfer_in", BLANKS.whiteL, 1),
    item("#1043", 2, "transfer_in", BLANKS.pepperXL, 2, { placement: "back" }),
    item("#1044", 3, "transfer_in", BLANKS.blackM, 0),
    item("#1045", 4, "transfer_in", BLANKS.sandS, 3, { placement: "left_chest", isReprint: true }),
    item("#1046", 5, "on_hold", BLANKS.blackL, 1),
    item("#1047", 6, "transfer_in", BLANKS.sageM, 2, { cancelled: true }),
    item("#1048", 7, "pressed", BLANKS.blackL, 0, { binCode: "T-07" }),
    item("#1048", 7, "pressed", BLANKS.blackM, 1, { binCode: "T-07" }),
    item("#1049", 8, "pressed", BLANKS.whiteL, 2, { binCode: "T-08" }),
    item("#1050", 9, "packed", BLANKS.pepperXL, 3, { binCode: "T-09" }),
    item("#1050", 9, "packed", BLANKS.blackL, 0, { binCode: "T-09" }),
    item("#1050", 9, "pressed", BLANKS.whiteL, 1, { binCode: "T-09" }),
    item("#1051", 10, "transfer_in", BLANKS.whiteL, 0),
    item("#1052", 11, "transfer_in", BLANKS.blackL, 2),
  ];
  return items;
}

/** Which items each station works on. QC passed items are `packed` in the state machine but still await boxing. */
function inQueue(station: Station, item: DemoItem, packedIntoBox: Set<string>): boolean {
  if (item.cancelled) return false;
  switch (station) {
    case "pick":
      return item.state === "transfer_in" && !item.picked;
    case "press":
      return item.state === "transfer_in";
    case "qc":
      return item.state === "pressed";
    case "pack":
      return (
        (item.state === "pressed" || item.state === "packed") &&
        !packedIntoBox.has(item.orderItemId)
      );
  }
}

const delay = (ms = 180) => new Promise((r) => setTimeout(r, ms));

function svgDataUrl(label: string, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f4f4f5"/><circle cx="100" cy="86" r="52" fill="${color}"/><text x="100" y="172" font-family="system-ui" font-size="18" font-weight="700" text-anchor="middle" fill="#111">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createDemoApi(): FloorApi {
  const items = makeItems();
  const results = new Map<string, ScanResult>();
  const sessions = new Map<string, (typeof STAFF)[number]>();
  const bins = new Map<string, string>(); // code -> orderId
  const boxed = new Set<string>();
  const doneToday: Record<Station, number> = { pick: 3, press: 12, qc: 9, pack: 6 };
  for (const i of items) if (i.binCode) bins.set(i.binCode, i.orderId);

  const auth = (token: string) => {
    const user = sessions.get(token);
    if (!user) throw new ApiFailure("auth", "UNAUTHORIZED", "Session expired", 401);
    return user;
  };
  const openUnits = (orderId: string) =>
    items.filter((i) => i.orderId === orderId && !i.cancelled && !boxed.has(i.orderItemId)).length;

  function check(input: ScanInput): ScanResult {
    const transferCode = parseCode(input.transferCode);
    const item = items.find(
      (i) => i.transferId === transferCode.value || i.orderItemId === transferCode.value,
    );
    const base: ScanResult = {
      ok: false,
      clientScanId: input.clientScanId,
      mismatch: null,
      message: "",
      transferId: item?.transferId ?? null,
      orderItemId: item?.orderItemId ?? null,
      orderId: item?.orderId ?? null,
      orderNo: item?.orderNo ?? null,
      design: item?.design ?? null,
      expected: item ? { blankVariantId: item.blank.variantId, ...pickBlank(item.blank) } : null,
      scannedBlank: null,
      placement: (item?.placement as ScanResult["placement"]) ?? null,
      isReprint: item?.isReprint ?? false,
      binCode: item?.binCode ?? null,
      itemState: item?.state ?? null,
      nextAction: "nothing",
      orderOpenUnits: item ? openUnits(item.orderId) : null,
    };
    const fail = (mismatch: MismatchReason, message: string): ScanResult => ({
      ...base,
      mismatch,
      message,
    });
    if (!item) return fail("unknown_transfer", "No transfer with this code");
    if (item.cancelled)
      return fail(
        "item_cancelled",
        `Order ${item.orderNo} was cancelled. Put the transfer in scrap.`,
      );
    if (item.state === "on_hold")
      return fail("item_on_hold", `Order ${item.orderNo} is on hold. Set it aside.`);

    const scanned = input.blankCode ? parseCode(input.blankCode) : null;
    const scannedBlank = scanned
      ? (Object.values(BLANKS).find((b) => b.variantId === scanned.value) ?? null)
      : null;
    const withBlank = scannedBlank
      ? {
          ...base,
          scannedBlank: { blankVariantId: scannedBlank.variantId, ...pickBlank(scannedBlank) },
        }
      : base;

    if (input.station === "press") {
      if (item.state === "pressed" || item.state === "packed")
        return fail("already_processed", "This transfer was already pressed");
      if (item.state !== "transfer_in")
        return fail("not_yet_received", "Transfer not received yet");
      if (!scanned) return fail("blank_required", "Scan the blank label");
      if (scanned.kind === "bin") {
        const binOrder = bins.get(scanned.value);
        if (binOrder && binOrder !== item.orderId)
          return {
            ...withBlank,
            mismatch: "wrong_order",
            message: "That tote holds another order",
          };
      } else {
        if (!scannedBlank)
          return { ...withBlank, mismatch: "unknown_blank", message: "Unknown blank label" };
        if (scannedBlank.style !== item.blank.style)
          return {
            ...withBlank,
            mismatch: "wrong_design",
            message: `Needs ${item.blank.brand} ${item.blank.style}`,
          };
        if (scannedBlank.color !== item.blank.color)
          return {
            ...withBlank,
            mismatch: "wrong_color",
            message: `Needs ${item.blank.color}, scanned ${scannedBlank.color}`,
          };
        if (scannedBlank.size !== item.blank.size)
          return {
            ...withBlank,
            mismatch: "wrong_size",
            message: `Needs ${item.blank.size}, scanned ${scannedBlank.size}`,
          };
      }
      item.state = "pressed";
      doneToday.press++;
      return {
        ...withBlank,
        ok: true,
        itemState: "pressed",
        nextAction: "qc",
        message: "Press it",
      };
    }
    if (input.station === "pick") {
      if (item.state !== "transfer_in") return fail("wrong_station", "Not waiting to be picked");
      if (scannedBlank && scannedBlank.variantId !== item.blank.variantId)
        return { ...withBlank, mismatch: "wrong_size", message: "Different blank" };
      item.picked = true;
      doneToday.pick++;
      return { ...withBlank, ok: true, nextAction: "press", message: "Picked" };
    }
    if (input.station === "pack") {
      if (boxed.has(item.orderItemId)) return fail("already_processed", "Already packed");
      if (item.state !== "pressed" && item.state !== "packed")
        return fail("wrong_station", "Not ready to pack");
      boxed.add(item.orderItemId);
      item.state = "packed";
      return {
        ...base,
        ok: true,
        itemState: "packed",
        nextAction: openUnits(item.orderId) ? "pack" : "ship",
        orderOpenUnits: openUnits(item.orderId),
        message: "Packed",
      };
    }
    return fail("wrong_station", "Use QC pass/fail");
  }

  const pickBlank = (b: Blank) => ({
    brand: b.brand,
    style: b.style,
    color: b.color,
    size: b.size,
  });

  const binOut = (code: string): Bin => {
    const orderId = bins.get(code) ?? null;
    const inBin = items.filter((i) => i.orderId === orderId && i.binCode === code);
    return {
      code,
      locationId: null,
      orderId,
      orderNo: inBin[0]?.orderNo ?? items.find((i) => i.orderId === orderId)?.orderNo ?? null,
      unitsInBin: inBin.length,
      unitsExpected: items.filter((i) => i.orderId === orderId && !i.cancelled).length,
      station: null,
      updatedAt: new Date().toISOString(),
    };
  };

  return {
    kind: "demo",

    async stationStaff(token) {
      await delay();
      if (token !== DEMO_STATION_TOKEN)
        throw new ApiFailure("auth", "UNAUTHORIZED", "Unknown station token", 401);
      return STAFF.map(({ id, name, role }) => ({ id, name, role }));
    },

    async login(token, pin) {
      await delay(300);
      if (token !== DEMO_STATION_TOKEN)
        throw new ApiFailure("auth", "UNAUTHORIZED", "Unknown station token", 401);
      const user = STAFF.find((s) => s.pin === pin);
      if (!user) throw new ApiFailure("rejected", "INVALID_PIN", "PIN not recognized", 401);
      const sessionToken = `demo-session-${user.id}-${Date.now()}`;
      sessions.set(sessionToken, user);
      const session: FloorSession = {
        sessionToken,
        expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
        user: { id: user.id, name: user.name, role: user.role },
        station: { id: uid(8, 1), name: "Demo Press 1", kind: null },
        permissions: [
          "production.read",
          "production.scan",
          "production.qc",
          "shipping.read",
          "files.read",
        ],
      };
      return session;
    },

    async logout(token) {
      sessions.delete(token);
    },

    async org(token) {
      auth(token);
      return { name: "Desert Bloom Tees (demo)", demo: true };
    },

    async queue(token, station) {
      await delay();
      auth(token);
      const list: QueueItem[] = items
        .filter((i) => inQueue(station, i, boxed))
        .map(({ cancelled: _c, picked: _p, ...i }) => ({
          ...i,
          orderOpenUnits: openUnits(i.orderId),
        }));
      return {
        station,
        items: list.sort(
          (a, b) => Number(b.isRush) - Number(a.isRush) || a.shipBy.localeCompare(b.shipBy),
        ),
        nextCursor: null,
        counts: { waiting: list.length, doneToday: doneToday[station] },
      };
    },

    async scan(token, input) {
      await delay();
      auth(token);
      const prior = results.get(input.clientScanId);
      if (prior) return prior;
      const result = check(input);
      results.set(input.clientScanId, result);
      return result;
    },

    async qc(token, input) {
      await delay();
      auth(token);
      const item = items.find((i) => i.orderItemId === input.orderItemId);
      if (!item) throw new ApiFailure("rejected", "NOT_FOUND", "Not found", 404);
      if (item.state !== "pressed")
        throw new ApiFailure("rejected", "INVALID_TRANSITION", "Not waiting for QC", 409);
      doneToday.qc++;
      if (input.result === "pass") {
        item.state = "packed";
        return { reprintId: null };
      }
      item.state = "ready";
      item.isReprint = true;
      return { reprintId: uid(9, doneToday.qc) };
    },

    async assignBin(token, code, orderId) {
      await delay();
      auth(token);
      const held = bins.get(code);
      if (held && held !== orderId) {
        const orderNo = items.find((i) => i.orderId === held)?.orderNo ?? "?";
        throw new ApiFailure("rejected", "BIN_OCCUPIED", "Bin holds another order", 409, {
          orderNo,
        });
      }
      bins.set(code, orderId);
      for (const i of items) if (i.orderId === orderId) i.binCode = code;
      return binOut(code);
    },

    async releaseBin(token, code) {
      await delay();
      auth(token);
      const out = binOut(code);
      bins.delete(code);
      return { ...out, orderId: null, orderNo: null, unitsInBin: 0 };
    },

    async fileUrl(token, key) {
      auth(token);
      const code = key.replace(/^demo\//, "");
      const design = DESIGNS.find((d) => d.code === code);
      return svgDataUrl(design?.name ?? code, design?.color ?? "#64748b");
    },

    async requestReprint(token, orderItemId) {
      await delay();
      auth(token);
      const item = items.find((i) => i.orderItemId === orderItemId);
      if (!item) throw new ApiFailure("rejected", "NOT_FOUND", "Not found", 404);
      item.state = "ready";
      item.isReprint = true;
    },

    shelfOf: (variantId) => DEMO_SHELVES[variantId] ?? null,

    async orderLabelUrl(token, orderId) {
      auth(token);
      const orderNo = items.find((i) => i.orderId === orderId)?.orderNo;
      if (orderNo !== "#1050" && orderNo !== "#1048") return null;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="6in" viewBox="0 0 400 600"><rect width="400" height="600" fill="#fff" stroke="#000" stroke-width="4"/><text x="20" y="60" font-size="36" font-family="monospace" font-weight="700">USPS GROUND ADV</text><text x="20" y="140" font-size="22" font-family="monospace">DEMO LABEL ${orderNo}</text><rect x="20" y="420" width="360" height="120" fill="#000"/></svg>`;
      return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    },
  };
}
