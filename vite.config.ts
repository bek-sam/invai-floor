import { createHash } from "node:crypto";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";
import { connectSrc, requireApiOrigin } from "./src/lib/build/csp.ts";

const api = process.env.VITE_API_PROXY ?? "http://localhost:3000";

// T-12-5 (B-24): strict CSP, no 'unsafe-inline'. The built app (dist/) never emits an inline
// <script> or onclick=, so its script-src is plain 'self'. The Vite dev server is the exception:
// @vitejs/plugin-react injects one fixed inline <script type="module"> (the Fast Refresh
// preamble), same bytes on every request, so it's allowed by its exact hash instead of a nonce.
const reactPreambleHash = `'sha256-${createHash("sha256")
  .update(react.preambleCode.replace("__BASE__", "/"))
  .digest("base64")}'`;
const S3_ORIGIN = "http://localhost:9000"; // local MinIO; presigned image URLs (Thumbnail)

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // `camera=(self)` (T-23-2, B-105): the optional camera-scan button calls getUserMedia on this
  // same origin, nowhere else, so no legitimate caller needs it granted to any other origin.
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()",
  // Meaningless over plain http, but a browser only obeys it over https anyway, so it's safe to
  // always send -- and it must match the API's header exactly once TLS terminates in front of us.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
// /rpc and /events are same-origin (proxied to `api` above), so connect-src needs only 'self'.
const devCsp = [
  "default-src 'self'",
  `script-src 'self' ${reactPreambleHash}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${S3_ORIGIN}`,
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig(({ command, isPreview }) => {
  // Review r1: connect-src was 'https:' (any HTTPS host), not the pinned API origin. The built
  // app bakes VITE_API_URL in as an absolute URL and calls it directly (nginx has no proxy, and
  // `vite preview`'s own proxy is bypassed once the app has an absolute origin baked in), so
  // `build` and `preview` both need the real origin -- a build without it fails loudly here
  // instead of silently falling back to a broad CSP.
  const prodConnectSrc =
    command === "build" || isPreview
      ? connectSrc(requireApiOrigin(process.env.VITE_API_URL))
      : "'self'"; // never served: only `devCsp` above governs plain `vite`/`pnpm dev`.
  const prodCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${prodConnectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // Never reload by itself (a packer may be mid-order): a new version waits for a tap.
        registerType: "prompt",
        includeAssets: ["icon.svg", "apple-touch-icon.png"],
        manifest: {
          name: "InvAI Floor",
          short_name: "Floor",
          display: "fullscreen",
          orientation: "landscape",
          start_url: "/",
          theme_color: "#1f2a44",
          background_color: "#1f2a44",
          icons: [
            { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "pwa-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
            { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          ],
        },
        workbox: {
          // App shell + hashed assets are precached; API calls and SSE always go to the network.
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/rpc/, /^\/events/, /^\/api/],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    // @invai/ui is a linked sibling with its own node_modules; one React and one i18next instance.
    resolve: { dedupe: ["react", "react-dom", "react-i18next", "i18next"] },
    server: {
      port: 5174,
      host: true,
      proxy: { "/rpc": api, "/events": { target: api, changeOrigin: true } },
      headers: { "Content-Security-Policy": devCsp, ...securityHeaders },
    },
    preview: {
      port: 5174,
      proxy: { "/rpc": api, "/events": api },
      headers: { "Content-Security-Policy": prodCsp, ...securityHeaders },
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}"], // e2e/*.spec.ts belongs to Playwright
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
