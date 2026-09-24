import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "InvAI Floor",
        short_name: "Floor",
        display: "fullscreen",
        orientation: "landscape",
        theme_color: "#1f2a44",
        background_color: "#1f2a44",
        icons: [],
      },
    }),
  ],
  server: { port: 5174 },
});
