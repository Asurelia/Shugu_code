// Shugu Forge — discover UI pages/components from the OPEN workspace.
// Not the forge silo, not "please start a server": scan disk → atlas frames.

import {
  discoverPages,
  wrapComponentPreview,
  type AtlasComponent,
  type AtlasPage,
} from "./productAtlas";

const SKIP_DIR = /(?:^|\/)(?:node_modules|target|\.git|dist\/assets|dev-logs|_design_extracted)(?:\/|$)/i;

/** HTML candidates that look like real pages (not email templates buried deep). */
export function filterWorkspaceHtmlPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/");
    if (!/\.html?$/i.test(p)) continue;
    if (SKIP_DIR.test(p)) continue;
    if (p.includes(".shugu-forge/")) continue;
    const parts = p.split("/");
    // Prefer shallow pages; allow dist/index.html and public/*.html
    if (parts.length > 4 && !p.startsWith("dist/") && !p.startsWith("public/")) continue;
    out.push(p);
  }
  out.sort((a, b) => {
    const score = (x: string) => {
      if (x === "index.html" || x === "dist/index.html") return 0;
      if (x.startsWith("public/")) return 1;
      if (x.startsWith("dist/")) return 2;
      return 3;
    };
    return score(a) - score(b) || a.localeCompare(b);
  });
  return out;
}

export function discoverWorkspacePages(htmlPaths: string[]): AtlasPage[] {
  return discoverPages(filterWorkspaceHtmlPaths(htmlPaths));
}

/** Standalone SVG files → icon component cards (outerHtml filled after read). */
export function discoverSvgComponents(paths: string[]): AtlasComponent[] {
  const out: AtlasComponent[] = [];
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/");
    if (!/\.svg$/i.test(p)) continue;
    if (SKIP_DIR.test(p)) continue;
    if (p.includes(".shugu-forge/")) continue;
    const base = p.split("/").pop()!.replace(/\.svg$/i, "");
    out.push({
      id: `comp-svg-${slug(base)}`,
      pageRoute: p,
      name: `Icône · ${nice(base)}`,
      outerHtml: "",
    });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Extract inline SVG icons from an Icon() switch (or similar).
 * Matches: case "chat": return p(<>...</>);
 */
export function extractIconsFromTsSource(source: string, sourcePath: string): AtlasComponent[] {
  const out: AtlasComponent[] = [];
  // case "chat": return p(<>...</>);  OR  return p(<svg>...</svg>);
  const re =
    /case\s+["']([a-z0-9_-]+)["']\s*:\s*return\s+p\(\s*(?:<>\s*)?([\s\S]*?)\s*(?:<\/>\s*)?\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    let body = m[2].trim();
    if (!body) continue;
    body = body
      .replace(/\bclassName=/g, "class=")
      .replace(/\bstrokeWidth=/g, "stroke-width=")
      .replace(/\bstrokeLinecap=/g, "stroke-linecap=")
      .replace(/\bstrokeLinejoin=/g, "stroke-linejoin=")
      .replace(/\bfillRule=/g, "fill-rule=")
      .replace(/\bclipRule=/g, "clip-rule=");
    if (!/^<svg/i.test(body)) {
      body = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    } else if (!/xmlns=/.test(body)) {
      body = body.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    out.push({
      id: `comp-icon-${slug(name)}`,
      pageRoute: sourcePath,
      name: `Icône · ${name}`,
      outerHtml: `<div class="studio-icon-specimen" style="display:grid;place-items:center;min-height:120px;color:#e8e8ec">${body}</div>`,
    });
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * Build UI kit specimens (buttons, cards, inputs) from project CSS class names.
 */
export function extractCssUiSpecimens(css: string): AtlasComponent[] {
  const classes = new Set<string>();
  const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    classes.add(m[1]);
  }

  const specimens: { id: string; name: string; html: string; need: string[] }[] = [
    {
      id: "comp-kit-buttons",
      name: "Boutons",
      need: ["lgb", "btn", "button"],
      html: classes.has("lgb")
        ? `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
              <button type="button" class="lgb">Secondaire</button>
              <button type="button" class="lgb lgb-primary">Primaire</button>
              <button type="button" class="lgb lgb-sm">Petit</button>
              <button type="button" class="lgb lgb-lg lgb-primary">Large</button>
            </div>`
        : classes.has("btn")
          ? `<div style="display:flex;gap:10px"><button class="btn">Button</button><button class="btn btn-primary">Primary</button></div>`
          : `<div style="display:flex;gap:10px"><button type="button">Button</button><button type="button">Primary</button></div>`,
    },
    {
      id: "comp-kit-cards",
      name: "Cartes",
      need: ["card", "panel", "tile", "glass"],
      html: classes.has("card")
        ? `<div class="card" style="padding:16px;max-width:320px"><strong>Carte</strong><p style="opacity:.75;margin:.5em 0 0">Contenu extrait du design system du projet.</p></div>`
        : `<div style="padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:12px;max-width:320px;background:rgba(255,255,255,.04)"><strong>Carte</strong><p style="opacity:.75;margin:.5em 0 0">Spécimen UI du projet ouvert.</p></div>`,
    },
    {
      id: "comp-kit-inputs",
      name: "Champs",
      need: ["input", "field", "studio-brief", "search"],
      html: `<div style="display:flex;flex-direction:column;gap:10px;max-width:360px">
        <input type="text" placeholder="Texte…" style="padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit"/>
        <textarea rows="3" placeholder="Zone de texte…" style="padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;resize:vertical"></textarea>
      </div>`,
    },
  ];

  const out: AtlasComponent[] = [];
  for (const s of specimens) {
    const hit = s.need.some((n) => [...classes].some((c) => c === n || c.includes(n)));
    if (!hit && s.id !== "comp-kit-inputs") continue;
    if (!hit && s.id === "comp-kit-inputs" && classes.size < 5) continue;
    out.push({
      id: s.id,
      pageRoute: "ui-kit",
      name: s.name,
      outerHtml: s.html,
    });
  }
  return out;
}

/** Routes declared in TanStack / React Router style source. */
export function discoverRoutesFromSource(source: string): AtlasPage[] {
  const pages: AtlasPage[] = [];
  const seen = new Set<string>();
  const re = /path:\s*["'](\/[^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const path = m[1];
    if (path === "/" || path.includes("*") || path.includes("$")) continue;
    if (seen.has(path)) continue;
    if (path.startsWith("/studio/")) continue;
    seen.add(path);
    const slug = path.replace(/^\//, "") || "index";
    pages.push({
      route: `route:${slug}`,
      name: `Page · ${nice(slug)}`,
    });
  }
  return pages;
}

export function aggregateCss(files: { path: string; text: string }[]): string {
  const rank = (p: string) => {
    const x = p.replace(/\\/g, "/").toLowerCase();
    if (x.includes("token")) return 0;
    if (x.includes("celestial") || x.includes("foundation")) return 1;
    if (x.includes("styles.css")) return 2;
    if (x.includes("typography")) return 3;
    return 5;
  };
  return [...files]
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
    .map((f) => `/* ${f.path} */\n${f.text}`)
    .join("\n\n")
    .slice(0, 60_000);
}

/** One canvas card for many icons — never one iframe per icon. */
export function packIconsSheet(icons: AtlasComponent[]): AtlasComponent | null {
  if (!icons.length) return null;
  const cells = icons
    .slice(0, 32)
    .map((icon) => {
      const inner = stripDocToBody(icon.outerHtml) || icon.name;
      return `<div data-shugu-component="${escapeAttr(icon.name)}" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">
        <div style="width:40px;height:40px;display:grid;place-items:center;color:#e8e8ec">${inner}</div>
        <span style="font-size:10px;opacity:.65;text-align:center">${escapeAttr(icon.name.replace(/^Icône · /, ""))}</span>
      </div>`;
    })
    .join("\n");
  return {
    id: "comp-icons-sheet",
    pageRoute: icons[0].pageRoute,
    name: `Icônes (${Math.min(icons.length, 32)})`,
    outerHtml: `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:10px;padding:4px">${cells}</div>`,
  };
}

export function buildComponentHtml(
  components: AtlasComponent[],
  css: string,
): AtlasComponent[] {
  return components.map((c) => ({
    ...c,
    outerHtml: c.outerHtml.includes("<!DOCTYPE")
      ? c.outerHtml
      : wrapComponentPreview(c.outerHtml || `<p>${c.name}</p>`, css, c.name),
  }));
}

/** Synthetic home page when the project has no static HTML but has UI specimens. */
export function buildUiKitHomeHtml(
  components: AtlasComponent[],
  css: string,
  projectName: string,
): string {
  const cards = components
    .slice(0, 12)
    .map(
      (c) =>
        `<article data-shugu-component="${escapeAttr(c.name)}" style="padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.03)">
          <div style="font-size:12px;opacity:.6;margin-bottom:8px">${escapeAttr(c.name)}</div>
          ${stripDocToBody(c.outerHtml)}
        </article>`,
    )
    .join("\n");
  const body = `
<header style="margin-bottom:24px">
  <h1 style="margin:0 0 8px;font-size:22px">${escapeAttr(projectName)}</h1>
  <p style="margin:0;opacity:.7;font-size:14px">Atlas UI/UX extrait du projet ouvert — pages, composants, icônes. Sélectionne un bloc pour le modifier.</p>
</header>
<section style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px">
${cards}
</section>`;
  return wrapComponentPreview(body, css, projectName);
}

function stripDocToBody(html: string): string {
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) return html;
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  );
}

function nice(s: string): string {
  return s.replace(/[-_/]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function isWorkspaceHtmlRoute(route: string | undefined): boolean {
  return !!route && !route.startsWith("route:") && /\.html?$/i.test(route);
}

export function workspacePreviewPath(route: string): string {
  return `__ws__/${route.replace(/^\/+/, "")}`;
}
