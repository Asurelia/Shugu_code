# Socle mémoire mascotte — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (ou subagent-driven-development) pour exécuter tâche par tâche. Étapes en cases `- [ ]`.

**Goal:** Doter la mascotte d'un état persistant — une table `mascot_memory` + accès TS + store TanStack avec broadcast cross-fenêtre + panneau « Ce que Shugu sait de toi » éditable.

**Architecture:** Migration SQLite côté Rust (`lib.rs`), CRUD côté TS via `db.ts` (pattern dominant de l'app), logique pure + broadcast Tauri-event isolés dans `mascotMemory.ts` (testable), hooks TanStack dans `mascotMemoryStore.ts`, UI dans `MascotMemoryPanel.tsx` montée sous la calibration mascotte existante.

**Tech Stack:** Tauri 2 · `@tauri-apps/plugin-sql` (sqlite) · React 18 · TanStack Query 5 · Vitest + happy-dom.

---

## Structure des fichiers

- `src-tauri/src/lib.rs` (modifier) — migration V15.
- `src/lib/db.ts` (modifier) — `MascotMemoryRow` + objet `mascotMemory` + export.
- `src/features/mascot/mascotMemory.ts` (créer) — types, validation pure, broadcast.
- `src/features/mascot/mascotMemory.test.ts` (créer) — tests de la logique pure.
- `src/features/mascot/mascotMemoryStore.ts` (créer) — hooks TanStack.
- `src/features/settings/MascotMemoryPanel.tsx` (créer) — UI.
- `src/features/settings/MascotCalibration.tsx` (modifier) — monte le panneau.

---

### Task 1 : Migration SQLite V15

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1 :** Après `const MIGRATION_V14` (≈ ligne 388), ajouter :

```rust
// V15 — mémoire persistante de la mascotte (socle « mascotte centrale »).
//
// Faits que Shugu retient de l'utilisateur. `source`='user' (saisi à la main,
// validated=1 d'office) vs 'extracted' (déduit par un futur extracteur LLM,
// validated=0 jusqu'à validation dans le panneau « Ce que Shugu sait de toi »).
const MIGRATION_V15: &str = "
CREATE TABLE IF NOT EXISTS mascot_memory (
  id         TEXT    PRIMARY KEY,
  category   TEXT    NOT NULL DEFAULT 'general',
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'user',
  confidence REAL    NOT NULL DEFAULT 1.0,
  validated  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mascot_memory_cat       ON mascot_memory(category);
CREATE INDEX IF NOT EXISTS idx_mascot_memory_validated ON mascot_memory(validated);
";
```

- [ ] **Step 2 :** Dans le `vec![...]` de migrations, après l'entrée `version: 14`, ajouter :

```rust
        Migration {
            version: 15,
            description: "mascot_memory",
            sql: MIGRATION_V15,
            kind: MigrationKind::Up,
        },
```

- [ ] **Step 3 :** Vérifier la compilation Rust (headless, vcvars) :

Run : `cmd /d /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" && cd src-tauri && cargo check'`
Expected : `Finished` sans erreur.

- [ ] **Step 4 :** Commit `✨ feat(mascot): migration V15 table mascot_memory`.

---

### Task 2 : Couche d'accès données (db.ts)

**Files:** Modify `src/lib/db.ts`

- [ ] **Step 1 :** Ajouter l'interface (section « Row interfaces ») :

```ts
export interface MascotMemoryRow {
  id: string;
  category: string;
  key: string;
  value: string;
  source: string;        // 'user' | 'extracted'
  confidence: number;
  validated: number;     // 0 | 1
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 2 :** Ajouter l'objet (près de `settings`/`reviews`) :

```ts
// ---------------------------------------------------------------------------
// mascotMemory  (V15 migration — faits appris sur l'utilisateur)
// ---------------------------------------------------------------------------

const mascotMemory = {
  async list(category?: string, validatedOnly = false): Promise<MascotMemoryRow[]> {
    const dbh = await getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (category) { args.push(category); where.push(`category = $${args.length}`); }
    if (validatedOnly) where.push("validated = 1");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return dbh.select(
      `SELECT * FROM mascot_memory ${clause} ORDER BY category, updated_at DESC`,
      args
    ) as Promise<MascotMemoryRow[]>;
  },

  async upsert(row: MascotMemoryRow): Promise<void> {
    const dbh = await getDb();
    await dbh.execute(
      `INSERT OR REPLACE INTO mascot_memory
         (id, category, key, value, source, confidence, validated, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.category, row.key, row.value, row.source,
       row.confidence, row.validated, row.created_at, row.updated_at]
    );
  },

  async remove(id: string): Promise<void> {
    const dbh = await getDb();
    await dbh.execute("DELETE FROM mascot_memory WHERE id = $1", [id]);
  },

  async setValidated(id: string, updatedAt: number): Promise<void> {
    const dbh = await getDb();
    await dbh.execute(
      "UPDATE mascot_memory SET validated = 1, confidence = 1.0, updated_at = $1 WHERE id = $2",
      [updatedAt, id]
    );
  },
};
```

- [ ] **Step 3 :** Ajouter `mascotMemory,` dans `export const db = { … }`.

- [ ] **Step 4 :** `pnpm typecheck` → PASS. Commit `✨ feat(mascot): accès db.ts mascot_memory`.

---

### Task 3 : Logique pure + broadcast (TDD)

**Files:** Create `src/features/mascot/mascotMemory.ts`, `src/features/mascot/mascotMemory.test.ts`

- [ ] **Step 1 — test d'abord** (`mascotMemory.test.ts`) :

```ts
import { describe, it, expect } from "vitest";
import { normalizeCategory, coerceFactInput } from "./mascotMemory";

describe("normalizeCategory", () => {
  it("garde une catégorie connue", () => {
    expect(normalizeCategory("tech")).toBe("tech");
  });
  it("retombe sur general si inconnue/absente", () => {
    expect(normalizeCategory("zzz")).toBe("general");
    expect(normalizeCategory(undefined)).toBe("general");
    expect(normalizeCategory(null)).toBe("general");
  });
});

describe("coerceFactInput", () => {
  it("rejette une clé vide", () => {
    expect(coerceFactInput({ key: "  ", value: "x" }).ok).toBe(false);
  });
  it("rejette une valeur vide", () => {
    expect(coerceFactInput({ key: "x", value: "" }).ok).toBe(false);
  });
  it("trim + normalise une entrée valide", () => {
    expect(coerceFactInput({ category: "relation", key: " ton ", value: " taquin " }))
      .toEqual({ ok: true, value: { category: "relation", key: "ton", value: "taquin" } });
  });
  it("rabat une catégorie inconnue sur general", () => {
    const r = coerceFactInput({ category: "xxx", key: "a", value: "b" });
    expect(r.ok && r.value.category).toBe("general");
  });
});
```

- [ ] **Step 2 :** `pnpm test mascotMemory` → FAIL (module absent).

- [ ] **Step 3 — implémentation** (`mascotMemory.ts`) :

```ts
// Shugu Forge — socle mémoire mascotte : types, validation pure, broadcast.
//
// Le CRUD vit dans db.ts (pattern de l'app) ; ce module isole la logique PURE
// (testable sans Tauri) et le canal de diffusion cross-fenêtre (event Tauri,
// même patron que calibration.ts — le bus Tauri franchit les WebviewWindow).

export const MASCOT_CATEGORIES = ["tech", "relation", "habits", "shared", "general"] as const;
export type MascotCategory = (typeof MASCOT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<MascotCategory, string> = {
  tech: "Préférences techniques",
  relation: "Style relationnel",
  habits: "Habitudes de travail",
  shared: "Souvenirs partagés",
  general: "Divers",
};

export interface MascotFact {
  id: string;
  category: MascotCategory;
  key: string;
  value: string;
  source: "user" | "extracted";
  confidence: number;
  validated: boolean;
  createdAt: number;
  updatedAt: number;
}

export function normalizeCategory(c: string | undefined | null): MascotCategory {
  return (MASCOT_CATEGORIES as readonly string[]).includes(c ?? "")
    ? (c as MascotCategory)
    : "general";
}

export type CoerceResult =
  | { ok: true; value: { category: MascotCategory; key: string; value: string } }
  | { ok: false; error: string };

export function coerceFactInput(input: {
  category?: string; key?: string; value?: string;
}): CoerceResult {
  const key = (input.key ?? "").trim();
  const value = (input.value ?? "").trim();
  if (!key) return { ok: false, error: "La clé est obligatoire." };
  if (!value) return { ok: false, error: "La valeur est obligatoire." };
  if (key.length > 80) return { ok: false, error: "La clé est trop longue (80 max)." };
  if (value.length > 2000) return { ok: false, error: "La valeur est trop longue (2000 max)." };
  return { ok: true, value: { category: normalizeCategory(input.category), key, value } };
}

const MEMORY_EVENT = "mascot://memory-changed";

/** Diffuse un changement de mémoire à toutes les fenêtres (fire-and-forget). */
export function emitMemoryChanged(): void {
  void (async () => {
    try {
      const mod = await import("@tauri-apps/api/event");
      await mod.emit(MEMORY_EVENT, Date.now());
    } catch (err) {
      console.warn("[mascot-memory] emit failed:", err);
    }
  })();
}

/** S'abonne aux changements cross-fenêtre. Retourne un désabonnement. */
export function subscribeMemoryChanged(callback: () => void): () => void {
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const mod = await import("@tauri-apps/api/event");
      unlisten = await mod.listen(MEMORY_EVENT, () => callback());
    } catch (err) {
      console.warn("[mascot-memory] listen failed:", err);
    }
  })();
  return () => unlisten?.();
}
```

- [ ] **Step 4 :** `pnpm test mascotMemory` → PASS. Commit `✨ feat(mascot): logique mémoire + broadcast (testée)`.

---

### Task 4 : Store TanStack

**Files:** Create `src/features/mascot/mascotMemoryStore.ts`

- [ ] **Step 1 :** Écrire le store :

```ts
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db, type MascotMemoryRow } from "@/lib/db";
import {
  type MascotFact, type MascotCategory,
  normalizeCategory, emitMemoryChanged,
} from "./mascotMemory";

export const MASCOT_MEMORY_KEY = ["mascot", "memory"] as const;

function rowToFact(r: MascotMemoryRow): MascotFact {
  return {
    id: r.id,
    category: normalizeCategory(r.category),
    key: r.key,
    value: r.value,
    source: r.source === "extracted" ? "extracted" : "user",
    confidence: r.confidence,
    validated: r.validated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function useMascotMemory() {
  return useQuery({
    queryKey: MASCOT_MEMORY_KEY,
    queryFn: async () => (await db.mascotMemory.list()).map(rowToFact),
    staleTime: 10_000,
  });
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: MASCOT_MEMORY_KEY });
}

export interface UpsertFactArgs {
  id?: string;
  category: MascotCategory;
  key: string;
  value: string;
  source?: "user" | "extracted";
  confidence?: number;
  validated?: boolean;
}

export function useUpsertMascotFact() {
  return useMutation({
    mutationFn: async (args: UpsertFactArgs) => {
      const now = Date.now();
      const id = args.id ?? crypto.randomUUID();
      const existing = (await db.mascotMemory.list()).find((r) => r.id === id);
      await db.mascotMemory.upsert({
        id,
        category: args.category,
        key: args.key,
        value: args.value,
        source: args.source ?? "user",
        confidence: args.confidence ?? 1.0,
        validated: (args.validated ?? true) ? 1 : 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    },
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}

export function useDeleteMascotFact() {
  return useMutation({
    mutationFn: (id: string) => db.mascotMemory.remove(id),
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}

export function useValidateMascotFact() {
  return useMutation({
    mutationFn: (id: string) => db.mascotMemory.setValidated(id, Date.now()),
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}
```

- [ ] **Step 2 :** `pnpm typecheck` → PASS. Commit `✨ feat(mascot): store TanStack mémoire`.

---

### Task 5 : Panneau « Ce que Shugu sait de toi »

**Files:** Create `src/features/settings/MascotMemoryPanel.tsx`

- [ ] **Step 1 :** Écrire le composant (rend une `setting-section`, pas de shell propre) :

```tsx
// Shugu Forge — panneau « Ce que Shugu sait de toi » (socle mémoire mascotte).
// Garde-fou de transparence : tout fait est visible, éditable, supprimable.
// Au socle, les faits sont saisis À LA MAIN ; l'extracteur (lot Persona)
// ajoutera des faits proposés (validated=false) qu'on valide ici.

import React from "react";
import { SettingRow } from "@/features/code/views-code";
import {
  MASCOT_CATEGORIES, CATEGORY_LABELS, type MascotCategory,
  coerceFactInput, subscribeMemoryChanged,
} from "@/features/mascot/mascotMemory";
import {
  useMascotMemory, useUpsertMascotFact,
  useDeleteMascotFact, useValidateMascotFact, MASCOT_MEMORY_KEY,
} from "@/features/mascot/mascotMemoryStore";
import { queryClient } from "@/lib/queryClient";

export function MascotMemoryPanel() {
  const { data: facts = [] } = useMascotMemory();
  const upsert = useUpsertMascotFact();
  const del = useDeleteMascotFact();
  const validate = useValidateMascotFact();

  const [category, setCategory] = React.useState<MascotCategory>("tech");
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Cohérence cross-fenêtre : si une autre fenêtre modifie la mémoire,
  // on réinvalide la query locale (patron broadcast de calibration.ts).
  React.useEffect(() => subscribeMemoryChanged(() => {
    void queryClient.invalidateQueries({ queryKey: MASCOT_MEMORY_KEY });
  }), []);

  const add = () => {
    const r = coerceFactInput({ category, key, value });
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    upsert.mutate({ ...r.value, source: "user", validated: true });
    setKey(""); setValue("");
  };

  return (
    <div className="setting-section">
      <h3>Ce que Shugu sait de toi</h3>
      <p className="sub">
        Voici ce que la mascotte retient sur toi pour mieux t'accompagner. Tu peux tout
        corriger ou effacer — rien n'est caché. Les faits que Shugu déduira plus tard
        apparaîtront ici comme « proposés », à valider ou rejeter.
      </p>

      <SettingRow label="Ajouter un fait" desc="Catégorie, sujet, et ce que Shugu doit retenir.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="slider" value={category}
            onChange={(e) => setCategory(e.target.value as MascotCategory)}
            style={{ padding: "4px 6px" }}>
            {MASCOT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <input placeholder="sujet (ex. langage préféré)" value={key}
            onChange={(e) => setKey(e.target.value)}
            style={inputStyle(160)} />
          <input placeholder="valeur (ex. Rust + TS)" value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            style={inputStyle(220)} />
          <button className="lgb lgb-sm" onClick={add} disabled={upsert.isPending}>Ajouter</button>
        </div>
      </SettingRow>
      {error && <div className="sub" style={{ color: "var(--danger, #e88)", marginTop: 4 }}>{error}</div>}

      {facts.length === 0 ? (
        <div className="sub" style={{ marginTop: 12, fontStyle: "italic" }}>
          Shugu ne sait encore rien de toi. Ajoute un premier fait ci-dessus.
        </div>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {facts.map((f) => (
            <div key={f.id} className="setting-row" style={{ alignItems: "center", opacity: f.validated ? 1 : 0.7 }}>
              <div className="info">
                <div className="label">
                  {CATEGORY_LABELS[f.category]} · {f.key}
                  {!f.validated && <span className="chip tertiary" style={{ marginLeft: 6 }}>proposé</span>}
                </div>
                <div className="desc">{f.value}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {!f.validated && (
                  <button className="lgb lgb-sm" onClick={() => validate.mutate(f.id)}>Valider</button>
                )}
                <button className="lgb lgb-sm" onClick={() => del.mutate(f.id)}>Supprimer</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function inputStyle(width: number): React.CSSProperties {
  return {
    width, padding: "4px 8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 4, color: "inherit", fontSize: 12,
  };
}
```

- [ ] **Step 2 :** `pnpm typecheck` → PASS. Commit `✨ feat(mascot): panneau « Ce que Shugu sait de toi »`.

---

### Task 6 : Intégration dans les réglages mascotte

**Files:** Modify `src/features/settings/MascotCalibration.tsx`

- [ ] **Step 1 :** Importer en tête : `import { MascotMemoryPanel } from "./MascotMemoryPanel";`

- [ ] **Step 2 :** Dans le `return`, ajouter `<MascotMemoryPanel />` juste après le `</div>` fermant la `setting-section` de calibration, toujours à l'intérieur de `<div className="settings-inner">`.

- [ ] **Step 3 :** `pnpm typecheck` → PASS.

---

### Task 7 : Vérification finale

- [ ] `pnpm typecheck` → PASS.
- [ ] `pnpm test` → la suite passe (≥ les 425 existants + 6 nouveaux).
- [ ] `pnpm build` → build prod OK.
- [ ] `cargo check` (headless vcvars) → OK.
- [ ] **Smoke visible** (`tauri-dev.cmd`) : Réglages → Mascot → ajouter « langage préféré = Rust + TS », vérifier persistance après redémarrage, édition et suppression.
- [ ] Revue par un agent SANS contexte (reviewer-gpt / code-reviewer) ; corriger les findings.
- [ ] Commit final + merge sur `main` + cleanup branche.

---

## Self-review (couverture spec)

- Table `mascot_memory` (spec §6.2) → Task 1. ✓
- Commandes CRUD (spec §6.3, retenu TS) → Task 2. ✓
- Store + broadcast (spec §6.4) → Task 3 (broadcast) + Task 4 (hooks). ✓
- Panneau « Ce que Shugu sait » CRUD manuel (spec §6.5) → Task 5–6. ✓
- Critères d'acceptation (spec §6.6) → Task 7. ✓
- Transparence (validated/source, proposé) → schéma + panneau. ✓
- Pas de placeholder ; signatures cohérentes (`mascotMemory.list/upsert/remove/setValidated`, `useMascotMemory/useUpsert/useDelete/useValidate`).
