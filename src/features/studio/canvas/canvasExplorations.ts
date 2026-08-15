// Shugu Forge — Studio exploration frames (disk ↔ canvas sync).
//
// Convention (local-first, no mock):
//   `.shugu-forge/canvas/explorations/<slug>.html`
// The agent deposits variants with `studio_deposit_exploration` or `fs_write_file`.
// The live product stays in `.shugu-forge/preview/` (jumeau).
// Pure merge helpers are unit-tested; I/O lives in the workspace effect.

import {
  addExplorationFrame,
  type CanvasNode,
  type StudioCanvasDoc,
} from "./studioCanvasDoc";

export const EXPLORATIONS_DIR = ".shugu-forge/canvas/explorations";

export interface ExplorationFile {
  /** Filename stem, e.g. "hero-dark". */
  slug: string;
  /** Display name (from <title> or humanized slug). */
  name: string;
  html: string;
}

export function explorationNodeId(slug: string): string {
  return `exp-${slug}`;
}

export function isExplorationNodeId(id: string): boolean {
  return id.startsWith("exp-");
}

export function slugFromFileName(fileName: string): string | null {
  const m = /^([a-z0-9][a-z0-9._-]{0,63})\.html$/i.exec(fileName.trim());
  if (!m) return null;
  return m[1].toLowerCase();
}

/** Sanitize a free-form name into a safe slug for the explorations dir. */
export function slugifyExploration(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || `variant-${Date.now().toString(36)}`;
}

export function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Pull a display title from HTML, else fall back to the slug. */
export function titleFromHtml(html: string, slug: string): string {
  const m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html);
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t || humanizeSlug(slug);
}

export function explorationRelPath(slug: string): string {
  return `${EXPLORATIONS_DIR}/${slug}.html`;
}

/**
 * Upsert disk explorations onto the canvas and drop stale `exp-*` nodes
 * that no longer exist on disk. Non-exploration nodes (live/brand/manual)
 * are untouched. Manual exploration nodes without `exp-` prefix are kept.
 */
export function mergeExplorationsIntoDoc(
  doc: StudioCanvasDoc,
  files: ExplorationFile[],
): StudioCanvasDoc {
  const bySlug = new Map(files.map((f) => [f.slug, f]));
  const keepIds = new Set([...bySlug.keys()].map(explorationNodeId));

  let nodes: CanvasNode[] = doc.nodes.filter(
    (n) => !(n.kind === "exploration" && isExplorationNodeId(n.id) && !keepIds.has(n.id)),
  );

  let next: StudioCanvasDoc = { ...doc, nodes };
  let selectedId = doc.selectedId;

  for (const file of files) {
    const id = explorationNodeId(file.slug);
    const existing = next.nodes.find((n) => n.id === id);
    if (existing) {
      next = {
        ...next,
        nodes: next.nodes.map((n) =>
          n.id === id
            ? { ...n, kind: "exploration", name: file.name, html: file.html }
            : n,
        ),
      };
    } else {
      next = addExplorationFrame(next, {
        id,
        name: file.name,
        html: file.html,
      });
      // addExplorationFrame selects the new node — restore prior selection
      // unless nothing was selected (first deposit should focus the variant).
      if (selectedId) next = { ...next, selectedId };
    }
  }

  // If selection pointed at a removed exploration, clear it.
  if (next.selectedId && !next.nodes.some((n) => n.id === next.selectedId)) {
    next = { ...next, selectedId: null };
  }

  return next;
}

/** True when merge would change node ids / html / names (avoid persist loops). */
export function explorationsChanged(
  before: StudioCanvasDoc,
  after: StudioCanvasDoc,
): boolean {
  const a = before.nodes
    .filter((n) => n.kind === "exploration")
    .map((n) => `${n.id}\0${n.name}\0${n.html ?? ""}`)
    .sort()
    .join("\n");
  const b = after.nodes
    .filter((n) => n.kind === "exploration")
    .map((n) => `${n.id}\0${n.name}\0${n.html ?? ""}`)
    .sort()
    .join("\n");
  return a !== b;
}
