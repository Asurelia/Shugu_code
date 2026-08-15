// Shugu Forge — Studio DOM layers (Lot E) — pure helpers.
//
// The injected preview controller walks the served page and reports a FLAT,
// capped list of elements; this module formats and filters that list for the
// layers panel. Hover → bridge highlights the element in the frame; click →
// selects it (same descriptor contract as the click-selection bridge).

export interface DomTreeItem {
  /** Index in the controller's element table (drives highlight/pick). */
  i: number;
  depth: number;
  tag: string;
  /** "#id" / ".classes" suffixes, may be empty. */
  suffix: string;
  /** Text snippet (may be empty). */
  text: string;
}

/** One-line label for the layers panel. */
export function domItemLabel(it: Pick<DomTreeItem, "tag" | "suffix" | "text">): string {
  const base = `${it.tag}${it.suffix}`;
  const t = it.text.trim();
  return t ? `${base} — ${t.slice(0, 40)}` : base;
}

/** Case-insensitive filter on tag / suffix / text. Empty query keeps all. */
export function filterDomItems<T extends Pick<DomTreeItem, "tag" | "suffix" | "text">>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.tag.toLowerCase().includes(q) ||
      it.suffix.toLowerCase().includes(q) ||
      it.text.toLowerCase().includes(q),
  );
}

/** Cap the rendered list — the controller already caps the walk, this caps the paint. */
export const DOM_LAYERS_RENDER_CAP = 120;
