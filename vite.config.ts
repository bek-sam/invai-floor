import { createHash } from "node:crypto";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

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
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
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
const prodCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
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
});
