# Lot A — « ressenti Cursor » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rapprocher le chat Shugu du « ressenti Cursor » : contexte de code injecté automatiquement, chat capable de lire/écrire le workspace, et blocs de code appliquables en un clic (diff accept/reject).

**Architecture:** On câble des briques existantes. (1) `sendChatMessage` (chat-sync.ts) gagne une injection « contexte éditeur » à côté des @-mentions/RAG déjà là. (2) `chat_send` (Rust) gagne une boucle d'outils bornée réutilisant les helpers fs/grep + un sous-ensemble des outils agents ; le tour est réversible. (3) Un bouton « Appliquer » sur les blocs de code du chat réutilise le pipeline `applyCodeToFile → setApplyRequest → startApply` (diff pleine-page, zéro appel LLM).

**Tech Stack:** React 18 + TanStack Query, CodeMirror 6, Tauri 2 (Rust), vitest (TS), `cargo test` (Rust). Build: `pnpm typecheck`, `pnpm test`, `cargo check` headless via vcvars64.

**Spec:** `docs/superpowers/specs/2026-05-30-lot-a-ressenti-cursor-design.md`

---

## File Structure

**Nouveaux fichiers**
- `src/features/chat/editorContext.ts` — pur : `buildEditorContext()` → bloc markdown injectable (fichier actif + sélection).
- `src/features/chat/editorContext.test.ts` — tests purs.
- `src/features/chat/editorSelectionStore.ts` — publie/lit la sélection courante de l'éditeur (TanStack-cached), pour que le composer chat la connaisse même hors `/code`.
- `src/features/chat/codeBlockTarget.ts` — pur : `parseCodeBlockTarget()` extrait un chemin depuis l'entête/1ʳᵉ ligne d'un bloc.
- `src/features/chat/codeBlockTarget.test.ts` — tests purs.
- `src-tauri/src/commands/chat_tools.rs` — sous-ensemble d'outils chat (lecture+écriture) : renderer JSON filtré + dispatcher + journal d'annulation. Réutilise les helpers `fs`/`grep` et les builders multi-tour de `agents`.

**Fichiers modifiés**
- `src/features/chat/chat-sync.ts` — `sendChatMessage` : param `editorCtx` + injection ; passe les toggles d'outils à `chat_send` ; récupère + stocke le journal d'annulation du tour.
- `src/features/chat/ChatPanel.tsx` (+ `views-chat.tsx` si le composer y vit) — chip contexte retirable, bouton « Appliquer » sur les blocs, rendu des tool-calls, bouton « Annuler les modifications de ce message ».
- `src/features/code/CodeMirrorEditor.tsx` — publie la sélection courante vers `editorSelectionStore` (updateListener).
- `src-tauri/src/commands/chat.rs` — boucle d'outils dans `chat_send` (conditionnelle), emit `kind:"tool"`, renvoie le journal d'annulation.
- `src-tauri/src/commands/agents/runner.rs` + `agents/tools.rs` — extraire (pub(crate)) les builders `build_openai_messages`/`build_anthropic_native` + l'accumulateur, pour réutilisation par `chat_tools.rs` (mémoire « cleanup on replace » : pas de duplication).
- `src-tauri/src/lib.rs` — déclarer `mod chat_tools;` si besoin (sinon sous-module de chat).
- `src/features/settings/settings-extras.tsx` — 3 toggles : `chat.autoEditorContext`, `chat.readTools`, `chat.writeTools`.

---

## Phase 1 — Contexte auto (fichier actif + sélection)

### Task 1 : `buildEditorContext` (fonction pure)

**Files:**
- Create: `src/features/chat/editorContext.ts`
- Test: `src/features/chat/editorContext.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

```ts
// src/features/chat/editorContext.test.ts
import { describe, it, expect } from "vitest";
import { buildEditorContext } from "./editorContext";

describe("buildEditorContext", () => {
  it("renvoie '' sans fichier actif", () => {
    expect(buildEditorContext({ path: "", content: "" })).toBe("");
  });

  it("inclut le chemin + contenu du fichier actif", () => {
    const out = buildEditorContext({ path: "src/a.ts", content: "const x = 1;" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("Fichier ouvert");
  });

  it("inclut la sélection avec ses lignes quand présente", () => {
    const out = buildEditorContext({
      path: "src/a.ts",
      content: "a\nb\nc",
      selection: { text: "b", startLine: 2, endLine: 2 },
    });
    expect(out).toContain("Sélection");
    expect(out).toContain("L2");
    expect(out).toContain("b");
  });

  it("tronque un fichier au-delà du cap (24 KiB)", () => {
    const big = "x".repeat(30_000);
    const out = buildEditorContext({ path: "src/big.ts", content: big });
    expect(out).toContain("[tronqué]");
    expect(out.length).toBeLessThan(30_000 + 500);
  });

  it("omet le fichier actif s'il est dans skipPaths (déjà @-mentionné)", () => {
    const out = buildEditorContext(
      { path: "src/a.ts", content: "const x = 1;" },
      { skipPaths: ["src/a.ts"] },
    );
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run: `pnpm exec vitest run src/features/chat/editorContext.test.ts`
Expected: FAIL — `buildEditorContext is not a function` / module introuvable.

- [ ] **Step 3 : Implémenter le module**

```ts
// src/features/chat/editorContext.ts
// Shugu Forge — Lot A — contexte éditeur auto pour le chat.
//
// Construit un bloc markdown injectable (fichier actif + sélection) ajouté au
// dernier message user ENVOYÉ au modèle (jamais persisté), comme @-mentions/RAG
// dans chat-sync.ts. Pur (testable). Cap par fichier identique aux mentions.

const MAX_BYTES = 24_000;

export interface EditorContextInput {
  /** Chemin workspace-relatif du fichier de l'onglet actif ("" si aucun). */
  path: string;
  /** Contenu du fichier actif. */
  content: string;
  /** Sélection courante dans l'éditeur, si non vide. */
  selection?: { text: string; startLine: number; endLine: number };
}

export interface EditorContextOpts {
  /** Chemins déjà fournis ailleurs (@-mentions) — on ne réinjecte pas le fichier. */
  skipPaths?: string[];
}

function truncate(s: string): string {
  return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + "\n… [tronqué]" : s;
}

/** Bloc de contexte éditeur. "" si rien à injecter. */
export function buildEditorContext(
  input: EditorContextInput,
  opts: EditorContextOpts = {},
): string {
  const path = (input.path ?? "").trim();
  const skip = new Set(opts.skipPaths ?? []);
  const parts: string[] = [];

  // Sélection d'abord (plus prioritaire que le fichier entier).
  const sel = input.selection;
  if (sel && sel.text.trim()) {
    parts.push(
      `Sélection courante dans \`${path || "le fichier actif"}\` (L${sel.startLine}-${sel.endLine}) :\n\`\`\`\n${truncate(sel.text)}\n\`\`\``,
    );
  }

  // Fichier actif (sauf s'il est déjà @-mentionné).
  if (path && !skip.has(path) && (input.content ?? "").length > 0) {
    parts.push(`Fichier ouvert \`${path}\` :\n\`\`\`\n${truncate(input.content)}\n\`\`\``);
  }

  if (parts.length === 0) return "";
  return `Contexte de l'éditeur (l'utilisateur travaille dessus) :\n\n${parts.join("\n\n")}`;
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run: `pnpm exec vitest run src/features/chat/editorContext.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5 : Commit**

```bash
git add src/features/chat/editorContext.ts src/features/chat/editorContext.test.ts
git commit -m "✨ feat(chat): buildEditorContext — bloc de contexte éditeur (pur + tests)"
```

### Task 2 : Store de sélection éditeur

**Files:**
- Create: `src/features/chat/editorSelectionStore.ts`

Pas de test unitaire (thin wrapper TanStack, comme `chat-sync.ts` useActiveModel). Vérifié au typecheck + E2E.

- [ ] **Step 1 : Implémenter le store**

```ts
// src/features/chat/editorSelectionStore.ts
// Sélection courante de l'éditeur, publiée par CodeMirrorEditor et lue par le
// composer chat (même hors /code). TanStack-cached (pattern useActiveModel).
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export interface EditorSelection {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
}

const KEY = ["chat", "editorSelection"] as const;

/** Publie la sélection (null = aucune sélection non vide). Appelé par l'éditeur. */
export function setEditorSelection(sel: EditorSelection | null): void {
  queryClient.setQueryData<EditorSelection | null>(KEY, sel ?? null);
}

/** Lecture non-hook (pour le send path). */
export function getEditorSelection(): EditorSelection | null {
  return queryClient.getQueryData<EditorSelection | null>(KEY) ?? null;
}

/** Hook réactif (pour le chip du composer). */
export function useEditorSelection(): EditorSelection | null {
  const { data = null } = useQuery<EditorSelection | null>({
    queryKey: KEY,
    queryFn: () => getEditorSelection(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
```

- [ ] **Step 2 : Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS (pas de nouvelle erreur).

```bash
git add src/features/chat/editorSelectionStore.ts
git commit -m "✨ feat(chat): editorSelectionStore — sélection éditeur partagée"
```

### Task 3 : L'éditeur publie sa sélection

**Files:**
- Modify: `src/features/code/CodeMirrorEditor.tsx` (ajouter un `EditorView.updateListener`)

> Avant d'éditer : lire `CodeMirrorEditor.tsx` autour de la création des extensions
> (`EditorState.create({ extensions: [...] })`) et la prop du chemin de fichier
> (souvent `path`/`activeFile`). On branche un updateListener qui, sur changement
> de sélection, publie `{path, text, startLine, endLine}` ou `null` si vide.

- [ ] **Step 1 : Ajouter l'updateListener**

Dans la liste d'extensions de l'éditeur, ajouter :

```ts
import { EditorView } from "@codemirror/view";
import { setEditorSelection } from "@/features/chat/editorSelectionStore";
// `filePath` = la prop chemin du composant (adapter au nom réel).

EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.docChanged) return;
  const sel = u.state.selection.main;
  if (sel.empty) { setEditorSelection(null); return; }
  const startLine = u.state.doc.lineAt(sel.from).number;
  const endLine = u.state.doc.lineAt(sel.to).number;
  setEditorSelection({
    path: filePath ?? "",
    text: u.state.sliceDoc(sel.from, sel.to),
    startLine,
    endLine,
  });
}),
```

> Note : si l'éditeur est recréé par fichier (`key={activeFile}`), le listener
> est recréé aussi — OK. Au démontage on peut laisser la dernière sélection ;
> elle sera écrasée au prochain focus. Si tu veux la nettoyer, appelle
> `setEditorSelection(null)` dans le cleanup du `useEffect` de montage.

- [ ] **Step 2 : Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3 : Commit**

```bash
git add src/features/code/CodeMirrorEditor.tsx
git commit -m "✨ feat(code): l'éditeur publie sa sélection vers editorSelectionStore"
```

### Task 4 : Injecter le contexte dans `sendChatMessage`

**Files:**
- Modify: `src/features/chat/chat-sync.ts` (signature + injection)

- [ ] **Step 1 : Étendre la signature**

Dans `sendChatMessage(convId, text, modelId, imageDataUrl?, agentDefPath?)`, ajouter
un dernier paramètre optionnel :

```ts
export async function sendChatMessage(
  convId: string,
  text: string,
  modelId: string,
  imageDataUrl?: string,
  agentDefPath?: string,
  editorCtx?: { path: string; content: string; selection?: { text: string; startLine: number; endLine: number } },
): Promise<void> {
```

- [ ] **Step 2 : Injecter le contexte éditeur (avant les @-mentions)**

Repérer le bloc `// Lot 4 — @-mentions` (~chat-sync.ts:401). Juste AVANT, insérer :

```ts
  // Lot A — contexte éditeur auto. Injecté dans le dernier message user envoyé
  // au modèle (jamais persisté). On saute le fichier actif s'il est déjà
  // @-mentionné (dédoublonnage). Désactivable via settings (le composer ne
  // passe `editorCtx` que si le toggle est ON et le chip pas retiré).
  if (editorCtx) {
    const { buildEditorContext } = await import("./editorContext");
    const skipPaths = parseMentions(trimmed);
    const ectx = buildEditorContext(editorCtx, { skipPaths });
    if (ectx) {
      const lastUserIdx = apiMessages.map((m) => m.role).lastIndexOf("user");
      if (lastUserIdx >= 0) {
        apiMessages[lastUserIdx].content = `${ectx}\n\n---\n\n${apiMessages[lastUserIdx].content}`;
      }
    }
  }
```

- [ ] **Step 3 : Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add src/features/chat/chat-sync.ts
git commit -m "✨ feat(chat): sendChatMessage injecte le contexte éditeur (param editorCtx)"
```

### Task 5 : Composer — chip retirable + passage du contexte

**Files:**
- Modify: le composant composer du chat. Repérer l'appel `sendChatMessage(...)`
  (probablement `src/features/chat/ChatPanel.tsx` ou `views-chat.tsx`). Lire ce
  fichier d'abord pour trouver le handler d'envoi + d'où viennent `activeFile`
  et `fileContents` (ShellContext via `useShell()`).

- [ ] **Step 1 : Construire `editorCtx` à l'envoi**

Dans le composant composer, lire le toggle + le state :

```ts
import { useEditorSelection } from "./editorSelectionStore";
import { db } from "@/lib/db";
import { useState } from "react";
// activeFile + fileContents viennent du ShellContext (useShell()), déjà dispo
// dans ChatPanel (sinon les passer en props — cf. mémoire useShell-in-RootLayout).

const selection = useEditorSelection();
const [ctxDropped, setCtxDropped] = useState(false);

// À l'envoi (handler existant) :
let editorCtx: Parameters<typeof sendChatMessage>[5] | undefined;
const autoCtxOn = (await db.settings.get("chat.autoEditorContext")) !== "false"; // défaut ON
if (autoCtxOn && !ctxDropped && activeFile && fileContents[activeFile]) {
  const sel = selection && selection.path === activeFile && selection.text.trim()
    ? { text: selection.text, startLine: selection.startLine, endLine: selection.endLine }
    : undefined;
  editorCtx = { path: activeFile, content: fileContents[activeFile].text, selection: sel };
}
await sendChatMessage(convId, text, model, imageDataUrl, agentDefPath, editorCtx);
// reset pour le prochain tour
setCtxDropped(false);
```

- [ ] **Step 2 : Afficher le chip retirable au-dessus du champ**

```tsx
{autoCtxOn && !ctxDropped && activeFile && (
  <div className="chat-ctx-chip">
    <span>📄 {activeFile.split("/").pop()}</span>
    {selection?.path === activeFile && selection.text.trim() && (
      <span>⊿ sélection ({selection.endLine - selection.startLine + 1} l.)</span>
    )}
    <button title="Ne pas envoyer ce contexte" onClick={() => setCtxDropped(true)}>×</button>
  </div>
)}
```

> Style : réutiliser la charte (glass/Celestial Veil). Petit chip discret
> au-dessus du textarea. `autoCtxOn` peut être lu une fois via un petit
> `useQuery` sur `db.settings.get("chat.autoEditorContext")` pour la réactivité
> du chip (sinon recalculé à l'envoi).

- [ ] **Step 3 : Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "✨ feat(chat): chip contexte éditeur retirable + envoi auto du contexte"
```

### Task 6 : Toggle Settings `chat.autoEditorContext`

**Files:**
- Modify: `src/features/settings/settings-extras.tsx` (section interface/chat)

- [ ] **Step 1 : Ajouter le toggle**

Suivre le pattern d'un toggle existant de `settings-extras.tsx` (lecture/écriture
`db.settings`). Ajouter une ligne « Contexte auto du chat » liée à la clé
`chat.autoEditorContext` (défaut ON = la clé absente ou ≠ "false").

- [ ] **Step 2 : Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/features/settings/settings-extras.tsx
git commit -m "✨ feat(settings): toggle contexte auto du chat"
```

---

## Phase 2 — Apply-from-chat (bouton « Appliquer » sur les blocs de code)

> Pipeline réutilisé (confirmé) : `applyCodeToFile(path, text, lang)` (RootLayout)
> ouvre+active le fichier puis pose une `ApplyRequest` via
> `applyController.setApplyRequest` (type `ai-edit/types.ts:ApplyRequest`).
> `useApplyRunner` (CodeView) lance ensuite `startApply(view, {path, proposedText,
> lang, wasDirty})` → diff pleine-page accept/reject, **zéro appel LLM**.

### Task 7 : `parseCodeBlockTarget` (fonction pure)

**Files:**
- Create: `src/features/chat/codeBlockTarget.ts`
- Test: `src/features/chat/codeBlockTarget.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

```ts
// src/features/chat/codeBlockTarget.test.ts
import { describe, it, expect } from "vitest";
import { parseCodeBlockTarget } from "./codeBlockTarget";

describe("parseCodeBlockTarget", () => {
  it("extrait un chemin de l'info-string (```ts src/foo.ts)", () => {
    expect(parseCodeBlockTarget("ts src/foo.ts", "const x = 1;")).toBe("src/foo.ts");
  });
  it("extrait un chemin d'un commentaire en 1ʳᵉ ligne (// src/foo.ts)", () => {
    expect(parseCodeBlockTarget("ts", "// src/foo.ts\nconst x = 1;")).toBe("src/foo.ts");
  });
  it("supporte les commentaires # (Python/yaml)", () => {
    expect(parseCodeBlockTarget("python", "# app/main.py\nprint(1)")).toBe("app/main.py");
  });
  it("renvoie null sans indice de chemin", () => {
    expect(parseCodeBlockTarget("ts", "const x = 1;")).toBeNull();
  });
  it("ignore un faux positif (pas de slash ni extension)", () => {
    expect(parseCodeBlockTarget("ts hello", "const x = 1;")).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer (échec attendu)**

Run: `pnpm exec vitest run src/features/chat/codeBlockTarget.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

```ts
// src/features/chat/codeBlockTarget.ts
// Shugu Forge — Lot A — résolution de la cible d'apply d'un bloc de code.
// Cherche un chemin workspace-relatif : (1) dans l'info-string (```ts path),
// (2) sinon en 1ʳᵉ ligne de commentaire (// path | # path). null si aucun.

function looksLikePath(t: string): boolean {
  return t.includes("/") || /\.[A-Za-z0-9]+$/.test(t);
}

function pickPath(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  return t && looksLikePath(t) ? t : null;
}

/** `info` = texte après les ``` (ex "ts src/foo.ts") ; `body` = contenu du bloc. */
export function parseCodeBlockTarget(info: string, body: string): string | null {
  // (1) info-string : "lang path" → 2ᵉ token
  const infoParts = (info ?? "").trim().split(/\s+/);
  if (infoParts.length >= 2) {
    const fromInfo = pickPath(infoParts[infoParts.length - 1]);
    if (fromInfo) return fromInfo;
  }
  // (2) 1ʳᵉ ligne de commentaire
  const first = (body ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = first.match(/^(?:\/\/|#|--|<!--)\s*(.+?)(?:\s*-->)?$/);
  if (m) return pickPath(m[1]);
  return null;
}
```

- [ ] **Step 4 : Lancer (succès attendu)**

Run: `pnpm exec vitest run src/features/chat/codeBlockTarget.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5 : Commit**

```bash
git add src/features/chat/codeBlockTarget.ts src/features/chat/codeBlockTarget.test.ts
git commit -m "✨ feat(chat): parseCodeBlockTarget — cible d'apply d'un bloc (pur + tests)"
```

### Task 8 : Bouton « Appliquer » sur les blocs de code du chat

**Files:**
- Modify: le composant de rendu d'un bloc de code dans le chat. Lire d'abord
  `src/features/chat/ChatPanel.tsx` + `src/lib/markdown.ts` (`parseAiReply`) pour
  voir comment les blocs sont rendus aujourd'hui (bouton « Copier » / « Ouvrir
  dans l'éditeur »). Trouver comment `applyCodeToFile` est exposé (RootLayout) —
  probablement via un event `app://...` ou un prop ; suivre le même chemin que
  « Ouvrir dans l'éditeur ».

> ⚠ `parseAiReply` ne garde aujourd'hui que le 1ᵉ bloc (`Message.code` singleton).
> Pour appliquer N'IMPORTE quel bloc, le rendu doit parser tous les blocs du
> `body`. Étendre le rendu (au moment de l'affichage) pour exposer, par bloc,
> `{ info, lang, text }` — sans changer le schéma SQLite.

- [ ] **Step 1 : Ajouter l'action Apply**

Pour chaque bloc rendu, ajouter un bouton « Appliquer » qui :

```ts
import { parseCodeBlockTarget } from "@/features/chat/codeBlockTarget";
// `applyCodeToFile` : réutiliser le MÊME chemin que "Ouvrir dans l'éditeur"
// (event app:// ou helper RootLayout). activeFile via useShell().

function onApply(info: string, lang: string, code: string) {
  const target = parseCodeBlockTarget(info, code) ?? activeFile;
  if (!target) return; // pas de cible : rien à faire (bouton désactivé sinon)
  // strip d'un éventuel commentaire de chemin en 1ʳᵉ ligne avant apply
  const body = parseCodeBlockTarget(info, code) && !info.includes("/")
    ? code.replace(/^.*\r?\n/, "")   // retire la ligne "// path" injectée
    : code;
  applyCodeToFile(target, body, lang); // ouvre+active la cible → diff accept/reject
}
```

> Si `applyCodeToFile` n'est pas atteignable depuis ce composant, exposer un
> point d'entrée mince : un event `app://apply-code` émis ici et écouté dans
> RootLayout (qui appelle `openFile` + `setApplyRequest`). Suivre le pattern de
> `app://open-file` déjà utilisé pour « Ouvrir dans l'éditeur ».

- [ ] **Step 2 : Désactiver le bouton sans cible**

Si `parseCodeBlockTarget(...) === null && !activeFile`, désactiver « Appliquer »
avec un tooltip « Ouvre un fichier ou précise un chemin (```ts src/foo.ts) ».

- [ ] **Step 3 : Typecheck + vérif manuelle**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add -A
git commit -m "✨ feat(chat): bouton Appliquer sur les blocs de code (diff accept/reject)"
```

---

## Phase 3 — Outils fs au chat (lecture + écriture, réversible)

### Task 9 : Extraire les builders multi-tour réutilisables (Rust)

**Files:**
- Modify: `src-tauri/src/commands/agents/runner.rs` (rendre `build_openai_messages`
  / `build_anthropic_native` + `AgentMessage` accessibles `pub(crate)`), ou les
  déplacer dans un module partagé `agents/mod.rs` réexporté. `tools.rs` expose déjà
  `ToolCall`/`ToolCallAccumulator` en `pub(crate)`.

> Objectif : `chat_tools.rs` réutilise la traduction historique → format provider
> + l'accumulateur de tool-calls SANS dupliquer (mémoire « cleanup on replace »).
> Lire `runner.rs:90-228` (les builders) et décider : `pub(crate)` en place vs
> petit module `agents/wire.rs`. Le plus simple : passer les `fn` + l'enum en
> `pub(crate)` et les importer depuis `chat_tools.rs`.

- [ ] **Step 1 : Élargir la visibilité**

`pub(crate) enum AgentMessage`, `pub(crate) fn build_openai_messages`,
`pub(crate) fn build_anthropic_native`. (Pas de changement de logique.)

- [ ] **Step 2 : `cargo check` headless**

Run (cf. mémoire vcvars64) : `cmd /d /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" && cargo check --manifest-path src-tauri/Cargo.toml'`
Expected: PASS (warnings éventuels sur dead_code OK).

- [ ] **Step 3 : Commit**

```bash
git add src-tauri/src/commands/agents/runner.rs src-tauri/src/commands/agents/tools.rs
git commit -m "♻️ refactor(agents): expose les builders multi-tour pour réutilisation chat"
```

### Task 10 : Sous-ensemble d'outils chat + dispatcher + journal (Rust)

**Files:**
- Create: `src-tauri/src/commands/chat_tools.rs`
- Modify: `src-tauri/src/commands/mod.rs` (ajouter `pub mod chat_tools;`)

- [ ] **Step 1 : Test Rust (échec attendu)**

```rust
// en bas de chat_tools.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_read_only_excludes_writes() {
        let v = chat_tools_json_openai(false); // write_enabled = false
        let names: Vec<String> = v.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"fs_read_file".to_string()));
        assert!(names.contains(&"fs_search".to_string()));
        assert!(!names.contains(&"fs_write_file".to_string()));
        assert!(!names.contains(&"run_command".to_string()));
    }
    #[test]
    fn renderer_with_writes_includes_edit() {
        let v = chat_tools_json_openai(true);
        let names: Vec<String> = v.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"fs_write_file".to_string()));
        assert!(names.contains(&"fs_edit".to_string()));
        assert!(!names.contains(&"run_command".to_string()));
    }
}
```

- [ ] **Step 2 : Lancer (échec attendu)**

Run: `cmd /d /c 'call "...vcvars64.bat" && cargo test --manifest-path src-tauri/Cargo.toml chat_tools'`
Expected: FAIL (module/fn absents).

- [ ] **Step 3 : Implémenter `chat_tools.rs`**

Contenu (réutilise `agents::tools` pour les schémas + `fs`/`grep` pour l'exécution) :

```rust
//! Outils du CHAT : sous-ensemble lecture (+écriture si activée) des outils
//! agents, exécutés en boucle bornée par chat_send. Pas de run_command, pas
//! de skill_save. Écritures path-guardées (fs::safe_resolve_for_write) et
//! consignées dans un journal d'annulation renvoyé au front (réversibilité du
//! tour, esprit agent_reverse_patch mais sans Docker).

use std::path::Path;
use serde::Serialize;
use serde_json::{json, Value};

/// Une écriture du tour, pour l'annulation. `before = None` = fichier créé.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWriteRecord {
    pub path: String,
    pub before: Option<String>,
}

/// Schéma OpenAI des outils chat. `write_enabled` ajoute write/edit.
pub fn chat_tools_json_openai(write_enabled: bool) -> Value {
    json!(tool_defs(write_enabled).into_iter().map(|(n, d, p)| json!({
        "type": "function",
        "function": { "name": n, "description": d, "parameters": p }
    })).collect::<Vec<_>>())
}

/// Schéma Anthropic des outils chat.
pub fn chat_tools_json_anthropic(write_enabled: bool) -> Value {
    json!(tool_defs(write_enabled).into_iter().map(|(n, d, p)| json!({
        "name": n, "description": d, "input_schema": p
    })).collect::<Vec<_>>())
}

fn tool_defs(write_enabled: bool) -> Vec<(&'static str, &'static str, Value)> {
    let mut v = vec![
        ("fs_read_file", "Lit un fichier workspace-relatif (UTF-8, cap 32 KiB).",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})),
        ("fs_list_dir", "Liste les enfants directs d'un dossier workspace-relatif.",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})),
        ("fs_search", "Recherche ripgrep dans le workspace (cap 80).",
            json!({"type":"object","properties":{"query":{"type":"string"},"regex":{"type":"boolean"},"case_sensitive":{"type":"boolean"}},"required":["query"]})),
    ];
    if write_enabled {
        v.push(("fs_write_file", "Écrit (écrase) un fichier workspace-relatif. Crée les dossiers parents.",
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]})));
        v.push(("fs_edit", "Remplace un snippet exact et unique dans un fichier existant.",
            json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]})));
    }
    v
}

/// Exécute un tool-call chat. NE retourne jamais Err : échec → (texte, is_error).
/// Pousse un ChatWriteRecord dans `journal` AVANT toute écriture (réversibilité).
pub fn execute_chat_tool(
    name: &str,
    args: &Value,
    root: &Path,
    write_enabled: bool,
    journal: &mut Vec<ChatWriteRecord>,
) -> (String, bool) {
    match name {
        "fs_read_file" => string_or_err(
            crate::commands::fs::read_file_inner(root, getstr(args, "path"), Some(32 * 1024))),
        "fs_list_dir" => string_or_err(
            crate::commands::fs::list_dir_inner(root, args["path"].as_str().unwrap_or("."))),
        "fs_search" => {
            let opts = crate::commands::grep::GrepOpts {
                case_sensitive: args["case_sensitive"].as_bool().unwrap_or(false),
                regex: args["regex"].as_bool().unwrap_or(false),
                max_results: 80,
            };
            match crate::commands::grep::grep_inner(root, getstr(args, "query"), &opts) {
                Ok(ms) => (format!("{} match(es):\n{}", ms.len(),
                    ms.iter().map(|m| format!("{}:{}: {}", m.path, m.line, m.preview))
                        .collect::<Vec<_>>().join("\n")), false),
                Err(e) => (e, true),
            }
        }
        "fs_write_file" if write_enabled => {
            let path = getstr(args, "path");
            record_before(root, path, journal);
            match crate::commands::fs::write_file_inner(root, path, getstr(args, "content")) {
                Ok(n) => (format!("wrote {n} bytes to {path}"), false),
                Err(e) => (e, true),
            }
        }
        "fs_edit" if write_enabled => {
            let path = getstr(args, "path");
            let (old, new) = (getstr(args, "old_string"), getstr(args, "new_string"));
            match crate::commands::fs::read_file_inner(root, path, None) {
                Ok(content) => {
                    let count = content.matches(old).count();
                    if count == 0 { return (format!("old_string introuvable dans {path}"), true); }
                    if count > 1 { return (format!("old_string apparaît {count}× — ajoute du contexte"), true); }
                    record_before(root, path, journal);
                    let updated = content.replacen(old, new, 1);
                    match crate::commands::fs::write_file_inner(root, path, &updated) {
                        Ok(n) => (format!("edited {path} ({n} bytes)"), false),
                        Err(e) => (e, true),
                    }
                }
                Err(e) => (e, true),
            }
        }
        other => (format!("unknown or disabled tool: {other}"), true),
    }
}

fn getstr<'a>(args: &'a Value, k: &str) -> &'a str { args[k].as_str().unwrap_or("") }
fn string_or_err(r: Result<String, String>) -> (String, bool) {
    match r { Ok(s) => (s, false), Err(e) => (e, true) }
}
/// Capture le contenu actuel (ou None si absent) une seule fois par path.
fn record_before(root: &Path, path: &str, journal: &mut Vec<ChatWriteRecord>) {
    if journal.iter().any(|r| r.path == path) { return; }
    let before = crate::commands::fs::read_file_inner(root, path, None).ok();
    journal.push(ChatWriteRecord { path: path.to_string(), before });
}
```

> ⚠ Vérifier les signatures réelles de `fs::read_file_inner` / `write_file_inner`
> / `list_dir_inner` et `grep::grep_inner` / `GrepOpts` (déjà utilisées par
> `agents/tools.rs:432-515` — copier exactement la même forme d'appel). Si
> `safe_resolve_for_write` est implicite dans `write_file_inner`, parfait.

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run: `cmd /d /c 'call "...vcvars64.bat" && cargo test --manifest-path src-tauri/Cargo.toml chat_tools'`
Expected: PASS (2 tests).

- [ ] **Step 5 : Commit**

```bash
git add src-tauri/src/commands/chat_tools.rs src-tauri/src/commands/mod.rs
git commit -m "✨ feat(chat): outils fs chat (lecture+écriture) + journal d'annulation (Rust)"
```

### Task 11 : Boucle d'outils dans `chat_send` (Rust)

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`

> Lire `chat_send` (chat.rs:707-826) + `call_anthropic_structured` /
> `call_openai_compat_structured` (déjà capables de `with_tools` + `on_chunk`).
> Aujourd'hui le chat appelle ces helpers SANS tools. On ajoute une boucle quand
> les toggles sont ON et le protocole ∈ {anthropic, openai, custom}.

- [ ] **Step 1 : Nouveaux params `chat_send`**

Ajouter `read_tools: Option<bool>`, `write_tools: Option<bool>` (defaults true /
false côté Rust si absents — mais le front passe la vraie valeur). Le retour de
`chat_send` reste le texte ; on émet le journal via un event `chat://writes`
`{ conversationId, records }` à la fin (plus simple que changer le type de retour).

- [ ] **Step 2 : Boucle bornée**

Quand `read_tools` (et protocole compatible) : au lieu d'un appel unique,
boucler (max 8) en réutilisant `agents::runner::build_*` + `tools.rs`
accumulator + `chat_tools::{chat_tools_json_*, execute_chat_tool}`. À chaque
tool-call : emit `chat://delta {kind:"tool", chunk: "<libellé>"}` pour la
visibilité, exécuter, ré-injecter le résultat, reboucler. `allow_exec = false`
toujours. `write_enabled = write_tools`. À la fin, si `journal` non vide :
`app.emit("chat://writes", { conversationId, records: journal })`.

> Forme calquée sur `runner::tool_use_loop` (runner.rs:442-732) mais : émet sur
> `chat://delta`/`chat://writes` (pas `agent://lifecycle`), pas de persistance
> d'events, `workspace_root` = `runner::get_workspace_root(app)` (workspace réel).

- [ ] **Step 3 : `cargo check` + (si possible) `cargo test`**

Run: `cmd /d /c 'call "...vcvars64.bat" && cargo check --manifest-path src-tauri/Cargo.toml'`
Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add src-tauri/src/commands/chat.rs
git commit -m "✨ feat(chat): boucle d'outils fs dans chat_send (lecture+écriture, visible)"
```

### Task 12 : Front — passer les toggles + rendre tool-calls + bouton Annuler

**Files:**
- Modify: `src/features/chat/chat-sync.ts` (passer `readTools`/`writeTools` à
  `chat_send` ; écouter `chat://writes` pour stocker le journal sur le message).
- Modify: composer/ChatPanel (rendu des deltas `kind:"tool"` ; bouton « Annuler
  les modifications de ce message » quand un journal est attaché).
- Modify: `settings-extras.tsx` (toggles `chat.readTools` défaut ON,
  `chat.writeTools` défaut ON).

- [ ] **Step 1 : Passer les toggles dans l'invoke**

Dans `sendChatMessage`, avant l'invoke `chat_send`, lire :

```ts
const readTools = (await db.settings.get("chat.readTools")) !== "false";
const writeTools = (await db.settings.get("chat.writeTools")) !== "false";
// ... ajouter readTools, writeTools à l'objet passé à invoke("chat_send", {...})
```

- [ ] **Step 2 : Écouter `chat://writes` + attacher le journal**

Attacher (comme le listener `chat://delta` reasoning, chat-sync.ts:454-470) un
listener `chat://writes` filtré sur `convId` ; stocker `records` et, à la
persistance du message AI, le mémoriser (cache TanStack ou colonne — au plus
simple : un store `chatWritesByMessage`). Le bouton « Annuler » appelle un
nouvel invoke `chat_revert_writes(records)` (Task 13).

- [ ] **Step 3 : Rendu inline des tool-calls + toggles Settings**

Afficher chaque delta `kind:"tool"` comme une petite ligne d'activité. Ajouter
les 2 toggles dans settings-extras.

- [ ] **Step 4 : Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "✨ feat(chat): toggles outils + activité tool-calls + bouton Annuler"
```

### Task 13 : Commande Rust `chat_revert_writes`

**Files:**
- Modify: `src-tauri/src/commands/chat_tools.rs` (+ enregistrer dans `lib.rs` invoke_handler)

- [ ] **Step 1 : Implémenter**

```rust
#[tauri::command]
pub async fn chat_revert_writes(
    app: tauri::AppHandle,
    records: Vec<ChatWriteRecord>,
) -> Result<(), String> {
    let root = crate::commands::fs::restore_workspace_root(&app)
        .ok_or_else(|| "aucun projet ouvert".to_string())?;
    for r in records.iter().rev() {
        match &r.before {
            Some(content) => { crate::commands::fs::write_file_inner(&root, &r.path, content)?; }
            None => { let _ = crate::commands::fs::delete_inner(&root, &r.path); } // créé → supprimer
        }
    }
    Ok(())
}
```

> Vérifier le nom réel du helper de suppression (`fs::delete_inner` ou la commande
> `fs_delete` ; sinon `std::fs::remove_file` sur le path résolu via le même
> path-guard). Réutiliser `restore_workspace_root` (déjà utilisé par
> `agent_reverse_patch`, mod.rs:1011).

- [ ] **Step 2 : Enregistrer la commande**

Dans `lib.rs` invoke_handler, ajouter `commands::chat_tools::chat_revert_writes,`.

- [ ] **Step 3 : `cargo check` + commit**

Run: `cmd /d /c 'call "...vcvars64.bat" && cargo check --manifest-path src-tauri/Cargo.toml'`
Expected: PASS.

```bash
git add -A
git commit -m "✨ feat(chat): chat_revert_writes — annule les écritures d'un tour"
```

---

## Vérification finale (avant merge)

- [ ] **Gates verts**
  - `pnpm typecheck` → PASS
  - `pnpm test` → PASS (editorContext + codeBlockTarget + existants)
  - `cmd /d /c 'call "...vcvars64.bat" && cargo test --manifest-path src-tauri/Cargo.toml'` → PASS
- [ ] **Vérif en voyant** (lancer `tauri-dev.cmd`, mémoire « user évalue en voyant ») :
  1. Ouvrir un fichier, aller au chat, poser une question SANS @-mention → le
     modèle cite le bon fichier (contexte auto). Le chip s'affiche ; le retirer
     (×) → la réponse n'a plus le contexte.
  2. Sélectionner du code, demander « explique cette sélection » → le modèle ne
     voit que la sélection.
  3. Demander « lis src/lib/db.ts et résume » → activité « 🔍 a lu … » visible,
     réponse fondée sur le vrai fichier.
  4. Demander « ajoute un commentaire en tête de src/lib/diag.ts » → « ✏️ a écrit … »
     visible, le fichier change ; cliquer « Annuler les modifications de ce message »
     → le fichier revient à l'état d'avant.
  5. Demander un bloc de code avec entête ```ts src/foo.ts → bouton « Appliquer »
     → diff accept/reject sur le bon fichier ; accepter applique, rejeter restaure.
- [ ] **Revue par agent sans contexte** (mémoire « git auto-merge ») : lancer une
  revue par un agent frais (code-reviewer) sur le diff de la branche.
- [ ] **Merge** : si gates verts + revue OK → merge `feat/lot-a-ressenti-cursor-20260530`
  dans `main` + suppression de la branche (politique git auto-merge).

## Notes de risque (rappel spec)
- Sélection CodeMirror : nom réel de la prop chemin dans `CodeMirrorEditor.tsx`.
- Visibilité des builders Rust : `pub(crate)` vs module `agents/wire.rs`.
- `applyCodeToFile` atteignable depuis le composant de bloc (sinon event
  `app://apply-code` façon `app://open-file`).
- Helpers fs réels : copier la forme d'appel de `agents/tools.rs`.
- Journal d'annulation : `delete_inner` vs `fs_delete` pour les fichiers créés.
