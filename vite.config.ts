import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/_design_extracted/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    // Multi-page: index.html (main IDE) + mascot.html (floating chibi window).
    // Both bundle to dist/ as separate HTML entries so Tauri's second window
    // can load mascot.html in production. In dev mode Vite serves both
    // directly from project root.
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        mascot: path.resolve(__dirname, "mascot.html"),
      },
    },
  },
});
