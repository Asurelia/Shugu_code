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
// Résolution du navigateur : le chromium du registre Playwright du projet
// s'il est installé (`pnpm exec playwright install chromium`), sinon
// $CHROMIUM, sinon /opt/pw-browsers/chromium (conteneurs Claude Code web).
//
// Les erreurs « Tauri absent » (invoke/transformCallback/WebSocket…) sont
// attendues en navigateur et n'échouent PAS le tour ; seuls les manques
// STRUCTURELS (shell/rail/statusbar absents) sortent en code ≠ 0.

import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 4173);
const BASE = `http://localhost:${PORT}`;
const OUT = "dev-logs/ui-tour";
mkdirSync(OUT, { recursive: true });

function resolveChromium() {
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* registre non installé */ }
  if (process.env.CHROMIUM && existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;
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
  preview = spawn("pnpm", ["preview", "--port", String(PORT)], { stdio: "ignore", detached: true });
  await waitForServer(BASE);
}

const browser = await chromium.launch({ executablePath: resolveChromium() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500); // shell + routes lazy

// ── Overlays premier-lancement : capturés puis retirés ────────────────────
if (await page.locator(".shugu-greeting-overlay").count()) {
  await page.screenshot({ path: `${OUT}/00-onboarding-greeting.png` });
  await page.locator(".shugu-greeting-skip").click().catch(() => {});
  await page.waitForTimeout(500);
  // finish() persiste via db (absente en preview) → retrait DOM de secours.
  await page.evaluate(() => document.querySelector(".shugu-greeting-overlay")?.remove());
}
const later = page.getByRole("button", { name: /plus tard/i });
if (await later.count()) {
  await later.first().click().catch(() => {});
  await page.waitForTimeout(400);
}

// ── Checks structurels (le contrat minimal du shell) ──────────────────────
const missing = [];
const need = async (sel, label) => {
  if ((await page.locator(sel).count()) === 0) missing.push(label + ` (${sel})`);
};
await need("nav.rail", "rail");
await need(".rail-group-label", "labels de groupes du rail");
await need(".shell-statusbar", "statusbar globale");
await need(".tb-bell", "cloche notifications");
await need('nav.rail button[aria-label="Connections"]', "bouton Connections");

await page.screenshot({ path: `${OUT}/01-chat-shell.png` });

// ── Centre de notifications ───────────────────────────────────────────────
await page.locator(".tb-bell").click().catch(() => {});
await page.waitForTimeout(400);
await need(".notif-pop", "panneau notifications");
await page.screenshot({ path: `${OUT}/02-notification-center.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── Composer : auto-grow multi-lignes (régression fréquente) ─────────────
const ta = page.locator(".cx-composer-input");
if (await ta.count()) {
  const h1 = (await ta.boundingBox())?.height ?? 0;
  await ta.click().catch(() => {});
  await ta.fill("ligne 1\nligne 2\nligne 3\nligne 4\nligne 5\nligne 6").catch(() => {});
  await page.waitForTimeout(300);
  const h2 = (await ta.boundingBox())?.height ?? 0;
  if (h2 <= h1 + 30) missing.push(`auto-grow composer (h ${h1}→${h2})`);
  await page.screenshot({ path: `${OUT}/07-composer-multiline.png` });
  await ta.fill("").catch(() => {});
}

// ── Vues principales via le rail ──────────────────────────────────────────
const views = [
  ["Editor", "03-editor"],
  ["Source Control", "04-git"],
  ["Agents", "05-agents"],
  ["Settings", "06-settings"],
];
for (const [label, shot] of views) {
  await page.locator(`nav.rail button[aria-label="${label}"]`).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${shot}.png` });
}

await browser.close();
if (preview) process.kill(-preview.pid, "SIGTERM");

if (missing.length) {
  console.error("❌ Éléments de shell manquants :\n  - " + missing.join("\n  - "));
  process.exit(1);
}
console.log(`✅ Tour UI OK — captures dans ${OUT}/`);
