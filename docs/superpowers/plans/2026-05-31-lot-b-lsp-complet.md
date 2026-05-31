# Lot B — LSP « niveau Cursor » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finir l'intégration LSP déjà ~75 % construite (« LOT 3 ») pour atteindre le niveau Cursor : résolution binaire fiable, navigation cross-fichier, découvrabilité (Ctrl+Clic / menu / palette), statut visible, sécurité HTML, et couverture langages.

**Architecture:** Le backend `lsp.rs` spawn déjà de vrais serveurs (framing Content-Length, lifecycle). `@codemirror/lsp-client` fournit déjà completion/hover/diagnostics/signatureHelp + keymaps F12/F2/Shift+F12/Shift+Alt+F via `languageServerExtensions()`. Ce plan ajoute les pièces manquantes autour de ce socle. **Contrainte clé : un seul `EditorView` vivant à la fois** (l'éditeur est monté `key={activeFile}`) → `displayFile` switche le fichier actif, et le rename cross-fichier écrit les fichiers fermés sur disque.

**Tech Stack:** Rust (tokio, which, percent-encoding) · TypeScript · CodeMirror 6 · `@codemirror/lsp-client@6.2.4` · `vscode-languageserver-protocol` (types, déjà transitif) · TanStack Query · DOMPurify · Vitest · `cargo test` (headless via vcvars64).

**Branche de travail:** `feat/lot-b-lsp-complet-20260531` (déjà créée depuis `main`, HEAD `2716c4e`).

**Ordre de build:** §1 (résolution + TS) → §5 (sanitize, couplée à §1) → §4 (statut) → §2 (workspace/nav) → §3 (gestes) → §6 (langages + outline).

---

## Conventions de commande (Windows)

- **TS/JS gates** : `pnpm typecheck`, `pnpm test` (depuis `F:\Dev\shugu_code`).
- **Rust gates** : headless via vcvars64. Ne PAS passer `--manifest-path` inline (bug de quoting connu).
  Créer le wrapper si absent puis l'appeler **sans argument inline** :
  ```
  cmd /d /c "call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cd /d F:\Dev\shugu_code\src-tauri && cargo test lsp -- --nocapture"
  ```
- **Smoke live** : par l'utilisateur (« en voyant »), via `tauri-dev.cmd` (jamais `pnpm tauri dev` direct).
- **pnpm only**, jamais npm.

---

## File Structure

**Rust (modifié)**
- `src-tauri/src/commands/lsp.rs` — `resolve_lsp_binary` : ajoute node_modules/.bin + langages go/c/cpp/java.

**TS — nouveaux fichiers**
- `src/features/code/lsp/uri.ts` — conversions URI↔path pures (extraites + testables).
- `src/features/code/lsp/lspStatusStore.ts` — store d'état observable (TanStack).
- `src/features/code/lsp/lspBridge.ts` — pont module-level (openFile + getViewForPath).
- `src/features/code/lsp/workspace.ts` — `ShuguWorkspace extends Workspace`.
- `src/features/code/lsp/clickToDefinition.ts` — extension Ctrl/Cmd+Clic.
- `src/features/code/lsp/rename.ts` — commande rename cross-fichier (disk-safe).
- `src/features/code/lsp/lspSymbols.ts` — mapping `DocumentSymbol[] → OutlineSymbol[]` (pur).
- `src/features/code/LspStatusIndicator.tsx` — composant statusbar.
- `src/features/code/LspContextMenu.tsx` — menu clic-droit LSP (réutilise CSS `.ctx-*`).

**TS — modifiés**
- `src/features/code/lsp/client.ts` — `workspace:` + `sanitizeHTML:` + maj `lspStatusStore` + `SUPPORTED_LANG_IDS` (go/c/cpp/java) + utilise `uri.ts`.
- `src/features/code/CodeMirrorEditor.tsx` — monte `clickToDefinition` + ouvre `LspContextMenu` + maj status.
- `src/lib/commands.ts` — commandes palette LSP (Go to def / type / impl, references, rename, format).
- `src/features/code/views-code.tsx` — `<LspStatusIndicator/>` dans la statusbar.
- `src/features/code/OutlinePanel.tsx` + `outline/queries.ts` — source `documentSymbol` avec fallback Lezer.
- `src/routes/RootLayout.tsx` — publie `openFile` + `getViewForPath` dans `lspBridge`.
- `package.json` — `dompurify` (3.x, types inclus).

---

# SECTION 1 — Résolution des binaires (node_modules/.bin + langages)

**But:** que `typescript-language-server` (présent dans `node_modules/.bin`, absent du PATH) soit résolu comme le fait VS Code/Cursor, et préparer go/c/cpp/java.

### Task 1.1 — Test : résolution node_modules/.bin prioritaire

**Files:**
- Modify: `src-tauri/src/commands/lsp.rs` (ajoute un module `#[cfg(test)]` en fin de fichier).

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter en fin de `src-tauri/src/commands/lsp.rs` :

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Crée un faux node_modules/.bin/<name>(.cmd) dans un tempdir et vérifie
    /// que resolve_lsp_binary le préfère au PATH système.
    #[test]
    fn resolves_from_node_modules_bin_first() {
        let tmp = std::env::temp_dir().join(format!("shugu_lsp_test_{}", std::process::id()));
        let bin_dir = tmp.join("node_modules").join(".bin");
        fs::create_dir_all(&bin_dir).unwrap();
        // Sur Windows le shim npm est un .cmd ; sur Unix c'est un exécutable.
        let bin_name = if cfg!(windows) {
            "typescript-language-server.cmd"
        } else {
            "typescript-language-server"
        };
        let bin_path = bin_dir.join(bin_name);
        fs::write(&bin_path, "echo stub").unwrap();

        let resolved = resolve_lsp_binary("typescript", &tmp);
        assert!(resolved.is_some(), "should resolve from node_modules/.bin");
        let (path, args) = resolved.unwrap();
        assert_eq!(path, bin_path, "should pick the workspace-local binary");
        assert_eq!(args, vec!["--stdio".to_string()]);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn returns_none_for_unknown_language() {
        let tmp = std::env::temp_dir();
        assert!(resolve_lsp_binary("cobol", &tmp).is_none());
    }
}
```

- [ ] **Step 2: Lancer le test, vérifier l'échec de compilation**

Run (wrapper vcvars64, voir Conventions) : `cargo test lsp::tests`
Expected: ÉCHEC compilation — `resolve_lsp_binary` prend 1 arg, le test en passe 2.

- [ ] **Step 3: Modifier `resolve_lsp_binary` pour accepter le workspace + chercher node_modules/.bin**

Remplacer la fonction existante (lignes ~188-202) par :

```rust
/// Résout le binaire LSP pour un langId. Cherche d'ABORD dans
/// `<workspace>/node_modules/.bin/` (toolchain fournie par le projet, comme
/// VS Code/Cursor), puis fallback `which::which` (PATH système). Retourne
/// (path, args) ou None si introuvable.
fn resolve_lsp_binary(lang_id: &str, workspace_root: &std::path::Path) -> Option<(PathBuf, Vec<String>)> {
    let (binary_name, args): (&str, Vec<&str>) = match lang_id {
        "typescript" | "javascript" => ("typescript-language-server", vec!["--stdio"]),
        "rust" => ("rust-analyzer", vec![]),
        "python" => ("pylsp", vec![]),
        "go" => ("gopls", vec![]),
        "c" | "cpp" => ("clangd", vec![]),
        "java" => ("jdtls", vec![]),
        _ => return None,
    };
    let args: Vec<String> = args.into_iter().map(String::from).collect();

    // 1) node_modules/.bin du workspace — sur Windows, le shim est un .cmd.
    let bin_dir = workspace_root.join("node_modules").join(".bin");
    let candidates: &[&str] = if cfg!(windows) {
        &[".cmd", ".CMD", ""]
    } else {
        &[""]
    };
    for ext in candidates {
        let candidate = bin_dir.join(format!("{binary_name}{ext}"));
        if candidate.is_file() {
            return Some((candidate, args));
        }
    }

    // 2) PATH système.
    let path = which::which(binary_name).ok()?;
    Some((path, args))
}
```

- [ ] **Step 4: Mettre à jour l'appelant `lsp_init`**

Dans `lsp_init` (ligne ~439), `workspace_root` est déjà calculé plus haut (ligne ~422). Remplacer :

```rust
    let (path, bin_args) = resolve_lsp_binary(&args.lang_id).ok_or_else(|| {
```
par :
```rust
    let (path, bin_args) = resolve_lsp_binary(&args.lang_id, &workspace_root).ok_or_else(|| {
```

- [ ] **Step 5: Lancer les tests, vérifier le succès**

Run : `cargo test lsp::tests`
Expected: PASS (2 tests).

- [ ] **Step 6: Vérifier que ça compile globalement**

Run : `cargo check`
Expected: pas d'erreur (warnings tolérés).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/lsp.rs
git commit -m "🔧 fix(lsp): résout les binaires depuis node_modules/.bin (TS) + ajoute go/c/cpp/java"
```

---

# SECTION 5 — Sanitisation HTML (DOMPurify) — couplée à §1

**But:** fermer la surface XSS (hover/diagnostics Markdown→HTML) maintenant que §1 peut exécuter un serveur fourni par le dépôt ouvert.

### Task 5.1 — Installer DOMPurify

**Files:**
- Modify: `package.json`.

- [ ] **Step 1: Installer la dépendance**

Run : `pnpm add dompurify`
(DOMPurify 3.x embarque ses types — NE PAS ajouter `@types/dompurify`.)

- [ ] **Step 2: Vérifier la version résolue**

Run : `pnpm why dompurify`
Expected: une version `3.x`. Noter la version dans le commit.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "📦 deps: dompurify 3.x (sanitize HTML hover/diagnostics LSP)"
```

### Task 5.2 — Test : le sanitizer neutralise le HTML dangereux

**Files:**
- Create: `src/features/code/lsp/sanitize.ts`
- Test: `src/features/code/lsp/sanitize.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

`src/features/code/lsp/sanitize.test.ts` :

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeLspHtml } from "./sanitize";

describe("sanitizeLspHtml", () => {
  it("strips <script> tags", () => {
    const out = sanitizeLspHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain("ok");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeLspHtml('<img src="x" onerror="alert(1)">');
    expect(out.toLowerCase()).not.toContain("onerror");
  });

  it("strips javascript: hrefs", () => {
    const out = sanitizeLspHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("keeps legitimate hover markup (code + safe link)", () => {
    const out = sanitizeLspHtml('<pre><code>fn main() {}</code></pre><a href="https://docs.rs">docs</a>');
    expect(out).toContain("fn main()");
    expect(out).toContain("https://docs.rs");
  });
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run : `pnpm test sanitize`
Expected: FAIL — `sanitizeLspHtml` introuvable.

- [ ] **Step 3: Implémenter**

`src/features/code/lsp/sanitize.ts` :

```typescript
// Shugu Forge — sanitizer pour le HTML rendu depuis le Markdown LSP (Lot B §5).
//
// Les hovers/diagnostics LSP arrivent en Markdown, rendu en HTML par
// @codemirror/lsp-client. Sans sanitize, un serveur LSP compromis (ou fourni
// par un dépôt hostile via node_modules/.bin) pourrait injecter du JS dans la
// webview. On passe cette fonction à LSPClient.sanitizeHTML.
import DOMPurify from "dompurify";

/** Assainit le HTML d'un hover/diagnostic LSP : pas de <script>, pas de
 *  handlers on*, pas d'href javascript:. Les liens https/file et le code
 *  restent intacts (utiles pour la doc). */
export function sanitizeLspHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false,
  });
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run : `pnpm test sanitize`
Expected: PASS (4 tests).

- [ ] **Step 5: Brancher dans le LSPClient**

Dans `src/features/code/lsp/client.ts`, importer en tête :
```typescript
import { sanitizeLspHtml } from "./sanitize";
```
Puis dans `doInit`, ajouter le champ à la config du `new LSPClient({...})` (là où le commentaire l.109-114 signale le trou) — remplacer le bloc commentaire + config par :

```typescript
  const client = new LSPClient({
    rootUri: workspaceUri,
    extensions: languageServerExtensions(),
    // Lot B §5 — sanitize le HTML des hovers/diagnostics (Markdown→HTML).
    // Ferme la surface XSS ouverte par §1 (serveur LSP potentiellement fourni
    // par le dépôt via node_modules/.bin).
    sanitizeHTML: sanitizeLspHtml,
  });
```

- [ ] **Step 6: Vérifier typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 7: Commit**

```bash
git add src/features/code/lsp/sanitize.ts src/features/code/lsp/sanitize.test.ts src/features/code/lsp/client.ts
git commit -m "🔒 fix(lsp): sanitize le HTML des hovers/diagnostics via DOMPurify"
```

---

# SECTION 4 — Statut LSP + onboarding

**But:** rendre l'état LSP visible (sortir du silence) — condition pour tout tester « en voyant ».

### Task 4.1 — Test : store d'état LSP (transitions)

**Files:**
- Create: `src/features/code/lsp/lspStatusStore.ts`
- Test: `src/features/code/lsp/lspStatusStore.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

`src/features/code/lsp/lspStatusStore.test.ts` :

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { setLspStatus, getLspStatus, getAllLspStatus, type LspStatus } from "./lspStatusStore";

describe("lspStatusStore", () => {
  beforeEach(() => {
    // reset connu : on remet tous les langs testés à "absent".
    setLspStatus("rust", "absent");
    setLspStatus("typescript", "absent");
  });

  it("defaults to absent for an unknown lang", () => {
    expect(getLspStatus("python")).toBe("absent");
  });

  it("stores and reads a status per language", () => {
    setLspStatus("rust", "ready");
    expect(getLspStatus("rust")).toBe("ready");
    expect(getLspStatus("typescript")).toBe("absent");
  });

  it("getAllLspStatus reflects the latest writes", () => {
    setLspStatus("rust", "starting");
    setLspStatus("typescript", "error");
    const all = getAllLspStatus();
    expect(all.rust).toBe("starting");
    expect(all.typescript).toBe("error");
  });
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run : `pnpm test lspStatusStore`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter le store**

`src/features/code/lsp/lspStatusStore.ts` :

```typescript
// Shugu Forge — état observable du LSP par langage (Lot B §4).
//
// Projection sérialisable de ce que client.ts sait déjà (les LSPClient
// eux-mêmes sont stateful → pas de useQuery dessus, cf. client.ts l.15-18 ;
// mais leur ÉTAT est un snapshot → TanStack approprié, cohérent avec
// editorSelectionStore). client.ts appelle setLspStatus à chaque transition.
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export type LspStatus =
  | "absent"   // pas de LSP pour cette langue, ou binaire non installé
  | "starting" // spawn + initialize en cours
  | "ready"    // serveur opérationnel
  | "error";   // crash / EOF / erreur de framing

const KEY = ["lsp", "status"] as const;

function readMap(): Record<string, LspStatus> {
  return queryClient.getQueryData<Record<string, LspStatus>>(KEY) ?? {};
}

/** Publie l'état d'un langage. Appelé par client.ts. */
export function setLspStatus(langId: string, status: LspStatus): void {
  const next = { ...readMap(), [langId]: status };
  queryClient.setQueryData<Record<string, LspStatus>>(KEY, next);
}

/** Lecture non-hook d'un langage (défaut "absent"). */
export function getLspStatus(langId: string): LspStatus {
  return readMap()[langId] ?? "absent";
}

/** Lecture non-hook de la map complète. */
export function getAllLspStatus(): Record<string, LspStatus> {
  return readMap();
}

/** Hook réactif pour un langage (utilisé par LspStatusIndicator). */
export function useLspStatus(langId: string | null): LspStatus {
  const { data = {} } = useQuery<Record<string, LspStatus>>({
    queryKey: KEY,
    queryFn: () => readMap(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (!langId) return "absent";
  return data[langId] ?? "absent";
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run : `pnpm test lspStatusStore`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/code/lsp/lspStatusStore.ts src/features/code/lsp/lspStatusStore.test.ts
git commit -m "✨ feat(lsp): store d'état observable par langage (absent/starting/ready/error)"
```

### Task 4.2 — Brancher les transitions dans client.ts

**Files:**
- Modify: `src/features/code/lsp/client.ts`

- [ ] **Step 1: Importer le store**

En tête de `client.ts` :
```typescript
import { setLspStatus } from "./lspStatusStore";
```

- [ ] **Step 2: Émettre "starting" au début de doInit**

Dans `doInit(langId)`, juste après l'entrée de fonction (avant `invoke("lsp_init", ...)`) :
```typescript
  setLspStatus(langId, "starting");
```

- [ ] **Step 3: Émettre "absent" quand l'init Rust échoue (binaire manquant)**

Dans le `catch` du `invoke("lsp_init", ...)` (le bloc qui `return null`), avant `return null` :
```typescript
    setLspStatus(langId, "absent");
```

- [ ] **Step 4: Émettre "ready" / "error" autour du connect**

Dans `doInit`, le bloc `try { client.connect(...); await client.initializing; ... }` :
- après `diag("lsp", \`${langId} ready ...\`)` ajouter : `setLspStatus(langId, "ready");`
- dans le `catch` (avant `return null`) ajouter : `setLspStatus(langId, "error");`

- [ ] **Step 5: Émettre "error" / "absent" dans clearClient (crash recovery)**

Dans `clearClient(langId, reason)`, après `clients.delete(langId);` :
```typescript
  setLspStatus(langId, "error");
```

- [ ] **Step 6: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 7: Commit**

```bash
git add src/features/code/lsp/client.ts
git commit -m "✨ feat(lsp): client.ts publie ses transitions d'état (starting/ready/error/absent)"
```

### Task 4.3 — Composant LspStatusIndicator + onboarding

**Files:**
- Create: `src/features/code/LspStatusIndicator.tsx`
- Modify: `src/features/code/views-code.tsx` (statusbar L151 & L218)

- [ ] **Step 1: Implémenter le composant**

`src/features/code/LspStatusIndicator.tsx` :

```tsx
// Shugu Forge — indicateur de statut LSP dans la statusbar (Lot B §4).
//
// Montre l'état du LSP pour le langage du fichier actif. Clic = aide install
// (toast avec la commande exacte). Aucune installation automatique : on montre,
// l'utilisateur décide (modèle de sûreté « empêcher l'irréparable »).
import { langFromPath } from "@/lib/fs";
import { isLspSupported } from "./lsp/client";
import { useLspStatus, type LspStatus } from "./lsp/lspStatusStore";
import { pushToast } from "@/components/toast";

// Commande d'installation par langage (affichée au clic quand "absent").
const INSTALL_HINT: Record<string, string> = {
  typescript: "pnpm add -D typescript-language-server",
  javascript: "pnpm add -D typescript-language-server",
  rust: "rustup component add rust-analyzer",
  python: "pip install python-lsp-server",
  go: "go install golang.org/x/tools/gopls@latest",
  c: "installer LLVM (clangd)",
  cpp: "installer LLVM (clangd)",
  java: "installer jdtls (Eclipse JDT Language Server)",
};

const LABEL: Record<LspStatus, (lang: string) => string> = {
  absent: (l) => `⚠ ${l} : non installé`,
  starting: (l) => `◐ ${l} : démarrage…`,
  ready: (l) => `● ${l} : prêt`,
  error: (l) => `✕ ${l} : erreur`,
};

const COLOR: Record<LspStatus, string> = {
  absent: "var(--on-surface-variant)",
  starting: "var(--warn)",
  ready: "var(--success)",
  error: "var(--error, #ff6a8a)",
};

export function LspStatusIndicator({ activeFile }: { activeFile: string | null }) {
  const langId = activeFile ? langFromPath(activeFile) : null;
  const status = useLspStatus(langId);

  // Pas de LSP pour cette langue (markdown, json…) → on n'affiche rien.
  if (!langId || !isLspSupported(langId)) return null;

  const onClick = () => {
    if (status === "absent") {
      const hint = INSTALL_HINT[langId] ?? "voir la doc du serveur LSP";
      pushToast(`Pour activer le LSP ${langId} : ${hint}`, "info", 8000);
    } else if (status === "error") {
      pushToast(`LSP ${langId} en erreur — rouvre le fichier pour relancer.`, "info", 6000);
    }
  };

  const clickable = status === "absent" || status === "error";

  return (
    <span
      className="item lsp-status"
      style={{ color: COLOR[status], cursor: clickable ? "pointer" : "default" }}
      onClick={clickable ? onClick : undefined}
      title={clickable ? "Cliquer pour l'aide d'installation / relance" : undefined}
    >
      {LABEL[status](langId)}
    </span>
  );
}
```

- [ ] **Step 2: Monter dans les deux statusbars de views-code.tsx**

Importer en tête de `views-code.tsx` :
```typescript
import { LspStatusIndicator } from "./LspStatusIndicator";
```
Dans la statusbar de la branche compare (≈ L151), après `<BranchSwitcherCompact />` :
```tsx
          <LspStatusIndicator activeFile={activeFile} />
```
Dans la statusbar de la branche éditeur normal (≈ L218), après `<span className="item branch">main</span>` (ou à côté du statut saved/unsaved) :
```tsx
          <LspStatusIndicator activeFile={activeFile} />
```

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 4: Commit**

```bash
git add src/features/code/LspStatusIndicator.tsx src/features/code/views-code.tsx
git commit -m "✨ feat(lsp): indicateur de statut LSP dans la statusbar + aide install"
```

- [ ] **Step 5: SMOKE LIVE (utilisateur)**

Lancer `tauri-dev.cmd`, ouvrir un `.rs` → l'indicateur passe `◐ démarrage…` puis `● rust : prêt`.
Ouvrir un `.py` (pylsp absent) → `⚠ python : non installé` (clic → toast install).

---

# SECTION 2 — ShuguWorkspace (navigation cross-fichier)

**But:** F12 / Ctrl+Clic / Shift+F12 / F2 qui pointent vers un AUTRE fichier doivent fonctionner.

### Task 2.1 — Extraire les conversions URI↔path (pures, testables)

**Files:**
- Create: `src/features/code/lsp/uri.ts`
- Test: `src/features/code/lsp/uri.test.ts`
- Modify: `src/features/code/lsp/client.ts` (réutiliser depuis uri.ts)

- [ ] **Step 1: Écrire le test qui échoue**

`src/features/code/lsp/uri.test.ts` :

```typescript
import { describe, it, expect } from "vitest";
import { fileUriForPath, relativePathFromUri } from "./uri";

describe("lsp uri conversions", () => {
  const ws = "file:///F:/Dev/shugu_code";

  it("builds a file URI from workspace + relative path", () => {
    expect(fileUriForPath(ws, "src/lib/fs.ts")).toBe("file:///F:/Dev/shugu_code/src/lib/fs.ts");
  });

  it("encodes spaces and accents in the relative path", () => {
    expect(fileUriForPath(ws, "src/Jean Côté.ts")).toBe(
      "file:///F:/Dev/shugu_code/src/Jean%20C%C3%B4t%C3%A9.ts",
    );
  });

  it("round-trips uri → relative path", () => {
    const uri = fileUriForPath(ws, "src/lib/fs.ts");
    expect(relativePathFromUri(ws, uri)).toBe("src/lib/fs.ts");
  });

  it("decodes percent-encoding on the way back", () => {
    const uri = fileUriForPath(ws, "src/Jean Côté.ts");
    expect(relativePathFromUri(ws, uri)).toBe("src/Jean Côté.ts");
  });

  it("returns null for a uri outside the workspace", () => {
    expect(relativePathFromUri(ws, "file:///C:/other/x.ts")).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run : `pnpm test lsp/uri`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter uri.ts**

`src/features/code/lsp/uri.ts` :

```typescript
// Shugu Forge — conversions URI ↔ path relatif pour le LSP (Lot B §2).
//
// Extraites de client.ts pour être testables et réutilisées par ShuguWorkspace
// (qui doit faire le chemin INVERSE : uri d'une définition → path à ouvrir).

/** workspaceUri (file:///F:/Dev/shugu_code) + path relatif → file URI complet.
 *  encodeURI préserve `/` (séparateur) et encode espaces/accents/?/# — requis
 *  car rust-analyzer/pylsp rejettent les URI non-RFC3986. */
export function fileUriForPath(workspaceUri: string, relativePath: string): string {
  const ws = workspaceUri.replace(/\/+$/, "");
  const rel = encodeURI(relativePath.replace(/^\/+/, ""));
  return `${ws}/${rel}`;
}

/** file URI → path relatif au workspace, ou null si l'URI est hors workspace.
 *  Inverse de fileUriForPath : strip le préfixe workspace, décode le %xx. */
export function relativePathFromUri(workspaceUri: string, uri: string): string | null {
  const ws = workspaceUri.replace(/\/+$/, "");
  if (!uri.startsWith(ws)) return null;
  let rest = uri.slice(ws.length).replace(/^\/+/, "");
  try {
    rest = decodeURI(rest);
  } catch {
    // URI malformée : on garde la version encodée plutôt que de throw.
  }
  return rest;
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run : `pnpm test lsp/uri`
Expected: PASS (5 tests).

- [ ] **Step 5: Réutiliser depuis client.ts (DRY)**

Dans `client.ts`, SUPPRIMER la fonction locale `fileUriForPath` (l.179-183) et l'importer depuis `./uri` à la place. Mettre à jour l'export : remplacer
```typescript
export function fileUriForPath(...) { ... }
```
par (en tête) :
```typescript
import { fileUriForPath } from "./uri";
```
et ré-exporter pour les call-sites existants (CodeMirrorEditor l.43 importe `fileUriForPath` depuis `./client`) :
```typescript
export { fileUriForPath } from "./uri";
```

- [ ] **Step 6: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur (CodeMirrorEditor importe toujours `fileUriForPath` depuis `./client`, ré-exporté).

- [ ] **Step 7: Commit**

```bash
git add src/features/code/lsp/uri.ts src/features/code/lsp/uri.test.ts src/features/code/lsp/client.ts
git commit -m "♻️ refactor(lsp): extrait uri.ts (fileUriForPath + relativePathFromUri inverse)"
```

### Task 2.2 — Pont lspBridge (openFile + getViewForPath)

**Files:**
- Create: `src/features/code/lsp/lspBridge.ts`
- Modify: `src/routes/RootLayout.tsx`

- [ ] **Step 1: Implémenter le bridge**

`src/features/code/lsp/lspBridge.ts` :

```typescript
// Shugu Forge — pont entre le LSPClient (singleton module-level, hors React)
// et la couche shell React (Lot B §2).
//
// ShuguWorkspace.displayFile doit OUVRIR un fichier (logique qui vit dans
// RootLayout.openFile) et récupérer l'EditorView du fichier actif. Le LSPClient
// ne peut pas recevoir de props React (c'est un singleton). RootLayout publie
// donc ces capacités ici au montage ; ShuguWorkspace les lit. Même pattern que
// editorSelectionStore (publication hors-React lue par un consommateur).
import type { EditorView } from "@codemirror/view";

export interface LspBridge {
  /** Ouvre (ou active) un fichier dans l'éditeur. Lit le disque si besoin. */
  openFile: (path: string) => Promise<void>;
  /** Retourne l'EditorView du fichier actif s'il correspond à `path`, sinon null.
   *  (Architecture mono-éditeur : un seul EditorView vivant = le fichier actif.) */
  getViewForPath: (path: string) => EditorView | null;
}

let bridge: LspBridge | null = null;

/** Publié par RootLayout au montage. */
export function setLspBridge(b: LspBridge): void {
  bridge = b;
}

export function getLspBridge(): LspBridge | null {
  return bridge;
}
```

- [ ] **Step 2: Publier depuis RootLayout**

Dans `RootLayout.tsx`, importer :
```typescript
import { setLspBridge } from "@/features/code/lsp/lspBridge";
```
Ajouter un `useEffect` (après la définition de `openFile`, ≈ après L822) :
```typescript
  // Lot B §2 — publie openFile + l'accès à l'EditorView actif au pont LSP,
  // pour que ShuguWorkspace.displayFile puisse naviguer cross-fichier.
  useEffect(() => {
    setLspBridge({
      openFile,
      getViewForPath: (path) => {
        const v = editorViewRef.current;
        if (!v) return null;
        return v.getPath() === path ? (v.getView() ?? null) : null;
      },
    });
  }, [openFile]);
```

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 4: Commit**

```bash
git add src/features/code/lsp/lspBridge.ts src/routes/RootLayout.tsx
git commit -m "✨ feat(lsp): pont lspBridge (openFile + getViewForPath) publié par RootLayout"
```

### Task 2.3 — ShuguWorkspace + branchement

**Files:**
- Create: `src/features/code/lsp/workspace.ts`
- Modify: `src/features/code/lsp/client.ts`

- [ ] **Step 1: Implémenter ShuguWorkspace**

`src/features/code/lsp/workspace.ts` :

```typescript
// Shugu Forge — Workspace LSP custom (Lot B §2).
//
// Le Workspace par défaut de @codemirror/lsp-client a displayFile()→null :
// "Aller à la définition" vers un AUTRE fichier ne fait rien. ShuguWorkspace
// branche displayFile sur lspBridge.openFile (le système d'onglets de Shugu).
//
// Contrainte : architecture mono-éditeur (un seul EditorView vivant = le
// fichier actif). displayFile ouvre donc le fichier (→ devient actif) puis
// attend que son EditorView soit monté.
import { Workspace, type WorkspaceFile } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { getLspBridge } from "./lspBridge";
import { relativePathFromUri } from "./uri";
import { diag } from "@/lib/diag";

export class ShuguWorkspace extends Workspace {
  // On délègue le suivi des fichiers ouverts au comportement par défaut via
  // openFile/closeFile hérités ; on ne surcharge QUE displayFile (navigation).
  files: WorkspaceFile[] = [];

  // Hérité : syncFiles, openFile, closeFile (suffisants pour le fichier actif).
  syncFiles() {
    return super.syncFiles();
  }
  openFile(uri: string, languageId: string, view: EditorView): void {
    super.openFile(uri, languageId, view);
  }
  closeFile(uri: string, view: EditorView): void {
    super.closeFile(uri, view);
  }

  /** Ouvre le fichier cible et retourne son EditorView une fois monté.
   *  rootUri = this.client config rootUri (workspaceUri). */
  async displayFile(uri: string): Promise<EditorView | null> {
    const bridge = getLspBridge();
    if (!bridge) {
      diag("lsp", "displayFile: no bridge (RootLayout not mounted?)");
      return null;
    }
    const rootUri = (this.client as unknown as { config?: { rootUri?: string } }).config?.rootUri
      ?? this.rootUriFallback();
    const relPath = rootUri ? relativePathFromUri(rootUri, uri) : null;
    if (!relPath) {
      diag("lsp", `displayFile: uri outside workspace: ${uri}`);
      return null;
    }
    await bridge.openFile(relPath);
    // Attendre que l'EditorView du fichier actif corresponde (poll borné).
    for (let i = 0; i < 50; i++) {
      const v = bridge.getViewForPath(relPath);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 40)); // ~2 s max
    }
    diag("lsp", `displayFile: view never appeared for ${relPath}`);
    return null;
  }

  // rootUri n'est pas exposé publiquement par LSPClient ; fallback défensif.
  private rootUriFallback(): string | null {
    return null;
  }
}
```

> Note d'implémentation : `LSPClient` n'expose pas publiquement `rootUri`. Pour
> fiabiliser `relativePathFromUri`, passer le `workspaceUri` au constructeur du
> Workspace plutôt que de le lire sur le client. Voir Step 2.

- [ ] **Step 2: Passer workspaceUri explicitement + brancher dans client.ts**

Modifier `ShuguWorkspace` pour recevoir `workspaceUri` (plus robuste que lire `client.config`) :

Remplacer le constructeur implicite — ajouter au début de la classe :
```typescript
  private readonly workspaceUri: string;
  constructor(client: ConstructorParameters<typeof Workspace>[0], workspaceUri: string) {
    super(client);
    this.workspaceUri = workspaceUri;
  }
```
Et dans `displayFile`, remplacer le bloc `rootUri` par :
```typescript
    const relPath = relativePathFromUri(this.workspaceUri, uri);
```
Supprimer `rootUriFallback`.

Dans `client.ts::doInit`, brancher le workspace sur le LSPClient. Modifier la création :
```typescript
  const client = new LSPClient({
    rootUri: workspaceUri,
    workspace: (c) => new ShuguWorkspace(c, workspaceUri),
    extensions: languageServerExtensions(),
    sanitizeHTML: sanitizeLspHtml,
  });
```
Et importer en tête de `client.ts` :
```typescript
import { ShuguWorkspace } from "./workspace";
```

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur. Si `ConstructorParameters<typeof Workspace>[0]` pose souci de typage, utiliser le type `LSPClient` importé et `constructor(client: LSPClient, workspaceUri: string)`.

- [ ] **Step 4: Commit**

```bash
git add src/features/code/lsp/workspace.ts src/features/code/lsp/client.ts
git commit -m "✨ feat(lsp): ShuguWorkspace.displayFile → navigation cross-fichier via lspBridge"
```

- [ ] **Step 5: SMOKE LIVE (utilisateur)**

Ouvrir un `.rs`, placer le curseur sur un symbole défini dans un AUTRE fichier, F12 →
l'onglet du fichier cible s'ouvre au bon endroit. (Idem pour Shift+F12 = panneau références.)

---

# SECTION 3 — Découvrabilité (Ctrl+Clic, menu clic-droit, palette)

### Task 3.1 — Ctrl/Cmd+Clic → Aller à la définition

**Files:**
- Create: `src/features/code/lsp/clickToDefinition.ts`
- Modify: `src/features/code/CodeMirrorEditor.tsx` (useEffect LSP, L516-541)

- [ ] **Step 1: Implémenter l'extension**

`src/features/code/lsp/clickToDefinition.ts` :

```typescript
// Shugu Forge — Ctrl/Cmd+Clic = Aller à la définition (Lot B §3a).
//
// Le geste n°1 de Cursor/VS Code. Monté dans le lspCompartment (donc actif
// seulement quand un LSP est attaché). Si Ctrl/Cmd est enfoncé au mousedown,
// on place le curseur sous la souris puis on lance jumpToDefinition.
import { EditorView } from "@codemirror/view";
import { jumpToDefinition } from "@codemirror/lsp-client";

export function clickToDefinition(): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      // Ctrl (Win/Linux) ou Cmd (Mac). Bouton gauche uniquement.
      if (event.button !== 0) return false;
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      view.dispatch({ selection: { anchor: pos } });
      // jumpToDefinition est async côté LSP ; on déclenche et on consomme
      // l'événement pour éviter une sélection de texte parasite.
      jumpToDefinition(view);
      event.preventDefault();
      return true;
    },
  });
}
```

- [ ] **Step 2: Monter dans le lspCompartment**

Dans `CodeMirrorEditor.tsx`, importer en tête :
```typescript
import { clickToDefinition } from "./lsp/clickToDefinition";
```
Dans le useEffect LSP (≈ L528), remplacer le reconfigure :
```typescript
        view.dispatch({
          effects: lspCompartment.reconfigure(result.client.plugin(fileUri, langId)),
        });
```
par :
```typescript
        view.dispatch({
          effects: lspCompartment.reconfigure([
            result.client.plugin(fileUri, langId),
            clickToDefinition(),
          ]),
        });
```

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 4: Commit**

```bash
git add src/features/code/lsp/clickToDefinition.ts src/features/code/CodeMirrorEditor.tsx
git commit -m "✨ feat(lsp): Ctrl/Cmd+Clic = Aller à la définition"
```

### Task 3.2 — Commandes palette LSP

**Files:**
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Importer les commandes LSP**

En tête de `commands.ts` :
```typescript
import {
  jumpToDefinition,
  jumpToTypeDefinition,
  jumpToImplementation,
  findReferences,
  renameSymbol,
  formatDocument,
} from "@codemirror/lsp-client";
import { LSPPlugin } from "@codemirror/lsp-client";
```

- [ ] **Step 2: Helper de garde (LSP attaché ?)**

Ajouter près de `aiEditTarget` (≈ L134) :
```typescript
// Lot B §3 — la view a-t-elle un plugin LSP attaché ? (sinon les commandes
// LSP ne doivent pas apparaître dans la palette sur un fichier sans serveur).
function lspView(ctx: CommandContext): EditorView | null {
  const view = ctx.editorViewRef?.current?.getView() ?? null;
  if (!view) return null;
  return LSPPlugin.get(view) ? view : null;
}
```

- [ ] **Step 3: Ajouter les commandes au tableau COMMANDS**

Ajouter (catégorie `Go`/`Edit`) dans le tableau `COMMANDS` :
```typescript
  {
    id: "lsp-go-to-definition",
    title: "Go to Definition",
    category: "Go",
    icon: "search",
    keybinding: ["F12"],
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) jumpToDefinition(v); },
  },
  {
    id: "lsp-go-to-type-definition",
    title: "Go to Type Definition",
    category: "Go",
    icon: "search",
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) jumpToTypeDefinition(v); },
  },
  {
    id: "lsp-go-to-implementation",
    title: "Go to Implementation",
    category: "Go",
    icon: "search",
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) jumpToImplementation(v); },
  },
  {
    id: "lsp-find-references",
    title: "Find All References",
    category: "Go",
    icon: "search",
    keybinding: ["Shift", "F12"],
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) findReferences(v); },
  },
  {
    id: "lsp-rename-symbol",
    title: "Rename Symbol",
    category: "Edit",
    icon: "sparkle",
    keybinding: ["F2"],
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) renameSymbol(v); },
  },
  {
    id: "lsp-format-document",
    title: "Format Document (LSP)",
    category: "Edit",
    icon: "sparkle",
    when: (ctx) => lspView(ctx) !== null,
    run: (ctx) => { const v = lspView(ctx); if (v) formatDocument(v); },
  },
```

> Note : `category: "Go"` est déjà dans le type `CommandCategory`. Le keybinding
> F12/Shift+F12/F2 est aussi bindé par `languageServerExtensions()` au niveau
> éditeur ; la palette les expose pour la découvrabilité (cherchables + libellés).

- [ ] **Step 4: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 5: Commit**

```bash
git add src/lib/commands.ts
git commit -m "✨ feat(lsp): commandes palette (definition/type/impl/references/rename/format)"
```

### Task 3.3 — Menu clic-droit LSP

**Files:**
- Create: `src/features/code/LspContextMenu.tsx`
- Modify: `src/features/code/CodeMirrorEditor.tsx`

- [ ] **Step 1: Implémenter le menu (réutilise les classes CSS .ctx-*)**

`src/features/code/LspContextMenu.tsx` :

```tsx
// Shugu Forge — menu clic-droit LSP dans l'éditeur (Lot B §3b).
//
// Le menu d'annotation générique (panels/ContextMenu.tsx) est volontairement
// exclu de .cm-editor (RootLayout onContext L108-115). On fournit donc un petit
// menu DÉDIÉ au LSP, ouvert par l'événement contextmenu de l'éditeur. Il
// réutilise les classes CSS existantes (.ctx-menu/.ctx-item/.ctx-section) pour
// rester cohérent visuellement, sans toucher le menu d'annotation.
import type { EditorView } from "@codemirror/view";
import {
  jumpToDefinition,
  jumpToTypeDefinition,
  jumpToImplementation,
  findReferences,
  renameSymbol,
  formatDocument,
} from "@codemirror/lsp-client";

export interface LspMenuState {
  x: number;
  y: number;
  view: EditorView;
}

interface Action {
  label: string;
  kbd?: string;
  run: (v: EditorView) => void;
}

const ACTIONS: Action[] = [
  { label: "Aller à la définition", kbd: "F12", run: jumpToDefinition },
  { label: "Aller au type", run: jumpToTypeDefinition },
  { label: "Aller à l'implémentation", run: jumpToImplementation },
  { label: "Rechercher les références", kbd: "⇧F12", run: findReferences },
  { label: "Renommer le symbole", kbd: "F2", run: renameSymbol },
  { label: "Formater le document", kbd: "⇧⌥F", run: formatDocument },
];

export function LspContextMenu({
  state,
  onClose,
}: {
  state: LspMenuState | null;
  onClose: () => void;
}) {
  if (!state) return null;
  const W = 240, H = 240;
  const left = Math.min(state.x, window.innerWidth - W - 8);
  const top = Math.min(state.y, window.innerHeight - H - 8);

  const onItem = (run: (v: EditorView) => void) => {
    run(state.view);
    onClose();
  };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div className="ctx-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
        <div className="ctx-section">Language Server</div>
        {ACTIONS.map((a) => (
          <button key={a.label} className="ctx-item" type="button" onClick={() => onItem(a.run)}>
            <span className="label">{a.label}</span>
            {a.kbd && <span className="kbd">{a.kbd}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Ouvrir le menu depuis l'éditeur (quand LSP attaché)**

Dans `CodeMirrorEditor.tsx` :
- Importer :
```typescript
import { LSPPlugin } from "@codemirror/lsp-client";
import { LspContextMenu, type LspMenuState } from "./LspContextMenu";
import { useState } from "react";
```
- Ajouter un état au composant (près des refs en tête de fonction) :
```typescript
  const [lspMenu, setLspMenu] = useState<LspMenuState | null>(null);
```
- Dans le useEffect qui crée la view (après `const view = new EditorView(...)`, avant le `return`), ajouter un handler contextmenu sur le DOM de l'éditeur :
```typescript
    const onCtx = (e: MouseEvent) => {
      if (!LSPPlugin.get(view)) return; // pas de LSP → menu natif
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
      setLspMenu({ x: e.clientX, y: e.clientY, view });
    };
    view.dom.addEventListener("contextmenu", onCtx);
```
- Dans la fonction de cleanup du useEffect (le `return () => {...}`), avant `view.destroy()` :
```typescript
      view.dom.removeEventListener("contextmenu", onCtx);
```
- Modifier le `return` JSX du composant (actuellement `return <div ref={hostRef} className="cm-host" />;`) :
```tsx
  return (
    <>
      <div ref={hostRef} className="cm-host" />
      <LspContextMenu state={lspMenu} onClose={() => setLspMenu(null)} />
    </>
  );
```

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur. (Si `useState`/`useMemo` etc. déjà importés depuis "react", fusionner les imports.)

- [ ] **Step 4: Commit**

```bash
git add src/features/code/LspContextMenu.tsx src/features/code/CodeMirrorEditor.tsx
git commit -m "✨ feat(lsp): menu clic-droit LSP dans l'éditeur (definition/refs/rename/format)"
```

- [ ] **Step 5: SMOKE LIVE (utilisateur)**

Ouvrir un `.rs`, clic-droit sur un symbole → le menu LSP apparaît ; « Aller à la définition »
fonctionne. Sur un `.md` (pas de LSP) → menu natif du navigateur (pas le menu LSP).

---

# SECTION 6 — Couverture langages + outline LSP

> Les langages go/c/cpp/java ont déjà été mappés Rust en §1 (Task 1.1) et seront
> ajoutés côté TS ici. L'outline `documentSymbol` est la grosse pièce de §6.

### Task 6.1 — Étendre SUPPORTED_LANG_IDS (TS) — synchro avec Rust

**Files:**
- Modify: `src/features/code/lsp/client.ts`

- [ ] **Step 1: Mettre à jour le Set**

Dans `client.ts`, remplacer (l.58) :
```typescript
const SUPPORTED_LANG_IDS = new Set(["typescript", "javascript", "rust", "python"]);
```
par :
```typescript
// DOIT rester synchrone avec resolve_lsp_binary (src-tauri/src/commands/lsp.rs).
const SUPPORTED_LANG_IDS = new Set([
  "typescript", "javascript", "rust", "python", "go", "c", "cpp", "java",
]);
```

- [ ] **Step 2: typecheck + commit**

Run : `pnpm typecheck` → pas d'erreur.
```bash
git add src/features/code/lsp/client.ts
git commit -m "✨ feat(lsp): SUPPORTED_LANG_IDS go/c/cpp/java (synchro avec resolve_lsp_binary)"
```

### Task 6.2 — Mapping documentSymbol → OutlineSymbol (pur, testable)

**Files:**
- Create: `src/features/code/lsp/lspSymbols.ts`
- Test: `src/features/code/lsp/lspSymbols.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

`src/features/code/lsp/lspSymbols.test.ts` :

```typescript
import { describe, it, expect } from "vitest";
import { lspSymbolsToOutline } from "./lspSymbols";

// LSP DocumentSymbol minimal (range/selectionRange en {line,character} 0-based).
function sym(name: string, kind: number, line: number, children?: any[]) {
  const pos = { line, character: 0 };
  const range = { start: pos, end: { line: line + 1, character: 0 } };
  return { name, kind, range, selectionRange: range, children };
}

// Convertit line 0-based → offset : ici on fournit un doc factice ligne→offset.
const lineToOffset = (line: number) => line * 100;

describe("lspSymbolsToOutline", () => {
  it("maps SymbolKind numbers to our kinds", () => {
    // 5=Class, 6=Method, 12=Function, 11=Interface
    const out = lspSymbolsToOutline(
      [sym("Foo", 5, 0, [sym("bar", 6, 1)])],
      lineToOffset,
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Foo");
    expect(out[0].kind).toBe("class");
    expect(out[0].children?.[0].kind).toBe("method");
    expect(out[0].children?.[0].name).toBe("bar");
  });

  it("computes from offset using the line→offset mapper", () => {
    const out = lspSymbolsToOutline([sym("f", 12, 3)], lineToOffset);
    expect(out[0].from).toBe(300);
    expect(out[0].kind).toBe("function");
  });

  it("falls back to 'variable' for unknown kinds", () => {
    const out = lspSymbolsToOutline([sym("x", 999, 0)], lineToOffset);
    expect(out[0].kind).toBe("variable");
  });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run : `pnpm test lspSymbols`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/features/code/lsp/lspSymbols.ts` :

```typescript
// Shugu Forge — mapping LSP DocumentSymbol → OutlineSymbol (Lot B §6b).
//
// textDocument/documentSymbol renvoie un arbre hiérarchique de symboles avec
// des SymbolKind numériques (LSP spec). On les convertit vers le type
// OutlineSymbol de l'app (déjà aligné sur LSP). Fonction PURE pour testabilité :
// la conversion ligne 0-based → offset document est injectée (lineToOffset).
import type { OutlineSymbol, SymbolKind } from "../outline/queries";

// LSP SymbolKind (1-based, spec) → notre SymbolKind. Les kinds non mappés
// tombent sur "variable" (neutre).
const KIND_MAP: Record<number, SymbolKind> = {
  5: "class",      // Class
  6: "method",     // Method
  9: "method",     // Constructor
  10: "enum",      // Enum
  11: "interface", // Interface
  12: "function",  // Function
  23: "class",     // Struct
  26: "type",      // TypeParameter
  8: "variable",   // Field
  13: "variable",  // Variable
  7: "variable",   // Property
};

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}

/** Convertit l'arbre LSP en arbre OutlineSymbol. `lineToOffset` mappe une
 *  ligne 0-based vers un offset absolu dans le document CodeMirror. */
export function lspSymbolsToOutline(
  symbols: LspDocumentSymbol[],
  lineToOffset: (line0: number) => number,
): OutlineSymbol[] {
  return symbols.map((s) => {
    const kind = KIND_MAP[s.kind] ?? "variable";
    const out: OutlineSymbol = {
      name: s.name,
      kind,
      from: lineToOffset(s.range.start.line),
      to: lineToOffset(s.range.end.line),
    };
    if (s.children && s.children.length > 0) {
      out.children = lspSymbolsToOutline(s.children, lineToOffset);
    }
    return out;
  });
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run : `pnpm test lspSymbols`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/code/lsp/lspSymbols.ts src/features/code/lsp/lspSymbols.test.ts
git commit -m "✨ feat(lsp): mapping documentSymbol → OutlineSymbol (pur, testé)"
```

### Task 6.3 — Outline : source LSP avec fallback Lezer

**Files:**
- Modify: `src/features/code/outline/queries.ts`
- Modify: `src/features/code/OutlinePanel.tsx`

- [ ] **Step 1: Ajouter une requête documentSymbol dans queries.ts**

Dans `outline/queries.ts`, ajouter une fonction qui tente le LSP et retombe sur Lezer.
Importer en tête :
```typescript
import { getLspClient, isLspSupported, fileUriForPath } from "../lsp/client";
import { lspSymbolsToOutline } from "../lsp/lspSymbols";
import type { EditorState } from "@codemirror/state";
import { langFromPath } from "@/lib/fs";
```
Ajouter la fonction :
```typescript
/** Tente textDocument/documentSymbol via le LSP ; retombe sur Lezer si pas de
 *  LSP prêt pour la langue. `state` sert au fallback Lezer ET au mapping
 *  ligne→offset (state.doc.line(n).from). */
export async function fetchOutlineSymbols(
  filePath: string,
  state: EditorState,
): Promise<OutlineSymbol[]> {
  const langId = langFromPath(filePath);
  if (isLspSupported(langId)) {
    try {
      const res = await getLspClient(langId);
      if (res) {
        const uri = fileUriForPath(res.workspaceUri, filePath);
        const symbols = await res.client.request<
          { textDocument: { uri: string } },
          unknown
        >("textDocument/documentSymbol", { textDocument: { uri } });
        if (Array.isArray(symbols) && symbols.length > 0 && "range" in (symbols[0] as object)) {
          // DocumentSymbol[] (hiérarchique). lineToOffset via le doc courant.
          const lineToOffset = (line0: number) => {
            const lineNo = Math.min(line0 + 1, state.doc.lines); // 1-based, borné
            return state.doc.line(lineNo).from;
          };
          return lspSymbolsToOutline(symbols as never[], lineToOffset);
        }
      }
    } catch {
      // LSP indispo / timeout / SymbolInformation[] non géré → fallback Lezer.
    }
  }
  return parseLezerSymbols(state);
}
```

- [ ] **Step 2: Brancher le hook useOutline sur la version async**

Toujours dans `queries.ts`, modifier `useOutline` pour utiliser `fetchOutlineSymbols` :
```typescript
export function useOutline(
  filePath: string | null,
  docVersion: number,
  state: EditorState | null,
): UseQueryResult<OutlineSymbol[]> {
  return useQuery({
    queryKey: outlineKeys.forFile(filePath ?? "", docVersion),
    queryFn: async () => {
      if (!state || !filePath) return [];
      return fetchOutlineSymbols(filePath, state);
    },
    enabled: !!filePath && !!state,
    staleTime: Infinity,
  });
}
```

> `OutlinePanel.tsx` n'a PAS besoin de changer : il consomme déjà `useOutline`
> et `OutlineSymbol` (interface inchangée). Le fallback garantit zéro régression
> quand le LSP est absent.

- [ ] **Step 3: typecheck**

Run : `pnpm typecheck`
Expected: pas d'erreur.

- [ ] **Step 4: Vérifier la non-régression Lezer (tests existants)**

Run : `pnpm test outline` (s'il existe des tests outline) puis `pnpm test`
Expected: tous les tests passent (le fallback préserve le comportement Lezer).

- [ ] **Step 5: Commit**

```bash
git add src/features/code/outline/queries.ts
git commit -m "✨ feat(lsp): outline via documentSymbol LSP avec fallback Lezer"
```

- [ ] **Step 6: SMOKE LIVE (utilisateur)**

Ouvrir un `.rs` → l'outline montre la hiérarchie rust-analyzer (struct › impl › fn).
Ouvrir un `.md` (pas de LSP) → l'outline Lezer (headings) inchangé.

---

# FINALISATION

### Task F.1 — Gates complets + revue

- [ ] **Step 1: Tous les gates**

```
pnpm typecheck
pnpm test
```
Puis Rust (wrapper vcvars64) : `cargo check` puis `cargo test lsp`.
Expected: tout vert.

- [ ] **Step 2: Revue par agent SANS contexte (anti-biais)**

Dispatcher un agent `Explore`/`code-reviewer` frais sur le diff `main..feat/lot-b-lsp-complet-20260531`
avec le spec en référence. Critère : couverture des 6 sections, pas de silent failure, dégradation
gracieuse sans LSP, synchro Rust/TS des langages.

- [ ] **Step 3: SMOKE LIVE complet (utilisateur)** — checklist :
  - Statusbar : `● rust : prêt` sur un `.rs`.
  - Diagnostics : une erreur Rust volontaire → squiggle rouge + lintGutter.
  - Hover : survol d'un symbole → tooltip typé (et SANS double-bulle).
  - Completion : taper → propositions sémantiques rust-analyzer.
  - F12 / Ctrl+Clic cross-fichier → saute au bon fichier.
  - Shift+F12 → panneau de références.
  - F2 → rename (même fichier au minimum).
  - Clic-droit → menu LSP ; palette (Ctrl+Shift+P) → commandes LSP cherchables.
  - `.py`/`.go` sans serveur → `⚠ non installé` (pas de crash).

- [ ] **Step 4: Auto-merge si vert** (mémoire `feedback_git_auto_merge`)

Après revue OK + gates verts + smoke live OK :
```bash
git switch main
git merge --no-ff feat/lot-b-lsp-complet-20260531 -m "🚀 Merge Lot B « LSP niveau Cursor » : nav cross-fichier, gestes, statut, sécurité, langages"
git branch -d feat/lot-b-lsp-complet-20260531
```

---

## Limites assumées (YAGNI / hors périmètre)

- **Rename cross-fichier sur fichiers FERMÉS** : `renameSymbol` (bundlé) applique les édits aux
  fichiers OUVERTS via leur EditorView. Avec l'architecture mono-éditeur, les fichiers fermés
  touchés par un rename ne reçoivent pas l'édit. Si le smoke live le révèle gênant, ajouter une
  Task : commande `shuguRename` qui lit/écrit les fichiers fermés sur disque (sorted desc),
  avec erreur visible par fichier (pas de partiel silencieux) + invalidation du file-tree.
  Le baseline garanti de ce lot est le rename **même-fichier**.
- **Java (jdtls)** : mappé mais best-effort (lanceur complexe : data dir + JVM args). S'il ne
  handshake pas, il tombe dans l'état `error` sans casser le reste.
- Pas de CodeLens, peek/inline definition, call hierarchy, semantic tokens, inlay hints.
- Pas d'installation automatique des serveurs LSP (on montre la commande).

---

## Self-review (couverture spec)

| Spec §  | Tasks | Couvert |
|---------|-------|---------|
| §1 résolution binaire | 1.1 | ✅ node_modules/.bin + go/c/cpp/java + tests |
| §2 ShuguWorkspace/nav | 2.1, 2.2, 2.3 | ✅ uri.ts + lspBridge + displayFile |
| §3 découvrabilité | 3.1, 3.2, 3.3 | ✅ Ctrl+Clic + palette + menu clic-droit |
| §4 statut + onboarding | 4.1, 4.2, 4.3 | ✅ store + transitions + indicateur + install hint |
| §5 sanitize HTML | 5.1, 5.2 | ✅ DOMPurify + tests + branché client.ts |
| §6 langages + outline | 6.1, 6.2, 6.3 | ✅ SUPPORTED_LANG_IDS + documentSymbol + fallback |

**Rename cross-fichier closed-files** : décrit dans "Limites assumées" comme follow-up conditionnel
(baseline = same-file). C'est une réduction consciente vs la lettre du spec §2, justifiée par la
contrainte mono-éditeur découverte au planning — à valider au smoke live.
