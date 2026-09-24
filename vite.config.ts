import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const api = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "InvAI Floor",
        short_name: "Floor",
        display: "fullscreen",
        orientation: "landscape",
        start_url: "/",
        theme_color: "#1f2a44",
        background_color: "#1f2a44",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
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
  },
  preview: { port: 5174, proxy: { "/rpc": api, "/events": api } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
