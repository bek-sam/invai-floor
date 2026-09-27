import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER, type Contract } from "@invai/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";
const BACKEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../invai-backend",
);

export const PRESSER_PIN = "1155";
export const OWNER_PIN = "1111";

/** Typed oRPC client with a fixed Authorization header (station token or floor session). */
export function client(authorization: string): ContractRouterClient<Contract> {
  const link = new RPCLink({
    url: `${API_URL}/rpc`,
    headers: {
      authorization,
      origin: "http://localhost:5174",
      [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
    },
  });
  return createORPCClient(link);
}

export function seedStationToken(): string {
  const out = JSON.parse(readFileSync(path.join(BACKEND, "seed-output.json"), "utf8"));
  return out.stationToken.token as string;
}

export const OWNER = { email: "owner@desertbloom.test", password: "demo1234!" };

/** Owner cookie session (Better Auth), for test setup such as pairing a new tablet. */
export async function ownerClient(): Promise<ContractRouterClient<Contract>> {
  const jar = new Map<string, string>();
  const remember = (res: Response) => {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify(OWNER),
  });
  if (!res.ok) throw new Error(`owner sign-in failed (${res.status})`);
  remember(res);
  const link = new RPCLink({
    url: `${API_URL}/rpc`,
    fetch: async (req, init) => {
      const headers = new Headers(init?.headers ?? (req instanceof Request ? req.headers : {}));
      headers.set("cookie", cookie());
      headers.set("origin", "http://localhost:5173");
      const out = await fetch(req, { ...init, headers });
      remember(out);
      return out;
    },
  });
  return createORPCClient(link);
}
