// Shugu Forge — tour visuel headless de l'UI (couche web, SANS Tauri).
//
// Pourquoi : l'app est Tauri-only, mais le shell React (rail, titlebar,
// statusbar, notifications, palettes, vues) se vérifie très bien dans un
// navigateur — c'est exactement le périmètre du smoke Playwright
// (playwright.config.ts). Ce script va un cran plus loin : il DÉROULE l'UI
// (skip onboarding, ouvre le centre de notifications, navigue entre vues) et
// dépose des captures d'écran dans dev-logs/ui-tour/ pour revue humaine ou
// agent (Claude/Codex en session cloud sans WebView2).
//
// Usage :
//   pnpm ui:tour                # build implicite ? NON — sert dist/ existant :
//                               # lance `pnpm build` d'abord si dist/ est vieux.
//   PORT=4173 CHROMIUM=/chemin/chrome pnpm ui:tour   # overrides
//
// Résolution du navigateur : override $CHROMIUM, Chrome/Edge système sous
// Windows, puis registre Playwright du projet, puis Chromium de conteneur.
//
// Les erreurs « Tauri absent » (invoke/transformCallback/WebSocket…) sont
// attendues en navigateur et n'échouent PAS le tour ; seuls les manques
// STRUCTURELS (shell/rail absents, statusbar présente au mauvais endroit)
// sortent en code ≠ 0.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 4173);
const BASE = `http://localhost:${PORT}`;
const OUT = "dev-logs/ui-tour";
const FOCUSED = process.env.SHUGU_UI_TOUR_FOCUSED === "1";
mkdirSync(OUT, { recursive: true });

function resolveChromium() {
  if (process.env.CHROMIUM && existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;
  if (process.platform === "win32") {
    for (const candidate of [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* registre non installé */ }
  if (existsSync("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  throw new Error(
    "Aucun Chromium trouvé. Installe-le via `pnpm exec playwright install chromium` " +
    "ou pointe CHROMIUM=/chemin/vers/chrome.",
  );
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite preview ne répond pas sur ${url}`);
}

// Sert dist/ (vite preview). Réutilise un serveur déjà lancé sur le port.
let preview = null;
let alreadyUp = false;
try {
  const r = await fetch(BASE);
  alreadyUp = r.ok;
} catch { /* rien sur le port → on lance */ }
if (!alreadyUp) {
  if (!existsSync("dist/index.html")) {
    console.error("dist/ absent — lance `pnpm build` d'abord.");
    process.exit(2);
  }
  const { preview: startVitePreview } = await import("vite");
  preview = await startVitePreview({
    logLevel: "silent",
    preview: { port: PORT, strictPort: true },
  });
  await waitForServer(BASE);
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  args: process.platform === "win32" ? ["--disable-gpu", "--disable-software-rasterizer"] : [],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(3_000);
const cdp = await page.context().newCDPSession(page);
const fastClick = async (locator) =>
  locator.first().evaluate((element) => element.click()).catch(() => {});
const screenshot = async (path, { fullPage = false } = {}) => {
  if (FOCUSED) {
    await page.screenshot({
      path,
      fullPage,
      animations: "disabled",
      timeout: 45_000,
    });
    return;
  }
  // Playwright attend `document.fonts.ready` avant chaque capture. Dans le
  // preview Tauri-less, une police distante peut rester indéfiniment pendante.
  // Le protocole Chromium capture l'état réellement peint sans cette attente.
  const params = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: fullPage,
  };
  if (fullPage) {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    params.clip = {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    };
  }
  const { data } = await cdp.send("Page.captureScreenshot", params);
  writeFileSync(path, Buffer.from(data, "base64"));
};

// Les Google Fonts sont purement décoratives. En CI/offline, une requête de
// police peut rester pendante et Playwright attend alors `document.fonts.ready`
// avant CHAQUE screenshot jusqu'au timeout. On coupe ces deux hôtes pour forcer
// immédiatement les fallbacks locaux et garder ce tour déterministe.
await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, (route) => route.abort());

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(2500); // shell + routes lazy

// ── Overlays premier-lancement : capturés puis retirés ────────────────────
if (await page.locator(".shugu-greeting-overlay").count()) {
  if (!FOCUSED) await screenshot(`${OUT}/00-onboarding-greeting.png`);
  await fastClick(page.locator(".shugu-greeting-skip"));
  await page.waitForTimeout(500);
  // finish() persiste via db (absente en preview) → retrait DOM de secours.
  await page.evaluate(() => document.querySelector(".shugu-greeting-overlay")?.remove());
}
const later = page.getByRole("button", { name: /plus tard/i });
if (await later.count()) {
  await fastClick(later);
  await page.waitForTimeout(400);
}

// ── Checks structurels (le contrat minimal du shell) ──────────────────────
const missing = [];
const need = async (sel, label) => {
  if ((await page.locator(sel).count()) === 0) missing.push(label + ` (${sel})`);
};
await need("nav.rail", "rail");
await need(".rail-group-label", "labels de groupes du rail");
await need(".tb-bell", "cloche notifications");
await need('nav.rail button[aria-label="Connections"]', "bouton Connections");
if ((await page.locator(".shell-statusbar").count()) > 0) {
  missing.push("statusbar globale visible dans le chat (doublon du composer)");
}

if (!FOCUSED) {
  await screenshot(`${OUT}/01-chat-shell.png`);

  // ── Centre de notifications ─────────────────────────────────────────────
  await fastClick(page.locator(".tb-bell"));
  await page.waitForTimeout(400);
  await need(".notif-pop", "panneau notifications");
  await screenshot(`${OUT}/02-notification-center.png`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── Composer : auto-grow multi-lignes (régression fréquente) ───────────
  const ta = page.locator(".cx-composer-input");
  if (await ta.count()) {
    const h1 = (await ta.boundingBox({ timeout: 10_000 }).catch(() => null))?.height ?? 0;
    await ta.click().catch(() => {});
    await ta.fill("ligne 1\nligne 2\nligne 3\nligne 4\nligne 5\nligne 6").catch(() => {});
    await page.waitForTimeout(300);
    const h2 = (await ta.boundingBox({ timeout: 10_000 }).catch(() => null))?.height ?? 0;
    if (h1 > 0 && h2 > 0) {
      if (h2 <= h1 + 30) missing.push(`auto-grow composer (h ${h1}→${h2})`);
      await screenshot(`${OUT}/07-composer-multiline.png`);
      await ta.fill("").catch(() => {});
    }
  }

  // ── Vues principales via le rail ────────────────────────────────────────
  const views = [
    ["Editor", "03-editor"],
    ["Source Control", "04-git"],
    ["Agents", "05-agents"],
    ["Settings", "06-settings"],
  ];
  for (const [label, shot] of views) {
    await fastClick(page.locator(`nav.rail button[aria-label="${label}"]`));
    await page.waitForTimeout(1000);
    await screenshot(`${OUT}/${shot}.png`);
  }
}

// ── Connexions : cartes compactes, identité provider, expansion ────────────
await fastClick(page.locator('nav.rail button[aria-label="Connections"]'));
await page.waitForTimeout(800);
await need(".shell-statusbar", "statusbar globale hors chat");
await need(".conn-card-v2", "cartes provider compactes");
await need(".conn-card-v2 .provider-mark", "identités provider");
await need(".conn-card-v2 .conn-card-toggle", "contrôles de repli provider");
const compactCards = await page.locator(".conn-card-v2:not(.is-expanded)").evaluateAll((cards) =>
  cards.map((card) => Math.round(card.getBoundingClientRect().height)),
);
if (compactCards.some((height) => height > 96)) {
  missing.push(`hauteur carte provider repliée (${compactCards.join(", ")})`);
}
await screenshot(`${OUT}/08-connections-compact.png`);

const llamaCard = page.locator('[data-provider-id="llamacpp"]');
if (await llamaCard.count()) {
  await fastClick(llamaCard.locator(".conn-card-toggle"));
  await page.waitForTimeout(350);
  await need('[data-provider-id="llamacpp"].is-expanded .conn-card-body', "configuration llama.cpp dépliée");
  const expandedBox = await llamaCard.boundingBox();
  if (expandedBox && expandedBox.height > 900 * 0.72) {
    missing.push(`hauteur llama.cpp dépliée (${Math.round(expandedBox.height)}px)`);
  }
  await screenshot(`${OUT}/09-connections-expanded.png`, { fullPage: true });

  const anthropicCard = page.locator('[data-provider-id="anthropic"]');
  await fastClick(anthropicCard.locator(".conn-card-toggle"));
  await page.waitForTimeout(200);
  if ((await page.locator(".conn-card-v2.is-expanded").count()) !== 1) {
    missing.push("plusieurs cartes provider dépliées simultanément");
  }
  if ((await llamaCard.locator(".conn-card-toggle").getAttribute("aria-expanded")) !== "false") {
    missing.push("llama.cpp ne se replie pas à l’ouverture d’un autre provider");
  }
}

// ── Picker modèle : ancrage au contrat Agent + popover responsive ─────────
await fastClick(page.locator('nav.rail button[aria-label="Chat"]'));
await page.waitForTimeout(500);
const pickerTrigger = page.locator(".cx-under-row .model-picker-trigger");
if (await pickerTrigger.count()) {
  await fastClick(pickerTrigger);
  await page.waitForTimeout(250);
  await need(".model-picker-pop", "popover du sélecteur de modèle");
  await screenshot(`${OUT}/10-model-picker.png`);
  await page.keyboard.press("Escape");
}

// ── Largeur compacte : aucune carte kilométrique ni popover hors écran ─────
await page.setViewportSize({ width: 860, height: 900 });
await fastClick(page.locator('nav.rail button[aria-label="Connections"]'));
await page.waitForTimeout(500);
const connectionOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
if (connectionOverflow > 1) missing.push(`overflow horizontal Connections (${connectionOverflow}px)`);
await screenshot(`${OUT}/11-connections-narrow.png`);

await fastClick(page.locator('nav.rail button[aria-label="Chat"]'));
await page.waitForTimeout(400);
const narrowPickerTrigger = page.locator(".cx-under-row .model-picker-trigger");
if (await narrowPickerTrigger.count()) {
  await fastClick(narrowPickerTrigger);
  await page.waitForTimeout(200);
  const pickerBox = await page.locator(".model-picker-pop").boundingBox();
  if (pickerBox && (pickerBox.x < 0 || pickerBox.x + pickerBox.width > 860)) {
    missing.push(`picker hors viewport (${Math.round(pickerBox.x)} + ${Math.round(pickerBox.width)})`);
  }
  await screenshot(`${OUT}/12-model-picker-narrow.png`);
}

await browser.close();
if (preview) await preview.close();

if (missing.length) {
  console.error("❌ Éléments de shell manquants :\n  - " + missing.join("\n  - "));
  process.exit(1);
}
console.log(`✅ Tour UI OK — captures dans ${OUT}/`);
