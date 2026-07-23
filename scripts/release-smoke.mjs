// Runtime proof for the packaged frontend embedded in an isolated release
// Tauri binary. PowerShell owns compilation, process isolation and teardown.

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.SHUGU_CDP_URL;
const outDir = process.env.SHUGU_RELEASE_OUT;
if (!cdpUrl || !outDir) throw new Error("SHUGU_CDP_URL and SHUGU_RELEASE_OUT are required");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
const deadline = Date.now() + 30_000;
let page;
while (!page && Date.now() < deadline) {
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => {
      const url = candidate.url();
      return url !== "about:blank" && !url.includes("mascot.html");
    });
  if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!page) {
  throw new Error(
    `release main WebView target not found; targets=${browser.contexts().flatMap((context) => context.pages()).map((target) => target.url()).join(", ")}`,
  );
}

page.setDefaultTimeout(30_000);
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("requestfailed", (request) =>
  failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`),
);

await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForSelector("#root", { state: "attached" });
await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
failedRequests.length = 0;

const greeting = page.locator(".shugu-greeting-overlay");
await greeting.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
if (await greeting.isVisible()) {
  await page.locator(".shugu-greeting-skip").click();
  await greeting.waitFor({ state: "detached" });
}
const later = page.getByRole("button", { name: /plus tard/i }).first();
await later.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
if (await later.isVisible()) await later.click();

await page.locator(".cx-composer-input").waitFor({ state: "visible", timeout: 30_000 });
const usableShellMs = Math.round(await page.evaluate(() => performance.now()));
if (usableShellMs > 30_000) {
  throw new Error(`release usable-shell budget exceeded: ${usableShellMs} ms (> 30000 ms)`);
}

const runtime = await page.evaluate(async () => {
  const bridge = globalThis.__TAURI_INTERNALS__;
  if (!bridge?.invoke) throw new Error("release Tauri IPC bridge missing");
  const capabilities = await bridge.invoke("model_capabilities", {
    protocol: "ollama",
    model: "qwen2.5:32b",
  });
  const navigation = performance.getEntriesByType("navigation")[0];
  return {
    url: location.href,
    protocol: location.protocol,
    host: location.host,
    capabilities,
    navigation: navigation
      ? {
          domInteractiveMs: Math.round(navigation.domInteractive),
          domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
          loadEventMs: Math.round(navigation.loadEventEnd),
        }
      : null,
    jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    jsHeapLimitBytes: performance.memory?.jsHeapSizeLimit ?? null,
  };
});
if (runtime.host.includes(":1420")) {
  throw new Error(`release binary loaded the dev server instead of embedded assets: ${runtime.url}`);
}
if (runtime.capabilities?.agentLoop !== "native" || runtime.capabilities?.supportsTools !== true) {
  throw new Error(`release IPC capability contract failed: ${JSON.stringify(runtime.capabilities)}`);
}
if (runtime.jsHeapUsedBytes !== null && runtime.jsHeapUsedBytes > 256 * 1024 * 1024) {
  throw new Error(`release JS heap budget exceeded: ${runtime.jsHeapUsedBytes}`);
}

await page.screenshot({ path: `${outDir}/release-shell.png` });
if (pageErrors.length || consoleErrors.length || failedRequests.length) {
  throw new Error(
    JSON.stringify({ pageErrors, consoleErrors, failedRequests }),
  );
}

const summary = {
  cdpUrl,
  usableShellMs,
  runtime,
  pageErrors,
  consoleErrors,
  failedRequests,
  completedAt: new Date().toISOString(),
};
writeFileSync(`${outDir}/webview-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
await browser.close();
console.log(`Release WebView smoke OK — ${outDir}`);
