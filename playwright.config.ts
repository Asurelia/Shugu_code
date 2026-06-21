// Shugu Forge — Playwright config (quality-gates lane).
//
// ── Scope: a WEB SMOKE, not a full Tauri desktop E2E. ────────────────────────
// Shugu is a Tauri 2 app. Driving the real desktop binary end-to-end requires
// `tauri-driver` + a WebDriver bridge (tauri-apps/tauri-driver) and a headed
// WebView2 session — heavy, flaky in CI, and out of scope for a first gate.
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
// ── Upgrade path to true Tauri E2E (documented, not implemented here) ────────
//   1. `cargo install tauri-driver` (and ensure msedgedriver matches WebView2).
//   2. Build the Tauri debug binary: `pnpm tauri build --debug`.
//   3. Add a webdriverio/Playwright-CDP harness that launches tauri-driver,
//      points at the built binary, and drives the real window.
// That work belongs to a dedicated desktop-E2E lane, not this gate.

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
    command: "npm run build && npm run preview -- --port " + PREVIEW_PORT,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
