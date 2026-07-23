// Shugu Forge — Playwright config (quality-gates lane).
//
// ── Scope: this file remains the deterministic WEB smoke. ───────────────────
// The real Tauri 2/WebView2 gate now lives in scripts/native-smoke.ps1 +
// scripts/native-smoke.mjs and runs with `pnpm native:smoke`. It connects to
// the actual desktop WebView over CDP, uses an isolated Tauri identifier/SQLite
// profile, performs two boots for restore, and verifies exact teardown.
//
// What this config DOES give us, cheaply and deterministically: it builds the
// app with Vite (`vite build`) and serves the production bundle with
// `vite preview`, then Playwright loads it in a real browser and asserts the
// React shell actually mounts and renders without a blank-screen / hard JS
// crash. That catches the highest-frequency regressions (broken bundle, import
// cycle that nukes boot, CSP/asset path breakage, dead `#root`) which unit
// tests do NOT catch because they never run the bundled entrypoint.
//
// Tauri-specific surfaces (windows, dialogs, drag/drop, `invoke` IPC) are
// stubbed/absent in the browser; the smoke spec guards against that by only
// asserting framework-agnostic boot signals. See e2e/smoke.spec.ts.
//
// Keep the two gates separate: this config catches production-bundle boot/CSP
// regressions cheaply, while `native:smoke` proves Tauri IPC and desktop state.

import { defineConfig, devices } from "@playwright/test";

// vite preview's port. vite.config.ts pins the DEV server to 1420 (strictPort),
// but `vite preview` defaults to 4173. We pin it here so webServer.url matches.
const PREVIEW_PORT = 4173;
const BASE_URL = `http://localhost:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // One smoke file today; keep it serial and fail-fast in CI.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Build the production bundle, then serve it. Playwright waits for the URL
  // to respond before running specs, and tears the server down afterwards.
  // `reuseExistingServer` lets a developer keep `vite preview` running locally.
  webServer: {
    command: "pnpm build && pnpm preview -- --port " + PREVIEW_PORT,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
