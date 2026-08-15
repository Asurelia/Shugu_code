# Studio Canvas — Design Spec (2026-07-26)

## Goal

Replace the fragmented Studio (Créer wizard · Projets · Marque · Inspiration catalogue) with a **single mini-Figma-style infinite canvas** where:

- **Produit atlas** = one live frame per HTML page + one component frame per UI block (cards, sections…) under `.shugu-forge/preview/`
- **Exploration** = free frames for variants (HTML snapshots) without breaking the product
- **Brand** = a first-class node on the board (not a tab)
- **Projects** = switcher in the canvas chrome (not a tab)
- Chat and direct manipulation are **equal** (dock + canvas)

## Non-goals (V1)

- Full constraint/layout engine, multi-user collab, vector drawing
- Re-implementing Figma component variants
- Keeping the open-design design-systems catalogue

## Reuse

- `ProjectPreview` / `preview://` / selection bridge / Tweaks
- `studioChat`, `studioProjects`, `brandBoard`, `generationContext`, agents generation mode
- Celestial Veil tokens (`studio.css` + new `studio-canvas.css`)

## Remove

- `DesignView` + `/studio/inspiration` + `/design` catalogue UX
- `public/design-systems/**` (vendored site demos)
- Sub-tab shell (Créer / Projets / Marque / Inspiration)
- 3-step wizard as primary flow → single brief composer in the dock

## Data model

`StudioCanvasDoc` (persisted per workspace via settings key + localStorage):

- `camera { x, y, zoom }`
- `nodes[]`: `live` | `exploration` | `brand`
- `selectedId`

Default doc: one `brand` node + one `live` frame (`index.html`).

## Layout

```
toolbar (project ▾ · new · save · zoom)
layers | infinite canvas | dock (chat + inspector)
```

## Success criteria

1. Opening Studio shows canvas + chat, no sub-tabs, no catalogue.
2. With a generated preview on disk, a live frame renders the real app.
3. Brand edits happen via selecting the brand node (inspector).
4. Project open/save/new works from the toolbar.
5. Unit tests cover canvas doc mutations (move/resize/camera/defaults).
6. `pnpm typecheck` + `pnpm test` pass; no dead imports to DesignView / inspiration.
