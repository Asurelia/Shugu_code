// Real Tauri/WebView2 smoke. The PowerShell orchestrator starts Shugu with a
// temporary app-data directory and exposes WebView2's CDP endpoint.

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.SHUGU_CDP_URL;
const outDir = process.env.SHUGU_NATIVE_OUT;
if (!cdpUrl || !outDir) {
  throw new Error("SHUGU_CDP_URL and SHUGU_NATIVE_OUT are required");
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
const deadline = Date.now() + 45_000;
let page;
while (!page && Date.now() < deadline) {
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => {
      const url = candidate.url();
      return url.includes("localhost:1420") && !url.includes("mascot.html");
    });
  if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!page) {
  throw new Error(
    `main WebView target not found; targets=${browser
      .contexts()
      .flatMap((c) => c.pages())
      .map((p) => p.url())
      .join(", ")}`,
  );
}

page.setDefaultTimeout(20_000);
const pageErrors = [];
const consoleMessages = [];
const failedRequests = [];
const httpErrors = [];
const accessibilityAudits = [];
const contrastAudits = [];
page.on("pageerror", (error) =>
  pageErrors.push(`${error.name}: ${error.message}`),
);
page.on("console", (message) => {
  const location = message.location();
  const source = location.url
    ? ` [${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}]`
    : "";
  consoleMessages.push(`${message.type()}: ${message.text()}${source}`);
});
page.on("requestfailed", (request) =>
  failedRequests.push(
    `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`,
  ),
);
page.on("response", (response) => {
  if (response.status() >= 400) {
    httpErrors.push(
      `${response.status()} ${response.request().method()} ${response.url()}`,
    );
  }
});

async function auditVisibleControls(stage) {
  const result = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll(
        'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="switch"], [role="menuitemradio"]',
      ),
    ];
    const visible = candidates.filter((element) => {
      if (element instanceof HTMLInputElement && element.type === "hidden")
        return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let current = element;
      while (current instanceof HTMLElement) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          return false;
        current = current.parentElement;
      }
      return true;
    });
    const unnamed = visible.filter((element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        : "";
      const inputLabel = element.id
        ? (document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            ?.textContent ?? "")
        : "";
      const wrappingLabel = element.closest("label")?.textContent ?? "";
      const name = [
        element.getAttribute("aria-label"),
        labelledText,
        inputLabel,
        wrappingLabel,
        element.textContent,
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        element.getAttribute("alt"),
      ].find((value) => value?.trim());
      return !name;
    });
    return {
      controls: visible.length,
      unnamed: unnamed.map((element) => {
        const className =
          typeof element.className === "string"
            ? element.className.trim().replace(/\s+/g, ".")
            : "";
        return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className}` : ""}`;
      }),
    };
  });
  accessibilityAudits.push({ stage, ...result });
  if (result.unnamed.length) {
    throw new Error(
      `${stage}: visible controls without accessible names: ${result.unnamed.join(", ")}`,
    );
  }
}

async function auditTextContrast(stage) {
  const result = await page.evaluate(() => {
    const parseColor = (value) => {
      const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        const expanded =
          hex[1].length === 3
            ? hex[1]
                .split("")
                .map((part) => part + part)
                .join("")
            : hex[1];
        return {
          r: Number.parseInt(expanded.slice(0, 2), 16),
          g: Number.parseInt(expanded.slice(2, 4), 16),
          b: Number.parseInt(expanded.slice(4, 6), 16),
          a: 1,
        };
      }
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    };
    const gradientColors = (value) => {
      if (!value || value === "none") return [];
      return (value.match(/rgba?\([^)]+\)|#[0-9a-f]{3,6}/gi) ?? [])
        .map(parseColor)
        .filter(Boolean);
    };
    const composite = (front, back) => {
      const a = front.a + back.a * (1 - front.a);
      if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
        a,
      };
    };
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      return (
        0.2126 * channel(color.r) +
        0.7152 * channel(color.g) +
        0.0722 * channel(color.b)
      );
    };
    const ratio = (a, b) => {
      const light = Math.max(luminance(a), luminance(b));
      const dark = Math.min(luminance(a), luminance(b));
      return (light + 0.05) / (dark + 0.05);
    };
    const backgroundFor = (element) => {
      let background = { r: 0, g: 0, b: 0, a: 0 };
      let current = element;
      const gradients = [];
      while (current instanceof HTMLElement) {
        const style = getComputedStyle(current);
        if (background.a < 0.999 && gradients.length === 0) {
          gradients.push(...gradientColors(style.backgroundImage));
        }
        const layer = parseColor(style.backgroundColor);
        if (layer && layer.a > 0) background = composite(background, layer);
        if (background.a >= 0.999) break;
        current = current.parentElement;
      }
      if (background.a < 0.999) {
        background = composite(background, { r: 255, g: 255, b: 255, a: 1 });
      }
      return { background, gradients };
    };
    const selectorFor = (element) => {
      const className =
        typeof element.className === "string"
          ? element.className.trim().split(/\s+/).slice(0, 3).join(".")
          : "";
      const name = element.getAttribute("name");
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className}` : ""}${name ? `[name=${name}]` : ""}`;
    };
    const candidates = [...document.querySelectorAll("body *")].filter(
      (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0 ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          element.matches(":disabled")
        )
          return false;
        let ancestor = element.parentElement;
        while (ancestor) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (
            ancestorStyle.display === "none" ||
            ancestorStyle.visibility === "hidden" ||
            Number(ancestorStyle.opacity) === 0
          )
            return false;
          ancestor = ancestor.parentElement;
        }
        const directText = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim();
        const controlText =
          element instanceof HTMLTextAreaElement
            ? element.value || element.placeholder
            : element instanceof HTMLInputElement &&
                [
                  "text",
                  "search",
                  "email",
                  "url",
                  "tel",
                  "password",
                  "number",
                ].includes(element.type)
              ? element.value || element.placeholder
              : "";
        return Boolean(directText || controlText);
      },
    );
    const violations = [];
    let measured = 0;
    let gradientApproximated = 0;
    for (const element of candidates) {
      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      if (!foreground) continue;
      const clipText =
        style.backgroundClip === "text" ||
        style.webkitBackgroundClip === "text";
      const backgroundData = backgroundFor(
        clipText ? element.parentElement : element,
      );
      if (backgroundData.gradients.length) {
        // CSS does not expose the resolved pixel under a glyph. Use the
        // declared gradient stops over the composited fallback and keep the
        // count explicit in the evidence.
        gradientApproximated += 1;
      }
      const backgrounds = backgroundData.gradients.length
        ? backgroundData.gradients.map((color) =>
            composite(color, backgroundData.background),
          )
        : [backgroundData.background];
      const textGradients = clipText
        ? gradientColors(style.backgroundImage)
        : [];
      const foregrounds = textGradients.length ? textGradients : [foreground];
      let contrast = Number.POSITIVE_INFINITY;
      let worstBackground = backgrounds[0];
      for (const background of backgrounds) {
        for (const candidate of foregrounds) {
          const renderedForeground =
            candidate.a < 0.999 ? composite(candidate, background) : candidate;
          const candidateRatio = ratio(renderedForeground, background);
          if (candidateRatio < contrast) {
            contrast = candidateRatio;
            worstBackground = background;
          }
        }
      }
      const fontSize = Number.parseFloat(style.fontSize) || 16;
      const fontWeight =
        Number.parseInt(style.fontWeight, 10) ||
        (style.fontWeight === "bold" ? 700 : 400);
      const largeText =
        fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const minimum = largeText ? 3 : 4.5;
      measured += 1;
      if (contrast + 0.01 < minimum) {
        violations.push({
          selector: selectorFor(element),
          text: (
            element.textContent?.trim() ||
            element.getAttribute("value") ||
            element.getAttribute("placeholder") ||
            ""
          )
            .replace(/\s+/g, " ")
            .slice(0, 100),
          ratio: Number(contrast.toFixed(2)),
          minimum,
          color: style.color,
          background: `rgb(${Math.round(worstBackground.r)}, ${Math.round(worstBackground.g)}, ${Math.round(worstBackground.b)})`,
        });
      }
    }
    return { measured, gradientApproximated, violations };
  });
  contrastAudits.push({ stage, ...result });
}

async function navigateRailAndAudit(label, stage, screenshotName) {
  const button = page.locator(`nav.rail button[aria-label="${label}"]`);
  await button.click();
  await page.waitForFunction(
    (expectedLabel) =>
      document
        .querySelector(`nav.rail button[aria-label="${expectedLabel}"]`)
        ?.classList.contains("active"),
    label,
  );
  await page.waitForTimeout(750);
  await auditVisibleControls(stage);
  await auditTextContrast(stage);
  await page.screenshot({ path: `${outDir}/${screenshotName}` });
}

// CDP can attach after the first JavaScript exception has already happened.
// Reload once with listeners installed so a blank native shell produces useful
// diagnostics instead of an opaque timeout.
await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
// The Tauri shell uses fixed-position children, so #root can legitimately
// have a zero-sized box. Waiting for Playwright's default "visible" state
// would time out even though React has rendered the application.
await page.waitForSelector("#root", { state: "attached" });
try {
  await page.waitForFunction(
    () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
  );
} catch (error) {
  const documentState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    rootHtml: document.getElementById("root")?.outerHTML ?? null,
    scripts: [...document.scripts].map((script) => script.src || "<inline>"),
    hasTauriBridge: Boolean(globalThis.__TAURI_INTERNALS__?.invoke),
  }));
  writeFileSync(
    `${outDir}/failure.json`,
    `${JSON.stringify({ documentState, pageErrors, consoleMessages, failedRequests }, null, 2)}\n`,
  );
  await page.screenshot({ path: `${outDir}/failure.png` });
  throw new Error(
    `${error.message}\nNative page diagnostics: ${JSON.stringify({ documentState, pageErrors, consoleMessages, failedRequests })}`,
  );
}
// Requests from the pre-attachment document are intentionally aborted by the
// diagnostic reload above; only failures after the fresh React mount matter.
failedRequests.length = 0;
httpErrors.length = 0;

// Fresh profile: dismiss both first-run layers through their real controls.
const greeting = page.locator(".shugu-greeting-overlay");
await greeting.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
if (await greeting.isVisible()) {
  await page.screenshot({ path: `${outDir}/00-first-run.png` });
  await page.locator(".shugu-greeting-skip").click();
  await greeting.waitFor({ state: "detached" });
}
const later = page.getByRole("button", { name: /plus tard/i });
await later
  .first()
  .waitFor({ state: "visible", timeout: 15_000 })
  .catch(() => {});
if (await later.first().isVisible()) {
  await later.first().click();
}

// Lazy route loading and the SQLite-backed first-run flags are asynchronous.
// Waiting here verifies that onboarding really yielded to the usable chat.
await page
  .locator(".cx-composer-input")
  .waitFor({ state: "visible", timeout: 30_000 });
const usableShellMs = await page.evaluate(() => Math.round(performance.now()));
if (usableShellMs > 45_000) {
  throw new Error(
    `native usable-shell budget exceeded: ${usableShellMs} ms (> 45000 ms)`,
  );
}
await auditVisibleControls("chat");
await auditTextContrast("chat");

for (const [selector, label] of [
  ["nav.rail", "rail"],
  [".shell-statusbar", "statusbar"],
  [".tb-bell", "notifications"],
  [".cx-composer-input", "chat composer"],
]) {
  await page
    .locator(selector)
    .first()
    .waitFor({ state: "visible" })
    .catch(() => {
      throw new Error(`missing ${label}: ${selector}`);
    });
}

// Native IPC proof: these calls cannot succeed in a Vite-only browser.
const ipc = await page.evaluate(async () => {
  const bridge = globalThis.__TAURI_INTERNALS__;
  if (!bridge?.invoke) throw new Error("Tauri IPC bridge missing");
  const capabilities = await bridge.invoke("model_capabilities", {
    protocol: "ollama",
    model: "qwen2.5:32b",
  });
  const recoveredMediaJobs = await bridge.invoke("media_jobs_recover");
  const mediaAssets = await bridge.invoke("media_assets_reconcile");
  let unknownAssetDeleteRejected = false;
  try {
    await bridge.invoke("media_asset_delete", {
      id: "native-smoke-unknown",
      deleteFile: true,
    });
  } catch {
    unknownAssetDeleteRejected = true;
  }
  return {
    capabilities,
    recoveredMediaJobs,
    mediaAssets,
    unknownAssetDeleteRejected,
  };
});
if (
  ipc.capabilities?.agentLoop !== "native" ||
  ipc.capabilities?.supportsTools !== true
) {
  throw new Error(
    `unexpected native capability response: ${JSON.stringify(ipc.capabilities)}`,
  );
}
if (
  !Array.isArray(ipc.mediaAssets) ||
  ipc.unknownAssetDeleteRejected !== true
) {
  throw new Error(
    `unexpected native media asset contract: ${JSON.stringify(ipc)}`,
  );
}

// Exercise real navigation and the profile selector. Full Access itself stays
// outside automation because its OS-native confirmation must remain human-only.
const modeButton = page.locator("button.cx-chip.mode");
await modeButton.click();
await page.getByRole("menuitemradio", { name: /^Agent/ }).click();
if (!(await modeButton.innerText()).includes("Agent · Auto")) {
  throw new Error(
    `Agent/Auto selector did not apply: ${await modeButton.innerText()}`,
  );
}
await page.screenshot({ path: `${outDir}/01-chat-agent-auto.png` });

await navigateRailAndAudit("Editor", "editor", "01a-editor.png");
await navigateRailAndAudit(
  "Source Control",
  "source-control",
  "01b-source-control.png",
);
await navigateRailAndAudit("Agents", "agents", "01c-agents.png");
await navigateRailAndAudit("Studio", "studio", "01d-studio.png");

await page.locator('nav.rail button[aria-label="Image"]').click();
for (const name of ["Image", "Vidéo", "Musique"]) {
  await page
    .getByRole("tab", { name, exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
}
const imageTab = page.getByRole("tab", { name: "Image", exact: true });
const videoTab = page.getByRole("tab", { name: "Vidéo", exact: true });
await imageTab.focus();
await page.keyboard.press("ArrowRight");
if ((await videoTab.getAttribute("aria-selected")) !== "true") {
  throw new Error("media tabs do not activate the next tab with ArrowRight");
}
await page
  .waitForFunction(
    () => document.activeElement?.id === "media-tab-video",
    undefined,
    { timeout: 2_000 },
  )
  .catch(() => {
    throw new Error("media tabs do not move keyboard focus with ArrowRight");
  });
await page.waitForTimeout(250);
await auditVisibleControls("media");
await auditTextContrast("media");
await page.screenshot({ path: `${outDir}/02-media-video.png` });

const navigationTiming = await page.evaluate(() => {
  const navigation = performance.getEntriesByType("navigation")[0];
  if (!navigation) return null;
  return {
    domInteractiveMs: Math.round(navigation.domInteractive),
    domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
    loadEventMs: Math.round(navigation.loadEventEnd),
    transferredBytes: navigation.transferSize,
    decodedBytes: navigation.decodedBodySize,
    jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    jsHeapLimitBytes: performance.memory?.jsHeapSizeLimit ?? null,
  };
});
if (
  !navigationTiming ||
  navigationTiming.domContentLoadedMs > 30_000 ||
  (navigationTiming.jsHeapUsedBytes !== null &&
    navigationTiming.jsHeapUsedBytes > 256 * 1024 * 1024)
) {
  throw new Error(
    `native DOM boot budget exceeded: ${JSON.stringify(navigationTiming)}`,
  );
}

await page.locator('nav.rail button[aria-label="Connections"]').click();
await page.waitForTimeout(500);
await auditVisibleControls("connections");
await auditTextContrast("connections");

// Open a real modal and prove the shared focus contract in WebView2: initial
// focus, forward/backward wrap, outside-focus containment, Escape and restore.
const addProviderLauncher = page.getByRole("button", {
  name: "Add custom provider",
  exact: true,
});
await addProviderLauncher.focus();
await addProviderLauncher.click();
const providerDialog = page.getByRole("dialog", {
  name: "Add custom provider",
});
await providerDialog.waitFor({ state: "visible" });
await auditVisibleControls("connections-add-provider");
await auditTextContrast("connections-add-provider");
const providerName = providerDialog.getByRole("textbox", {
  name: "Display name",
});
await page.waitForFunction(
  () => document.activeElement?.getAttribute("name") === "provider-name",
);
const lastProviderAction = providerDialog.getByRole("button", {
  name: /Test connection/i,
});
await lastProviderAction.focus();
await page.keyboard.press("Tab");
if (
  !(await providerName.evaluate(
    (element) => element === document.activeElement,
  ))
) {
  throw new Error(
    "provider dialog does not wrap Tab from the last enabled control",
  );
}
await page.keyboard.press("Shift+Tab");
if (
  !(await lastProviderAction.evaluate(
    (element) => element === document.activeElement,
  ))
) {
  throw new Error(
    "provider dialog does not wrap Shift+Tab from the first control",
  );
}
await addProviderLauncher.evaluate((element) => element.focus());
if (
  !(await providerDialog.evaluate((element) =>
    element.contains(document.activeElement),
  ))
) {
  throw new Error("provider dialog allowed focus to escape the modal");
}
await page.keyboard.press("Escape");
await providerDialog.waitFor({ state: "detached" });
await page.waitForFunction(
  () =>
    document.activeElement?.getAttribute("aria-label") ===
    "Add custom provider",
);
await page.screenshot({ path: `${outDir}/03-connections.png` });

await page.locator('nav.rail button[aria-label="Settings"]').click();
await page.waitForTimeout(500);
await auditVisibleControls("settings");
await auditTextContrast("settings");
await page.screenshot({ path: `${outDir}/04-settings.png` });

await page.getByRole("button", { name: "Compte", exact: true }).click();
const accountDialog = page.getByRole("dialog", { name: "Compte et profil" });
await accountDialog.waitFor({ state: "visible" });
await accountDialog.locator("button.account-head").click();
await page.waitForTimeout(750);
await auditVisibleControls("profile");
await auditTextContrast("profile");
await page.screenshot({ path: `${outDir}/04a-profile.png` });

// Seed one isolated SQLite row through the real frontend repository, then
// reload to prove Gallery hydration + missing-file UI + retry handoff. The
// profile is unique to this smoke and is deleted during teardown.
await page.evaluate(async () => {
  const { db } = await import("/src/lib/db.ts");
  await db.generations.create({
    id: "native-smoke-missing-image",
    kind: "image",
    prompt: "native smoke retry prompt",
    negative: null,
    ratio: "1:1",
    model: "comfyui/native-smoke.safetensors",
    seed: 42,
    steps: 4,
    guidance: 1,
    style: "product",
    hue: 260,
    status: "missing",
    result_url: "C:\\native-smoke-missing\\asset.png",
    ts: Date.now(),
  });
});
await page.reload({ waitUntil: "domcontentloaded" });
await page
  .locator(".cx-composer-input")
  .waitFor({ state: "visible", timeout: 30_000 });
failedRequests.length = 0;
httpErrors.length = 0;
await page.locator('nav.rail button[aria-label="Gallery"]').click();
await page
  .locator(".gallery-card")
  .waitFor({ state: "visible", timeout: 30_000 });
await page.getByText(/fichier manquant/i).waitFor({ state: "visible" });
await page.locator(".gallery-card").hover();
await page.waitForTimeout(250);
await auditVisibleControls("gallery-missing");
await auditTextContrast("gallery-missing");
const revealMissing = page.getByRole("button", { name: /Révéler/i });
if (!(await revealMissing.isDisabled()))
  throw new Error("missing media reveal action must be disabled");
await page.screenshot({ path: `${outDir}/05-gallery-missing.png` });
await page.getByRole("button", { name: /Relancer/i }).click();
await page
  .getByRole("tab", { name: "Image", exact: true })
  .waitFor({ state: "visible" });
await page
  .locator(".image-controls textarea")
  .first()
  .waitFor({ state: "visible" });
await page.screenshot({ path: `${outDir}/06-gallery-retry.png` });
const retryPrompt = await page
  .locator(".image-controls textarea")
  .first()
  .inputValue();
if (retryPrompt !== "native smoke retry prompt") {
  const pendingRetry = await page.evaluate(() =>
    sessionStorage.getItem("shugu.media.retry.v1"),
  );
  throw new Error(
    `media retry handoff restored ${JSON.stringify(retryPrompt)}; pending=${pendingRetry}`,
  );
}

// The retry intentionally targets an unavailable local ComfyUI endpoint in
// this isolated profile. Wait for the handled failure, then exercise a complete
// native backup → integrity → restore round-trip as the final DB operation.
await page
  .getByRole("button", { name: /^Generate$/ })
  .waitFor({ state: "visible", timeout: 30_000 });
const backupRestore = await page.evaluate(async () => {
  const bridge = globalThis.__TAURI_INTERNALS__;
  const backup = await bridge.invoke("shugu_backup_now");
  const integrity = await bridge.invoke("shugu_db_integrity_check");
  const restore = await bridge.invoke("shugu_import_data", {
    bundleDir: backup.bundleDir,
  });
  return { backup, integrity, restore };
});
if (
  backupRestore.backup?.manifest?.integrityOk !== true ||
  backupRestore.integrity?.ok !== true ||
  backupRestore.restore?.restartRequired !== true ||
  backupRestore.restore?.scheduled !== true ||
  !backupRestore.restore?.pendingRestore ||
  !backupRestore.restore?.safetyBackup
) {
  throw new Error(
    `native backup/restore contract failed: ${JSON.stringify(backupRestore)}`,
  );
}

const fatalConsoleMessages = consoleMessages.filter(
  (message) =>
    message.startsWith("error:") ||
    message.includes("Invalid layout total size"),
);
if (
  pageErrors.length ||
  fatalConsoleMessages.length ||
  failedRequests.length ||
  httpErrors.length
) {
  throw new Error(
    [
      ...pageErrors.map((message) => `page: ${message}`),
      ...fatalConsoleMessages.map((message) => `console: ${message}`),
      ...failedRequests.map((message) => `request: ${message}`),
      ...httpErrors.map((message) => `http: ${message}`),
    ].join("\n"),
  );
}

const summary = {
  cdpUrl,
  mainUrl: page.url(),
  ipc,
  backupRestore,
  accessibility: {
    mediaTabsKeyboard: true,
    modalFocusTrap: true,
    audits: accessibilityAudits,
    contrastAudits,
  },
  navigationTiming,
  usableShellMs,
  targets: browser
    .contexts()
    .flatMap((context) => context.pages())
    .map((target) => target.url()),
  pageErrors,
  consoleMessages,
  failedRequests,
  httpErrors,
  completedAt: new Date().toISOString(),
};
writeFileSync(
  `${outDir}/summary.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);
await browser.close();
const contrastViolations = contrastAudits.flatMap((audit) =>
  audit.violations.map((violation) => ({ stage: audit.stage, ...violation })),
);
if (contrastViolations.length) {
  throw new Error(
    `WCAG text contrast violations: ${JSON.stringify(contrastViolations.slice(0, 50))}`,
  );
}
console.log(`Native Tauri smoke OK — ${outDir}`);
