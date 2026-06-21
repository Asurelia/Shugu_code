// Shugu Forge — Playwright smoke spec (quality-gates lane).
//
// Goal: prove the production Vite bundle BOOTS in a real browser. This is the
// minimal, deterministic E2E gate described in playwright.config.ts — it is NOT
// a Tauri desktop walkthrough (no `invoke`, no windows, no dialogs available in
// a plain browser context).
//
// What we assert, and why each is bundle-regression-shaped:
//   1. The page reaches a loaded state without a fatal navigation error.
//   2. The `#root` mount node exists (index.html shipped correctly).
//   3. React actually rendered SOMETHING into `#root` (the entry module ran;
//      no import-cycle / top-level throw nuked boot into a blank screen).
//   4. No *page-fatal* uncaught error fired during initial boot. We tolerate
//      errors that are expected without the Tauri runtime (the app talks to a
//      `@tauri-apps/api` `invoke` bridge that is absent in the browser), so we
//      only fail on errors that are clearly not "missing Tauri" noise.

import { test, expect } from "@playwright/test";

// Substrings that identify "this only failed because we're in a browser, not
// inside Tauri" — expected and harmless for a bundle smoke. Anything NOT
// matching one of these is treated as a genuine boot regression.
const TAURI_ABSENCE_NOISE = [
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "window.__TAURI",
  "invoke",
  "Cannot read properties of undefined (reading 'invoke')",
  "tauri",
  "convex", // backend bridge also absent in a static preview
  "WebSocket",
  "Failed to fetch",
  "NetworkError",
];

function isExpectedAbsenceNoise(message: string): boolean {
  const lower = message.toLowerCase();
  return TAURI_ABSENCE_NOISE.some((needle) => lower.includes(needle.toLowerCase()));
}

test("production bundle boots and mounts the React shell", async ({ page }) => {
  const fatalErrors: string[] = [];

  page.on("pageerror", (err) => {
    const msg = `${err.name}: ${err.message}`;
    if (!isExpectedAbsenceNoise(msg)) {
      fatalErrors.push(msg);
    }
  });

  // 1. Navigate to the served production bundle. `domcontentloaded` is enough;
  //    we don't wait for network idle because the app legitimately keeps
  //    sockets open / retries backends that are absent in preview.
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response, "navigation produced a response").not.toBeNull();
  expect(response!.ok(), `HTTP status was ${response!.status()}`).toBeTruthy();

  // 2. The mount node from index.html must be present.
  const root = page.locator("#root");
  await expect(root).toHaveCount(1);

  // 3. React must have rendered *something* into #root. We poll because the
  //    entry does async provider setup before first paint. A blank #root after
  //    the timeout means boot died silently — the exact regression we guard.
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          const el = document.getElementById("root");
          return el ? el.childElementCount : 0;
        });
      },
      {
        message: "#root never received any child nodes — the app failed to boot",
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);

  // 4. No genuine (non-Tauri-absence) uncaught error during boot.
  expect(
    fatalErrors,
    `unexpected fatal page errors during boot:\n${fatalErrors.join("\n")}`,
  ).toHaveLength(0);
});
