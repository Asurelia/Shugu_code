// Shugu Forge — Product atlas: pages + visual components on the Studio canvas.
//
// The canvas should feel like a native board of the app under construction:
//   • one LIVE frame per HTML page under `.shugu-forge/preview/`
//   • one COMPONENT frame per marked / discovered UI block (cards, sections…)
// Pure helpers (unit-tested). I/O + DOMParser live at the call site / here.

import type { CanvasNode, StudioCanvasDoc } from "./studioCanvasDoc";
import { BRAND_NODE_ID, LIVE_HOME_ID } from "./studioCanvasDoc";

export const PAGE_W = 1100;
export const PAGE_H = 720;
export const COMP_W = 420;
export const COMP_H = 340;
export const ATLAS_GAP = 64;
export const MAX_COMPONENTS = 8;
export const MAX_PAGES = 6;

export interface AtlasPage {
  route: string;
  name: string;
  /** Optional inline HTML (srcDoc) when the page is not a static file on disk. */
  html?: string;
}

export interface AtlasComponent {
  /** Stable id: comp-<pageSlug>-<compSlug> */
  id: string;
  pageRoute: string;
  name: string;
  outerHtml: string;
}

export function pageNodeId(route: string): string {
  const slug = route.replace(/\.html$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "index";
  if (slug === "index" || slug === "dist-index" || slug === "public-index" || slug === "ui-kit-home") {
    return LIVE_HOME_ID;
  }
  return `page-${slug}`;
}

export function isAtlasPageId(id: string): boolean {
  return id === LIVE_HOME_ID || id.startsWith("page-");
}

export function isAtlasComponentId(id: string): boolean {
  return id.startsWith("comp-");
}

export function pageTitleFromRoute(route: string): string {
  const base = route.replace(/\.html$/i, "").split("/").pop() || "index";
  if (base === "index") return "Page · Accueil";
  const nice = base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `Page · ${nice}`;
}

/** HTML files at the preview root (and one level deep). */
export function discoverPages(fileNames: string[]): AtlasPage[] {
  const pages: AtlasPage[] = [];
  const seen = new Set<string>();
  for (const raw of fileNames) {
    const name = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!/\.html$/i.test(name)) continue;
    // Skip nested noise (node_modules-like) — only root or single folder.
    const parts = name.split("/");
    if (parts.length > 2) continue;
    if (parts.some((p) => p.startsWith("."))) continue;
    const route = name;
    if (seen.has(route)) continue;
    seen.add(route);
    pages.push({ route, name: pageTitleFromRoute(route) });
  }
  pages.sort((a, b) => {
    if (a.route === "index.html") return -1;
    if (b.route === "index.html") return 1;
    return a.route.localeCompare(b.route);
  });
  return pages;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "block"
  );
}

/**
 * Extract visual components from a page's HTML.
 * Priority: data-shugu-component / data-component → section[id|aria-label] → .card-like.
 */
export function extractComponentsFromHtml(html: string, pageRoute: string): AtlasComponent[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pageSlug = pageRoute.replace(/\.html$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "index";
  const out: AtlasComponent[] = [];
  const used = new Set<Element>();

  const push = (el: Element, name: string) => {
    if (used.has(el) || out.length >= MAX_COMPONENTS) return;
    // Skip tiny / invisible-ish nodes
    const text = (el.textContent || "").trim();
    if (text.length < 2 && !el.querySelector("img,svg,video,canvas")) return;
    used.add(el);
    const slug = slugify(name);
    let id = `comp-${pageSlug}-${slug}`;
    let n = 2;
    while (out.some((c) => c.id === id)) {
      id = `comp-${pageSlug}-${slug}-${n++}`;
    }
    out.push({
      id,
      pageRoute,
      name: name.trim().slice(0, 60) || "Composant",
      outerHtml: el.outerHTML,
    });
  };

  // 1) Explicit marks (generation contract)
  doc.querySelectorAll("[data-shugu-component], [data-component]").forEach((el) => {
    const name =
      el.getAttribute("data-shugu-component") ||
      el.getAttribute("data-component") ||
      "Composant";
    push(el, name);
  });

  if (out.length > 0) return out;

  // 2) Landmark sections (when unmarked)
  doc.querySelectorAll("section, article, header, footer, nav, main > *").forEach((el) => {
    if (out.length >= MAX_COMPONENTS) return;
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("id") ||
      el.getAttribute("data-name") ||
      (el.className && String(el.className).split(/\s+/).find((c) => c && !/^js-/.test(c))) ||
      el.tagName.toLowerCase();
    push(el, String(name));
  });

  // 3) Card-like blocks (add more visual units; skip already-captured ancestors/descendants)
  doc
    .querySelectorAll(
      ".card, [class*='card'], [class*='Card'], .feature, .pricing-card, .tile, .panel",
    )
    .forEach((el) => {
      if (out.length >= MAX_COMPONENTS) return;
      if ([...used].some((u) => u.contains(el) || el.contains(u))) return;
      const name =
        el.getAttribute("aria-label") ||
        el.getAttribute("data-name") ||
        (el.className && String(el.className).split(/\s+/).find(Boolean)) ||
        "Carte";
      push(el, String(name));
    });

  return out.slice(0, MAX_COMPONENTS);
}

/** Standalone HTML doc so a component renders with project CSS. */
export function wrapComponentPreview(outerHtml: string, css: string, name: string): string {
  const safeName = name.replace(/</g, "");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeName}</title>
<style>
html,body{margin:0;padding:16px;min-height:100%;background:#0b0d12;color:#e8e8ec;font-family:system-ui,sans-serif;box-sizing:border-box;}
*,*:before,*:after{box-sizing:inherit;}
${css}
</style>
</head>
<body>
${outerHtml}
</body>
</html>`;
}

export function layoutPagePos(index: number): { x: number; y: number; width: number; height: number } {
  return {
    x: 40 + index * (PAGE_W + ATLAS_GAP),
    y: 40,
    width: PAGE_W,
    height: PAGE_H,
  };
}

export function layoutComponentPos(
  index: number,
): { x: number; y: number; width: number; height: number } {
  const cols = 3;
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    x: 40 + col * (COMP_W + ATLAS_GAP / 2),
    y: 40 + PAGE_H + ATLAS_GAP + 40 + row * (COMP_H + ATLAS_GAP / 2),
    width: COMP_W,
    height: COMP_H,
  };
}

export interface AtlasMergeInput {
  pages: AtlasPage[];
  components: AtlasComponent[];
  /** Project styles.css (injected into component srcDocs). */
  css: string;
}

/**
 * Rebuild atlas-managed page/component nodes from disk discovery.
 * Preserves x/y/w/h of existing nodes with the same id (user layout).
 * Brand + exploration nodes are kept as-is.
 */
export function mergeProductAtlas(doc: StudioCanvasDoc, input: AtlasMergeInput): StudioCanvasDoc {
  const brandNode: CanvasNode =
    doc.nodes.find((n) => n.id === BRAND_NODE_ID) ??
    ({
      id: BRAND_NODE_ID,
      kind: "brand",
      name: "Marque",
      x: -420,
      y: 40,
      width: 320,
      height: 220,
      zIndex: 1,
    } satisfies CanvasNode);

  // Keep explorations (and any future non-atlas kinds) — drop previous pages/components.
  const explorations = doc.nodes.filter((n) => n.kind === "exploration");
  const prevById = new Map(doc.nodes.map((n) => [n.id, n]));
  const pages = (input.pages.length > 0 ? input.pages : [{ route: "index.html", name: "Page · Accueil" }]).slice(
    0,
    MAX_PAGES,
  );
  const components = input.components.slice(0, MAX_COMPONENTS);

  const pageNodes: CanvasNode[] = pages.map((p, i) => {
    const id = pageNodeId(p.route);
    const prev = prevById.get(id);
    const layout = layoutPagePos(i);
    return {
      id,
      kind: "live" as const,
      name: p.name,
      x: prev?.x ?? layout.x,
      y: prev?.y ?? layout.y,
      width: prev?.width ?? layout.width,
      height: prev?.height ?? layout.height,
      zIndex: prev?.zIndex ?? 10 + i,
      route: p.route,
      html: p.html,
    };
  });

  const compNodes: CanvasNode[] = components.map((c, i) => {
    const prev = prevById.get(c.id);
    const layout = layoutComponentPos(i);
    const html = c.outerHtml.includes("<!DOCTYPE")
      ? c.outerHtml
      : wrapComponentPreview(c.outerHtml, input.css, c.name);
    return {
      id: c.id,
      kind: "component" as const,
      name: c.name,
      x: prev?.x ?? layout.x,
      y: prev?.y ?? layout.y,
      width: prev?.width ?? layout.width,
      height: prev?.height ?? layout.height,
      zIndex: prev?.zIndex ?? 100 + i,
      route: c.pageRoute,
      html,
    };
  });

  const nodes: CanvasNode[] = [brandNode, ...explorations, ...pageNodes, ...compNodes];
  let selectedId = doc.selectedId;
  if (selectedId && !nodes.some((n) => n.id === selectedId)) {
    selectedId = pageNodes[0]?.id ?? null;
  }

  return { ...doc, nodes, selectedId };
}

export function atlasVisualFingerprint(doc: StudioCanvasDoc): string {
  return doc.nodes
    .filter((n) => n.kind === "live" || n.kind === "component")
    .map((n) => `${n.id}\0${n.name}\0${n.route ?? ""}\0${(n.html ?? "").length}`)
    .sort()
    .join("\n");
}
