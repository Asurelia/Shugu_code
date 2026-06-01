# Cockpit — Lot 1 « Le shell à surfaces » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire coexister le chat (scène) et l'éditeur (surface d'un panneau droit redimensionnable) dans une même vue, derrière le flag `ui.cockpit`, sans casser l'app existante.

**Architecture:** Un nouveau dossier `src/features/cockpit/` autonome. Le cockpit se branche **dans la route `/chat`** (route-wrapper conditionnel au flag) — aucun changement de routeur, de commandes ou de `RootLayout`. L'état de layout est un **store React Query** (idiome du projet, cf. `editorSelectionStore.ts`), persisté en SQLite `db.settings` (pattern `ide-state.ts`, LOCAL-FIRST). Le panneau droit utilise `react-resizable-panels` (déjà au projet via le Dock) avec un panneau **collapsible gardé monté** (keep-warm) pour que `editorViewRef` reste vivant.

**Tech Stack:** React 18, TanStack Router + React Query, `react-resizable-panels` ^2, CodeMirror 6 (`CodeView` réutilisé), Tauri SQLite (`db.settings`), Vitest + happy-dom.

**Réf design :** `docs/superpowers/specs/2026-05-31-cockpit-agent-workspace-design.md` (Lot Cockpit-1).

---

## File Structure

**Nouveaux fichiers (dossier `src/features/cockpit/`) :**
- `layout.ts` — types purs (`SurfaceId`, `CockpitLayout`), `DEFAULT_LAYOUT`, `normalizeLayout` (validation tolérante). **Aucune** dépendance (testable isolément).
- `layout.test.ts` — tests de `normalizeLayout`.
- `surfaces.ts` — registre des surfaces (métadonnées + liste du `+`-menu).
- `surfaces.test.ts` — tests du registre.
- `layoutPersistence.ts` — `loadLayout`/`saveLayout` via `db.settings` (import dynamique de `db` pour ne pas charger Tauri dans les tests purs).
- `layoutStore.ts` — store React Query (live + save debouncée).
- `useCockpitFlag.ts` — hook + lecture non-hook du flag `ui.cockpit`.
- `ReviewSurface.tsx` — surface « Révision » minimale (vraie diff au Lot C2).
- `SurfaceHost.tsx` — monte les surfaces **keep-warm** (visibilité togglée, jamais d'unmount).
- `RightPanel.tsx` — barre d'onglets + `+`-menu + bouton fermer + `SurfaceHost`.
- `CockpitShell.tsx` — `PanelGroup` (chat | panneau droit), keep-warm via panneau collapsible.

**Fichiers modifiés :**
- `src/routes/chat.tsx` — rend `CockpitShell` si flag ON, sinon `ChatView` (comportement actuel).
- `src/features/settings/settings-extras.tsx` — ajoute le toggle `CockpitRow` (`ui.cockpit`, défaut OFF).

---

## Task 1: Types & normalizer purs (`layout.ts`)

**Files:**
- Create: `src/features/cockpit/layout.ts`
- Test: `src/features/cockpit/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/cockpit/layout.test.ts
import { describe, it, expect } from "vitest";
import { normalizeLayout, DEFAULT_LAYOUT } from "./layout";

describe("normalizeLayout", () => {
  it("returns defaults for non-object input", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout("nope")).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout(42)).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps a fully valid layout", () => {
    const valid = { rightPanelOpen: true, activeSurface: "review", sizes: [60, 40] };
    expect(normalizeLayout(valid)).toEqual(valid);
  });

  it("coerces an unknown surface to the default", () => {
    const out = normalizeLayout({ rightPanelOpen: true, activeSurface: "wat", sizes: [50, 50] });
    expect(out.activeSurface).toBe(DEFAULT_LAYOUT.activeSurface);
  });

  it("rejects out-of-range or malformed sizes", () => {
    expect(normalizeLayout({ sizes: [0, 100] }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
    expect(normalizeLayout({ sizes: [50] }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
    expect(normalizeLayout({ sizes: "x" }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
  });

  it("fills missing fields from defaults", () => {
    expect(normalizeLayout({ rightPanelOpen: true })).toEqual({
      ...DEFAULT_LAYOUT,
      rightPanelOpen: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/features/cockpit/layout.test.ts`
Expected: FAIL — `Cannot find module './layout'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/features/cockpit/layout.ts
// Cockpit layout — pure types + tolerant normalizer. NO imports (testable in
// isolation; db access lives in layoutPersistence.ts).

export type SurfaceId = "editor" | "review" | "terminal" | "files" | "browser";

export const SURFACES: SurfaceId[] = ["editor", "review", "terminal", "files", "browser"];

export interface CockpitLayout {
  /** Right panel expanded (true) or collapsed/keep-warm (false). */
  rightPanelOpen: boolean;
  /** Which surface occupies the right panel. */
  activeSurface: SurfaceId;
  /** [chatPct, panelPct] — react-resizable-panels sizes (each in (0,100)). */
  sizes: [number, number];
}

export const DEFAULT_LAYOUT: CockpitLayout = {
  rightPanelOpen: false,
  activeSurface: "editor",
  sizes: [55, 45],
};

function isSurface(v: unknown): v is SurfaceId {
  return typeof v === "string" && (SURFACES as string[]).includes(v);
}

function isSizes(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && n > 0 && n < 100)
  );
}

/** Coerce any persisted/unknown value into a valid CockpitLayout. */
export function normalizeLayout(raw: unknown): CockpitLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const o = raw as Record<string, unknown>;
  return {
    rightPanelOpen:
      typeof o.rightPanelOpen === "boolean" ? o.rightPanelOpen : DEFAULT_LAYOUT.rightPanelOpen,
    activeSurface: isSurface(o.activeSurface) ? o.activeSurface : DEFAULT_LAYOUT.activeSurface,
    sizes: isSizes(o.sizes) ? o.sizes : DEFAULT_LAYOUT.sizes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/features/cockpit/layout.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/cockpit/layout.ts src/features/cockpit/layout.test.ts
git commit -m "✨ feat(cockpit): types + normalizer de layout (purs, testés)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Registre des surfaces (`surfaces.ts`)

**Files:**
- Create: `src/features/cockpit/surfaces.ts`
- Test: `src/features/cockpit/surfaces.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/cockpit/surfaces.test.ts
import { describe, it, expect } from "vitest";
import { SURFACE_META, SURFACE_MENU, surfaceLabel } from "./surfaces";
import { SURFACES } from "./layout";

describe("surfaces registry", () => {
  it("has metadata for every SurfaceId", () => {
    for (const id of SURFACES) {
      expect(SURFACE_META[id]).toBeDefined();
      expect(SURFACE_META[id].id).toBe(id);
      expect(typeof SURFACE_META[id].label).toBe("string");
    }
  });

  it("menu lists editor and review as available (not comingSoon)", () => {
    const editor = SURFACE_MENU.find((s) => s.id === "editor");
    const review = SURFACE_MENU.find((s) => s.id === "review");
    expect(editor?.comingSoon).toBeFalsy();
    expect(review?.comingSoon).toBeFalsy();
  });

  it("menu marks terminal/files/browser as comingSoon (Lot C4)", () => {
    for (const id of ["terminal", "files", "browser"] as const) {
      expect(SURFACE_MENU.find((s) => s.id === id)?.comingSoon).toBe(true);
    }
  });

  it("surfaceLabel returns the label", () => {
    expect(surfaceLabel("editor")).toBe("Éditeur");
    expect(surfaceLabel("review")).toBe("Révision");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/features/cockpit/surfaces.test.ts`
Expected: FAIL — `Cannot find module './surfaces'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/features/cockpit/surfaces.ts
// Right-panel surface registry. C1 ships "editor" + "review" as real; the rest
// are listed but disabled (comingSoon) until Lot C4. `icon` is only set for the
// two confirmed icons in the shared <Icon/> set ("code", "git") to avoid
// depending on icon names that may not exist yet.
import type { SurfaceId } from "./layout";

export interface SurfaceMeta {
  id: SurfaceId;
  label: string;
  icon?: string;
  /** True until the surface becomes functional (Lot C4). */
  comingSoon?: boolean;
}

export const SURFACE_META: Record<SurfaceId, SurfaceMeta> = {
  editor:   { id: "editor",   label: "Éditeur",    icon: "code" },
  review:   { id: "review",   label: "Révision",   icon: "git" },
  terminal: { id: "terminal", label: "Terminal",   comingSoon: true },
  files:    { id: "files",    label: "Fichiers",   comingSoon: true },
  browser:  { id: "browser",  label: "Navigateur", comingSoon: true },
};

/** Ordered list for the "+"-menu. */
export const SURFACE_MENU: SurfaceMeta[] = [
  SURFACE_META.editor,
  SURFACE_META.review,
  SURFACE_META.terminal,
  SURFACE_META.files,
  SURFACE_META.browser,
];

export function surfaceLabel(id: SurfaceId): string {
  return SURFACE_META[id].label;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/features/cockpit/surfaces.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/cockpit/surfaces.ts src/features/cockpit/surfaces.test.ts
git commit -m "✨ feat(cockpit): registre des surfaces du panneau droit (+ menu)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Persistance SQLite (`layoutPersistence.ts`)

**Files:**
- Create: `src/features/cockpit/layoutPersistence.ts`

Pas de test unitaire ici : ce module touche `db` (Tauri SQLite) ; il est vérifié par `typecheck` puis « en voyant » (Task 9, le layout survit au reload). `db` est importé **dynamiquement** pour ne pas charger Tauri dans les tests purs des Tasks 1-2.

- [ ] **Step 1: Write the implementation**

```ts
// src/features/cockpit/layoutPersistence.ts
// LOCAL-FIRST persistence of the cockpit layout, mirroring ide-state.ts:
// SQLite db.settings, key "ide.layout.v1", schema-tolerant load.
import { normalizeLayout, DEFAULT_LAYOUT, type CockpitLayout } from "./layout";

const KEY = "ide.layout.v1";

/** Read the persisted layout (defaults if absent/malformed). */
export async function loadLayout(): Promise<CockpitLayout> {
  try {
    const { db } = await import("@/lib/db");
    const raw = await db.settings.get(KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return normalizeLayout(JSON.parse(raw));
  } catch (err) {
    console.warn("[cockpit] loadLayout failed:", err);
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist the layout. Best-effort: a failure is logged and swallowed. */
export async function saveLayout(layout: CockpitLayout): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.settings.set(KEY, JSON.stringify(normalizeLayout(layout)));
  } catch (err) {
    console.warn("[cockpit] saveLayout failed:", err);
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS (no errors). Confirme que `db.settings.get/set` existe avec ces signatures (utilisé déjà par `ide-state.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/features/cockpit/layoutPersistence.ts
git commit -m "✨ feat(cockpit): persistance du layout en SQLite (pattern ide-state)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Store React Query (`layoutStore.ts`)

**Files:**
- Create: `src/features/cockpit/layoutStore.ts`

Idiome du projet : React Query comme conteneur réactif (cf. `editorSelectionStore.ts`). La sauvegarde SQLite est **debouncée** (400 ms) pour ne pas écrire à chaque drag.

- [ ] **Step 1: Write the implementation**

```ts
// src/features/cockpit/layoutStore.ts
// Cockpit layout store — React Query as the reactive container (project idiom,
// cf. editorSelectionStore.ts). Live mutations update the cache immediately;
// SQLite persistence is debounced via saveLayout.
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { DEFAULT_LAYOUT, type CockpitLayout, type SurfaceId } from "./layout";
import { saveLayout } from "./layoutPersistence";

const KEY = ["cockpit", "layout"] as const;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function read(): CockpitLayout {
  return queryClient.getQueryData<CockpitLayout>([...KEY]) ?? { ...DEFAULT_LAYOUT };
}

function write(next: CockpitLayout): void {
  queryClient.setQueryData<CockpitLayout>([...KEY], next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveLayout(next), 400);
}

/** Push an initial (persisted) layout into the store. Call once at mount. */
export function hydrateLayout(layout: CockpitLayout): void {
  queryClient.setQueryData<CockpitLayout>([...KEY], layout);
}

/** Non-hook read (for imperative callers). */
export function getLayout(): CockpitLayout {
  return read();
}

export function setRightPanelOpen(open: boolean): void {
  write({ ...read(), rightPanelOpen: open });
}

/** Open the right panel AND focus a surface (used by the "+"-menu / toggle). */
export function openSurface(id: SurfaceId): void {
  write({ ...read(), rightPanelOpen: true, activeSurface: id });
}

export function setActiveSurface(id: SurfaceId): void {
  write({ ...read(), activeSurface: id });
}

export function setSizes(sizes: [number, number]): void {
  write({ ...read(), sizes });
}

/** Reactive hook for the shell components. */
export function useCockpitLayout(): CockpitLayout {
  const { data = { ...DEFAULT_LAYOUT } } = useQuery<CockpitLayout>({
    queryKey: [...KEY],
    queryFn: () => read(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/cockpit/layoutStore.ts
git commit -m "✨ feat(cockpit): store React Query du layout (live + save debouncée)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Flag `ui.cockpit` + toggle Réglages

**Files:**
- Create: `src/features/cockpit/useCockpitFlag.ts`
- Modify: `src/features/settings/settings-extras.tsx` (ajout d'une ligne `CockpitRow` dans `InterfaceSettings`)

Le flag suit le pattern `chat.readTools` MAIS **défaut OFF** (nouvelle feature) : ON seulement si la valeur stockée est exactement `"true"`.

- [ ] **Step 1: Write the flag hook**

```ts
// src/features/cockpit/useCockpitFlag.ts
// Feature flag `ui.cockpit` (default OFF). Same db.settings + React Query
// pattern as the chat tool toggles, but ON only when the stored value is
// exactly "true" (a new feature defaults off).
import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";

export const COCKPIT_FLAG_KEY = "ui.cockpit";
const QK = ["settings", COCKPIT_FLAG_KEY] as const;

/** Reactive read (default OFF). */
export function useCockpitFlag(): boolean {
  const { data = false } = useQuery({
    queryKey: [...QK],
    queryFn: async () => (await db.settings.get(COCKPIT_FLAG_KEY)) === "true",
    staleTime: 30_000,
  });
  return data;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Add the Settings toggle row**

Dans `src/features/settings/settings-extras.tsx`, ajouter le composant `CockpitRow` à la fin du fichier (à côté de `ChatToolsRow`) :

```tsx
/**
 * Lot Cockpit-1 — toggle du flag `ui.cockpit` (défaut OFF).
 * Active la disposition « cockpit » (chat + IDE en surfaces) sur la vue Chat.
 * Pattern identique à ChatToolsRow MAIS défaut OFF : ON seulement si "true".
 */
function CockpitRow() {
  const [on, setOn] = useState(false); // défaut OFF (nouvelle feature)

  useEffect(() => {
    let alive = true;
    void db.settings.get("ui.cockpit").then((v) => {
      if (alive) setOn(v === "true"); // ON uniquement si "true"
    });
    return () => { alive = false; };
  }, []);

  const change = (v: boolean) => {
    setOn(v);
    void (async () => {
      await db.settings.set("ui.cockpit", v ? "true" : "false");
      await queryClient.invalidateQueries({ queryKey: ["settings", "ui.cockpit"] });
    })();
  };

  return (
    <SettingRow
      label="Cockpit (chat + IDE) — expérimental"
      desc="Affiche la vue Chat comme un cockpit : chat à gauche, éditeur/révision en panneau droit redimensionnable."
    >
      <Switch on={on} onChange={change} />
    </SettingRow>
  );
}
```

Puis le **monter** dans `InterfaceSettings`, juste après le bloc `<ChatToolsRow ... settingKey="chat.writeTools" .../>` (vers la ligne 387) :

```tsx
          <ChatToolsRow
            settingKey="chat.writeTools"
            label="Le chat peut modifier les fichiers"
            desc="Autorise le chat à écrire / éditer des fichiers. Chaque tour reste réversible via « Annuler les modifications de ce message »."
          />
          <CockpitRow />
```

- [ ] **Step 4: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/cockpit/useCockpitFlag.ts src/features/settings/settings-extras.tsx
git commit -m "✨ feat(cockpit): flag ui.cockpit + toggle Réglages (défaut OFF)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Surface Révision (placeholder) + SurfaceHost keep-warm

**Files:**
- Create: `src/features/cockpit/ReviewSurface.tsx`
- Create: `src/features/cockpit/SurfaceHost.tsx`

- [ ] **Step 1: Write ReviewSurface (placeholder for C2)**

```tsx
// src/features/cockpit/ReviewSurface.tsx
// Lot C1 placeholder. The real diff/review (portées, stage/revert, Cmd+clic
// → éditeur, survol + → commentaire) lands in Lot C2.
export function ReviewSurface() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 24,
        color: "var(--on-surface-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      Révision — le diff complet (portées, stage/revert, Cmd+clic → éditeur,
      survol + → commentaire à l'agent) arrive au Lot Cockpit-2.
    </div>
  );
}
```

- [ ] **Step 2: Write SurfaceHost (keep-warm mounting)**

`SurfaceHost` monte une surface **à sa première ouverture** puis la garde montée (visibilité togglée). Garder `CodeView` monté = `editorViewRef` toujours vivant. Les surfaces `comingSoon` affichent un état « bientôt ».

```tsx
// src/features/cockpit/SurfaceHost.tsx
// Hosts the right-panel surfaces with a keep-warm policy: each surface is
// mounted on first activation and then kept mounted (visibility toggled),
// never unmounted while the cockpit lives. Keeping CodeView mounted is what
// keeps editorViewRef alive outside /code.
import { useRef } from "react";
import { useShell } from "@/routes/shell-context";
import { CodeView } from "@/features/code/views-code";
import { ReviewSurface } from "./ReviewSurface";
import { SURFACE_META } from "./surfaces";
import type { SurfaceId } from "./layout";

function SurfaceFill({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: visible ? "block" : "none" }}>
      {children}
    </div>
  );
}

export function SurfaceHost({ active }: { active: SurfaceId }) {
  const shell = useShell();
  // Track which surfaces have been opened at least once (keep-warm set).
  const opened = useRef<Set<SurfaceId>>(new Set());
  opened.current.add(active);

  const has = (id: SurfaceId) => opened.current.has(id);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {has("editor") && (
        <SurfaceFill visible={active === "editor"}>
          <CodeView
            activeFile={shell.activeFile}
            openFiles={shell.openFiles}
            setOpenFiles={shell.setOpenFiles}
            setActiveFile={shell.setActiveFile}
            fileContents={shell.fileContents}
            setFileContents={shell.setFileContents}
            editorViewRef={shell.editorViewRef}
          />
        </SurfaceFill>
      )}
      {has("review") && (
        <SurfaceFill visible={active === "review"}>
          <ReviewSurface />
        </SurfaceFill>
      )}
      {/* comingSoon surfaces: a single shared "bientôt" panel when one is active. */}
      {SURFACE_META[active].comingSoon && (
        <SurfaceFill visible>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {SURFACE_META[active].label} — bientôt (Lot Cockpit-4).
          </div>
        </SurfaceFill>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS. (Si TS se plaint des props `any` de `CodeView`, c'est déjà le cas dans `code.tsx` — les mêmes props passent.)

- [ ] **Step 4: Commit**

```bash
git add src/features/cockpit/ReviewSurface.tsx src/features/cockpit/SurfaceHost.tsx
git commit -m "✨ feat(cockpit): SurfaceHost keep-warm + surface Révision (placeholder C2)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Panneau droit (`RightPanel.tsx`) — onglets + `+`-menu

**Files:**
- Create: `src/features/cockpit/RightPanel.tsx`

Barre d'onglets (surfaces déjà ouvertes) + bouton `+` ouvrant un menu de choix de surface + bouton fermer. Réutilise `<Icon/>`.

- [ ] **Step 1: Write the implementation**

```tsx
// src/features/cockpit/RightPanel.tsx
// Right-panel chrome: tab bar of opened surfaces + "+"-menu to pick a surface +
// close button. Hosts SurfaceHost. The chosen-surface menu mirrors Codex's
// "Ouvrir l'onglet du panneau latéral".
import { useState } from "react";
import { Icon } from "@/components/components";
import { SurfaceHost } from "./SurfaceHost";
import { SURFACE_MENU, surfaceLabel } from "./surfaces";
import { setActiveSurface, openSurface, setRightPanelOpen } from "./layoutStore";
import type { SurfaceId } from "./layout";

export function RightPanel({ active }: { active: SurfaceId }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="cockpit-right" style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        className="cockpit-right-tabs"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {/* Tabs for the two C1 surfaces (editor/review). */}
        {(["editor", "review"] as SurfaceId[]).map((id) => (
          <button
            key={id}
            className={"lgb lgb-sm" + (active === id ? " lgb-primary" : "")}
            onClick={() => setActiveSurface(id)}
          >
            {surfaceLabel(id)}
          </button>
        ))}

        {/* "+"-menu */}
        <span style={{ position: "relative" }}>
          <button className="lgb lgb-sm" title="Ajouter une surface" onClick={() => setMenuOpen((o) => !o)}>
            <Icon name="sparkle" size={11} /> +
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 9997 }} onClick={() => setMenuOpen(false)} />
              <div
                className="chat-ctx"
                style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 200, zIndex: 9998 }}
              >
                <div className="chat-ctx-target">Ouvrir une surface</div>
                {SURFACE_MENU.map((s) => (
                  <button
                    key={s.id}
                    className="chat-ctx-item"
                    disabled={s.comingSoon}
                    onClick={() => {
                      if (s.comingSoon) return;
                      openSurface(s.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="label">{s.label}</span>
                    {s.comingSoon && <span className="kbd">bientôt</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>

        <span style={{ flex: 1 }} />

        {/* Close (collapse) the right panel. */}
        <button className="lgb lgb-sm" title="Fermer le panneau" onClick={() => setRightPanelOpen(false)}>
          <Icon name="x" size={11} />
        </button>
      </div>

      <SurfaceHost active={active} />
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS. (Les classes CSS `lgb`, `chat-ctx`, `chat-ctx-item`, `kbd` existent déjà — réutilisées de RootLayout/DockToggleButton.)

- [ ] **Step 3: Commit**

```bash
git add src/features/cockpit/RightPanel.tsx
git commit -m "✨ feat(cockpit): panneau droit (onglets + menu de surface + fermer)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Le shell (`CockpitShell.tsx`) — chat | panneau redimensionnable

**Files:**
- Create: `src/features/cockpit/CockpitShell.tsx`

`PanelGroup` horizontal : chat (gauche) + panneau droit **collapsible gardé monté** (keep-warm). Le pilotage open/close passe par le store ; les tailles sont persistées via `onLayout`. Hydrate le store au montage.

- [ ] **Step 1: Write the implementation**

```tsx
// src/features/cockpit/CockpitShell.tsx
// The cockpit: chat (left) + a resizable, collapsible right panel (kept mounted
// for keep-warm). Mirrors the Dock's react-resizable-panels usage. The right
// Panel is `collapsible` and never unmounted, so the editor surface (and thus
// editorViewRef) stays alive while the panel is "closed".
import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { ChatView } from "@/features/chat/views-chat";
import { useShell } from "@/routes/shell-context";
import { RightPanel } from "./RightPanel";
import { useCockpitLayout, hydrateLayout, setRightPanelOpen, openSurface, setSizes } from "./layoutStore";
import { loadLayout } from "./layoutPersistence";

export function CockpitShell({ activeConv }: { activeConv: string }) {
  const shell = useShell();
  const layout = useCockpitLayout();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const hydrated = useRef(false);

  // Hydrate the store from SQLite once at mount (LOCAL-FIRST restore).
  useEffect(() => {
    let alive = true;
    void loadLayout().then((l) => {
      if (alive && !hydrated.current) {
        hydrated.current = true;
        hydrateLayout(l);
      }
    });
    return () => { alive = false; };
  }, []);

  // Drive the imperative collapse/expand from the store's rightPanelOpen.
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (layout.rightPanelOpen && p.isCollapsed()) p.expand();
    if (!layout.rightPanelOpen && !p.isCollapsed()) p.collapse();
  }, [layout.rightPanelOpen]);

  return (
    <div className="cockpit" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <PanelGroup
        direction="horizontal"
        style={{ flex: 1, minHeight: 0 }}
        onLayout={(sizes) => {
          // Persist only when the panel is expanded (two real sizes).
          if (sizes.length === 2 && sizes[1] > 1) setSizes([sizes[0], sizes[1]]);
        }}
      >
        <Panel id="cockpit-chat" order={1} minSize={30} defaultSize={layout.sizes[0]}>
          <div style={{ position: "relative", height: "100%" }}>
            <ChatView activeConv={activeConv} onOpenSnippet={shell.openSnippetInEditor} />
            {/* Floating "open panel" button when the right panel is collapsed. */}
            {!layout.rightPanelOpen && (
              <button
                className="lgb lgb-sm lgb-primary"
                title="Ouvrir le panneau (Éditeur / Révision)"
                style={{ position: "absolute", top: 10, right: 10, zIndex: 20 }}
                onClick={() => openSurface(layout.activeSurface)}
              >
                <Icon name="code" size={11} /> Panneau
              </button>
            )}
          </div>
        </Panel>

        <PanelResizeHandle className="dock-rrp-handle v" />

        <Panel
          id="cockpit-right"
          order={2}
          ref={panelRef}
          collapsible
          collapsedSize={0}
          minSize={20}
          defaultSize={layout.rightPanelOpen ? layout.sizes[1] : 0}
          onCollapse={() => setRightPanelOpen(false)}
          onExpand={() => setRightPanelOpen(true)}
        >
          <RightPanel active={layout.activeSurface} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS. (`ImperativePanelHandle`, `collapsible`, `collapsedSize`, `onCollapse`, `onExpand` font partie de `react-resizable-panels` ^2 — déjà utilisé par le Dock. La classe `dock-rrp-handle v` existe déjà.)

- [ ] **Step 3: Commit**

```bash
git add src/features/cockpit/CockpitShell.tsx
git commit -m "✨ feat(cockpit): shell chat | panneau droit redimensionnable (keep-warm)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Branchement dans `/chat` derrière le flag — VÉRIF EN VOYANT

**Files:**
- Modify: `src/routes/chat.tsx`

C'est la tranche payante : flag ON → la vue Chat devient le cockpit.

- [ ] **Step 1: Rewrite the chat route wrapper**

Remplacer **tout** le contenu de `src/routes/chat.tsx` par :

```tsx
// Lazy route module for /chat.
//
// Lot Cockpit-1 — quand le flag `ui.cockpit` est ON, cette route rend le
// CockpitShell (chat + IDE en surfaces) au lieu du ChatView simple. Flag OFF =
// comportement historique strictement inchangé (strangler-fig).
import { ChatView } from "@/features/chat/views-chat";
import { useActiveConv } from "@/features/chat/chat-sync";
import { useShell } from "@/routes/shell-context";
import { useCockpitFlag } from "@/features/cockpit/useCockpitFlag";
import { CockpitShell } from "@/features/cockpit/CockpitShell";

export default function ChatRouteComponent() {
  const [activeConv] = useActiveConv();
  const { openSnippetInEditor } = useShell();
  const cockpit = useCockpitFlag();

  if (cockpit) {
    return <CockpitShell activeConv={activeConv} />;
  }

  return <ChatView activeConv={activeConv} onOpenSnippet={openSnippetInEditor} />;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite (no regressions)**

Run: `pnpm test`
Expected: PASS — tous les tests existants verts + les 9 nouveaux (Tasks 1-2).

- [ ] **Step 4: Vérif EN VOYANT (gate d'acceptation — mémoire « user évalue en voyant »)**

Lancer l'app : `tauri-dev.cmd` (jamais `pnpm tauri dev` direct — cf. mémoire `tauri-dev-launcher`).

Vérifier, dans l'ordre :
1. **Flag OFF (défaut)** : la vue Chat est **identique à avant** (aucune régression). ✅
2. Aller dans **Réglages → Interface**, activer **« Cockpit (chat + IDE) — expérimental »**.
3. Cliquer l'entrée **Chat** du rail : la vue affiche le **cockpit** — chat plein cadre, un bouton **« Panneau »** en haut à droite.
4. Cliquer **« Panneau »** → le panneau droit s'ouvre sur l'**Éditeur** ; **glisser la poignée** redimensionne ; le bouton **`+`** ouvre le menu (Éditeur/Révision actifs, Terminal/Fichiers/Navigateur « bientôt ») ; l'onglet **Révision** montre le placeholder ; le **×** referme le panneau.
5. **Ouvrir un fichier** (depuis l'explorateur de la vue Code, puis revenir au cockpit) : il s'affiche dans la surface Éditeur du panneau, **éditable**.
6. **Persistance** : régler la taille + laisser le panneau ouvert, **recharger l'app** → la disposition est **restaurée** (taille + panneau ouvert + surface active).
7. `editorViewRef` vivant : avec le cockpit ouvert (sans être sur `/code`), l'éditeur répond (frappe, scroll). 

Si tout est vert visuellement, C1 est livré.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.tsx
git commit -m "✨ feat(cockpit): branche le cockpit dans /chat derrière ui.cockpit (Lot C1)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (couverture vs spec C1)

- **Chat central + panneau droit redimensionnable** → Tasks 7-8 (PanelGroup + RightPanel). ✅
- **Bouton panneau (ouvre/ferme)** → bouton « Panneau » (CockpitShell) + `×` (RightPanel). ✅
- **`+`-menu de surface** → Task 7. ✅
- **Surfaces Éditeur + Révision persistantes (keep-warm)** → Task 6 (SurfaceHost). ✅
- **`editorViewRef` toujours vivant** → CodeView monté en surface keep-warm (Task 6 + 9 step 4.7). ✅
- **État de layout = store TanStack (React Query) persisté SQLite** → Tasks 3-4. ✅
- **Migration derrière feature flag, destinations/`/code`/`/chat` intacts** → flag gate dans `/chat` (Task 9) ; aucune route touchée. ✅
- **Terminal / Fichiers / Navigateur** → listés « bientôt » (Lot C4), hors C1 par design. ✅ (YAGNI)

**Pas de placeholder de plan** : chaque step montre le code réel. **Cohérence de types** : `SurfaceId`/`CockpitLayout` définis en Task 1 et réutilisés tels quels partout ; fonctions du store (`openSurface`, `setActiveSurface`, `setRightPanelOpen`, `setSizes`, `useCockpitLayout`, `hydrateLayout`) définies en Task 4 et appelées en Tasks 7-8.

**Point à confirmer à l'exécution (non bloquant)** : noms d'icônes `<Icon name="code"|"git"|"sparkle"|"x" />` — tous déjà utilisés ailleurs dans le projet (Rail, content-head, DockToggleButton), donc sûrs.
