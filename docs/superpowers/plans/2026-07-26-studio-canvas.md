# Studio Canvas Implementation Plan

> **For agentic workers:** implement / verify against `docs/superpowers/specs/2026-07-26-studio-canvas-design.md`.

**Goal:** Canvas-first Studio (mini-Figma pragmatique), catalogue open-design retiré.

## Status (2026-07-26)

### Done
- [x] Spec + canvas doc model + unit tests (`studioCanvasDoc.ts` / `.test.ts`)
- [x] Persist store (`studioCanvasStore.ts`)
- [x] `StudioCanvas` + `CanvasLayers` + `StudioWorkspace`
- [x] `StudioShell` → workspace only (no sub-tabs)
- [x] Router: `/studio` only; legacy redirects
- [x] `DesignView` deleted; `design-systems/index.json` → `[]`
- [x] `ProjectPreview` embedded mode for live frames
- [x] Cleanup script `scripts/remove-design-catalogue.mjs`

### Remaining / next
- [x] Run `node scripts/remove-design-catalogue.mjs`
- [x] `pnpm test` studio + `pnpm typecheck`
- [x] Dead views removed (`StudioView` / `StudioBrandView` / `StudioProjectsView`)
- [x] Agent tool `studio_deposit_exploration` + disk sync → canvas
- [ ] Manual: `tauri-dev.cmd` → generate → deposit exploration → frame appears
- [ ] Optional: promote exploration → product (copy into preview/)

## Verify
```bash
pnpm test -- src/features/studio/canvas/studioCanvasDoc.test.ts
pnpm typecheck
node scripts/remove-design-catalogue.mjs
```
