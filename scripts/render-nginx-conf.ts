/**
 * Renders nginx.conf from nginx.conf.template, pinning connect-src to the API origin derived
 * from VITE_API_URL -- the same source and derivation vite.config.ts uses for the dev-preview
 * CSP, so the header nginx actually sends matches the origin the built app actually calls
 * (T-12-5, B-24, review r1). Run from the repo root: `node scripts/render-nginx-conf.ts`
 * (plain type-stripped TS; Node 24 runs it directly, no build step needed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectSrc, requireApiOrigin } from "../src/lib/build/csp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const origin = requireApiOrigin(process.env.VITE_API_URL);
const template = readFileSync(`${root}/nginx.conf.template`, "utf8");
const rendered = template.replaceAll("__CONNECT_SRC__", connectSrc(origin));
writeFileSync(`${root}/nginx.conf`, rendered);
console.log(`nginx.conf written (connect-src: ${connectSrc(origin)})`);
