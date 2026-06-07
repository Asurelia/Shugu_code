# Lot B — LSP « niveau Cursor », fini & étendu — Design

> **Statut** : design validé (brainstorming) le 2026-05-31.
> **Périmètre choisi** : « Cœur Cursor + couverture langages ».
> **Nature** : ce lot **finit** une intégration LSP déjà ~75 % construite (estampillée
> « LOT 3 » dans le code), il ne la reconstruit pas.

---

## 1. Contexte vérifié (source primaire, pas inférence)

L'exploration du code réel établit que le LSP est déjà câblé de bout en bout :

- **Backend `src-tauri/src/commands/lsp.rs` (523 lignes, complet)** : spawn de vrais
  serveurs via `tokio::process::Command`, framing `Content-Length: N\r\n\r\n<JSON>`,
  lifecycle (idempotent `lsp_init`, `lsp_send`, `lsp_shutdown` graceful + force_kill
  après 500 ms), `kill_all` au `RunEvent::Exit`, gestion du préfixe Windows `\\?\`
  dans `path_to_file_uri`, wrapping `.cmd`/`.bat` via `cmd /d /c`.
- **Transport `src/features/code/lsp/transport.ts`** : adapter Tauri
  (`invoke('lsp_send')` + `listen('lsp://msg')`) filtré par `langId`.
- **Factory `src/features/code/lsp/client.ts`** : cache module-level d'un `LSPClient`
  par langue, dé-duplication des inits concurrents (`inProgressInits`), crash-recovery
  via `lsp://exited` / `lsp://error`, cleanup HMR.
- **Éditeur `src/features/code/CodeMirrorEditor.tsx`** : `lspCompartment` reconfiguré
  après `getLspClient()` async avec `client.plugin(fileUri, langId)`.
- **`@codemirror/lsp-client@6.2.4`** est installé. Sa fonction `languageServerExtensions()`
  (déjà passée au `LSPClient`) bundle automatiquement : `serverCompletion()`,
  `hoverTooltips()`, `signatureHelp()`, `serverDiagnostics()`, et un `keymap` liant
  **F12** (jumpToDefinition), **F2** (renameSymbol), **Shift+F12** (findReferences),
  **Shift+Alt+F** (formatDocument). Les commandes `jumpToTypeDefinition`,
  `jumpToImplementation`, `jumpToDeclaration` sont aussi exportées (non bindées par défaut).

### État machine vérifié (2026-05-31)

| Serveur | Sur le PATH système ? | Conséquence actuelle |
|---|---|---|
| `rust-analyzer` | ✅ `C:\Users\rafai\.cargo\bin` | LSP Rust devrait déjà fonctionner |
| `typescript-language-server` | ❌ PATH ; ✅ `node_modules/.bin` | **LSP TS/JS échoue en silence** (langage principal du repo !) |
| `pylsp`, `gopls`, `clangd`, `jdtls` | ❌ absents | pas de LSP pour ces langages |

### Les 6 trous qui empêchent le « niveau Cursor »

1. **Résolution binaire** : `which::which` ignore `node_modules/.bin` → TS introuvable.
2. **Navigation cross-fichier morte** : le `Workspace` par défaut a `displayFile() → null`
   → F12/F2/rename vers un *autre* fichier ne fait rien.
3. **Aucune découvrabilité** : pas de Ctrl+Clic, pas de menu clic-droit, pas d'entrées palette.
4. **Pas de statut ni d'onboarding** : binaire absent = silence total, invérifiable « en voyant ».
5. **Sécurité** : `sanitizeHTML` non passé → dette XSS (hover Markdown→HTML non assaini).
6. **Couverture langages** : seuls ts/js/rust/python mappés ; outline encore Lezer-only.

---

## 2. Architecture — 6 unités isolées

Chaque unité a un but unique, une interface définie, et est testable indépendamment.

### Section 1 — Résolution des binaires (bug bloquant)

**Fichier** : `src-tauri/src/commands/lsp.rs::resolve_lsp_binary` (modifié).

Nouvelle stratégie de résolution, dans l'ordre :
1. **`<workspace>/node_modules/.bin/<bin>`** (le `.cmd` sur Windows) — comportement
   VS Code/Cursor : un projet fournit sa propre toolchain.
2. **`which::which(<bin>)`** (PATH système) — fallback.

`resolve_lsp_binary` reçoit donc le `workspace_root` (déjà disponible dans `lsp_init`
via `Mutex<Option<PathBuf>>`). La signature passe de `fn(lang_id) -> Option<(PathBuf, Vec<String>)>`
à `fn(lang_id, workspace_root: &Path) -> Option<(PathBuf, Vec<String>)>`.

Table étendue (voir Section 6 pour go/c/cpp/java) :

| langId | binaire | args |
|---|---|---|
| typescript / javascript | `typescript-language-server` | `--stdio` |
| rust | `rust-analyzer` | — |
| python | `pylsp` | — |

`build_command` gère déjà le wrapping `.cmd` → compatible avec le shim npm de
`node_modules/.bin`.

**Tests** : `cargo test` unitaire sur la résolution (node_modules/.bin prioritaire,
fallback PATH, absent → None). Smoke live : ouvrir un `.ts` → diagnostics apparaissent.

---

### Section 2 — `Workspace` custom (navigation cross-fichier)

**Nouveaux fichiers** :
- `src/features/code/lsp/workspace.ts` — `class ShuguWorkspace extends Workspace`.
- `src/features/code/lsp/lspBridge.ts` — pont module-level pour exposer `openFile` +
  l'accès aux `EditorView` ouvertes au singleton LSP.

**Pourquoi un pont** : le `LSPClient` est un singleton module-level (un serveur par
langue, partagé entre onglets) — il ne peut pas recevoir de props React. `RootLayout`
publie `openFile` (et un getter de `EditorView` par path) dans `lspBridge` au montage ;
`ShuguWorkspace` les lit. Même pattern que `editorSelectionStore` (l'éditeur publie, un
consommateur hors-React lit), conforme à la mémoire `feedback_useshell_in_rootlayout`.

`ShuguWorkspace` implémente :
- **`displayFile(uri): Promise<EditorView | null>`** — convertit `uri → path relatif`
  (inverse de `fileUriForPath`), appelle `openFile(path)` via le bridge, attend que
  l'`EditorView` du fichier existe (poll court borné), la retourne. C'est ce qui fait
  *sauter* vers la définition / une référence dans un autre fichier.
- **`openFile`/`closeFile`/`syncFiles`** — gestion des fichiers ouverts (suivi `version`
  + `doc`), en s'appuyant sur les `EditorView` réelles.
- **`updateFile(uri, tr)`** — applique les édits LSP (ex. rename) aux fichiers **ouverts**
  via leur `EditorView`.
- **Rename sur fichiers fermés** : un `WorkspaceEdit` peut toucher des fichiers non ouverts.
  `updateFile` (ou un handler dédié) lit/écrit ces fichiers sur disque via les commandes fs
  existantes (`fsReadFile`/`fsWriteFile`), puis invalide le file-tree. **Pas de rename
  partiel silencieux** : si une écriture échoue, on remonte une erreur visible (toast).

Le `LSPClient` est créé avec `workspace: (client) => new ShuguWorkspace(client)` dans
`client.ts::doInit`.

**Tests** : Vitest sur `uri ↔ path` (round-trip, espaces/accents, préfixe Windows).
Smoke live : F12 sur un import → l'onglet du fichier cible s'ouvre au bon endroit.

---

### Section 3 — Découvrabilité (gestes Cursor)

**3a. Ctrl+Clic / Cmd+Clic → Aller à la définition.**
Nouvelle extension `src/features/code/lsp/clickToDefinition.ts` : un
`EditorView.domEventHandlers({ mousedown })` qui, si `Ctrl`/`Cmd` est pressé, place le
curseur sous la souris puis appelle `jumpToDefinition(view)`. Montée dans le `lspCompartment`
(donc seulement quand un LSP est attaché). ~25 lignes.

**3b. Menu clic-droit.**
Réutilise `src/features/panels/ContextMenu.tsx` (existant). Quand le curseur est sur du
code avec LSP attaché (`LSPPlugin.get(view) != null`), ajouter une section :
- Aller à la définition (F12)
- Aller au type / à l'implémentation
- Rechercher les références (Shift+F12)
- Renommer le symbole (F2)
- Formater le document (Shift+Alt+F)

Chaque entrée est **grisée** si `serverCapabilities` ne déclare pas la capacité, **absente**
si pas de LSP. Aucune option fantôme.

**3c. Palette de commandes.**
Ajout dans `src/lib/commands.ts` (catégorie `Go`/`Edit`) des mêmes actions. Pattern :
`run: (ctx) => jumpToDefinition(ctx.editorViewRef.current.view)`. Le `when:` vérifie que
la vue existe ET que `LSPPlugin.get(view) != null`, sinon la commande n'apparaît pas sur un
fichier sans serveur.

**Hors périmètre (limites assumées)** : pas de CodeLens, pas de « peek definition » inline.
Go-to (saut) + références (panneau) couvrent le besoin baseline.

**Tests** : smoke live (Ctrl+Clic saute ; clic-droit montre les bonnes entrées grisées/actives ;
palette trouve les commandes).

---

### Section 4 — Statut LSP + onboarding (sortir du silence)

**Nouveaux fichiers** :
- `src/features/code/lsp/lspStatusStore.ts` — store d'état observable (TanStack-cached,
  même pattern que `editorSelectionStore`).
- `src/features/code/LspStatusIndicator.tsx` — composant statusbar.

**4a. Indicateur** dans la statusbar (`views-code.tsx` L151 & L218, à côté de la branche git),
pour le langage du fichier actif :

| État | Affichage | Sens |
|---|---|---|
| pas de LSP pour ce langage | *(rien)* | markdown, json… — normal |
| binaire absent | `⚠ <serveur> non installé` (cliquable) | ouvre l'aide install |
| connexion en cours | `◐ <lang> : démarrage…` | spawn + initialize |
| prêt | `● <lang> : prêt` | opérationnel |
| crashé | `✕ <lang> : erreur` (cliquable → relance) | EOF/erreur, retry |

**4b. Source d'état.** `client.ts` met à jour `lspStatusStore` à chaque transition
(init → ready → exited/error). **Aucune nouvelle source de vérité** : c'est une projection
sérialisable de ce que `client.ts` sait déjà. Justification du store séparé : les `LSPClient`
sont stateful (pas de `useQuery` dessus, cf. client.ts l.15-18), mais l'**état** est un
snapshot → TanStack approprié (conforme `feedback_tanstack_mandatory`).

**4c. Aide à l'installation.** Clic sur l'avertissement → panneau (réutilise dialog/toast
existant) affichant la commande exacte par langage. **Aucune installation automatique** —
on montre, l'utilisateur décide (cohérent avec le modèle de sûreté « empêcher l'irréparable »).

Commandes affichées :
- TS/JS : `pnpm add -D typescript-language-server` (souvent déjà couvert par Section 1)
- Rust : `rustup component add rust-analyzer`
- Python : `pip install python-lsp-server`
- Go : `go install golang.org/x/tools/gopls@latest`
- C/C++ : installer LLVM (`clangd`)

**Tests** : Vitest sur le mapping transition→état. Smoke live : rust-analyzer → `● rust : prêt` ;
ouvrir un `.py` sans pylsp → `⚠ pylsp non installé`.

---

### Section 5 — Sécurité : sanitisation HTML LSP (dette couplée à Section 1)

**Fichier** : `src/features/code/lsp/client.ts` (modifié) + `package.json` (dép.).

**Menace** : hovers/diagnostics LSP arrivent en Markdown→HTML. Sans `sanitizeHTML`, un
serveur compromis injecte du JS (XSS webview). La Section 1 **aggrave** ce risque : résoudre
depuis `node_modules/.bin` = exécuter potentiellement un serveur fourni par le dépôt ouvert,
pas par l'utilisateur. La mitigation actuelle (« seulement via `which()` ») ne tient plus.

**Solution** :
- Ajouter `dompurify` (3.x embarque ses propres types — `@types/dompurify` est obsolète,
  ne PAS l'ajouter ; le plan confirmera la version résolue).
- Passer `sanitizeHTML: (html) => DOMPurify.sanitize(html, CONFIG)` à la config du `LSPClient`
  (là où le commentaire l.109-114 signale déjà le trou).
- Config stricte : pas de `<script>`, pas de handlers `on*`, pas d'`href: javascript:`. Liens
  `file://`/`https` affichés mais inertes au clic dangereux.

**Couplage** : Section 1 et Section 5 sont livrées ensemble — l'une sans l'autre régresse la
posture de sûreté.

**Tests** : Vitest sur le sanitizer (un `<img onerror=...>` / `<script>` est neutralisé ;
un hover légitime — code + lien doc — survit).

---

### Section 6 — Couverture langages + outline LSP

**6a. Mappings serveurs.** Étendre `resolve_lsp_binary` (Rust) **et** `SUPPORTED_LANG_IDS`
(TS) — les deux DOIVENT rester synchrones (noté client.ts l.57) :

| langId | serveur | résolution | note |
|---|---|---|---|
| go | `gopls` | PATH | standard stdio |
| c / cpp | `clangd` | PATH | standard stdio |
| java | `jdtls` | PATH | **best-effort** (lanceur complexe) |

Non installés chez l'utilisateur → déclenchent proprement l'état « ⚠ non installé »
(Section 4) — donc testable « en voyant » (le bon message s'affiche).

**Limite assumée Java** : `jdtls` n'est pas un simple binaire stdio (workspace data dir,
JVM args). Mappé mais marqué « best-effort » : s'il ne handshake pas, il tombe dans l'état
« erreur » sans casser le reste. Un Java parfait serait un mini-lot dédié.

**6b. Outline via `documentSymbol`.** `OutlinePanel` extrait aujourd'hui via Lezer.
Brancher : **si un LSP est prêt pour le fichier → outline depuis `textDocument/documentSymbol`**
(hiérarchique, `SymbolKind` typé) ; **sinon fallback Lezer** (statu quo, aucune régression).

**Tests** : Vitest sur le parsing `documentSymbol → arbre outline` (+ mapping SymbolKind→icône).
Smoke live : ouvrir un `.rs` → outline rust-analyzer hiérarchique.

---

## 3. Points transversaux

### Gestion d'erreur (fil rouge)
Chaque surface dégrade proprement :
- pas de LSP → comportement LOT 1 (snippets + Lezer + breadcrumbs) intact ;
- serveur crashé → état visible (Section 4) + retry au prochain `getLspClient` ;
- capacité absente → entrée grisée (Section 3) ;
- rename partiel impossible → erreur visible, jamais silencieuse.
**Jamais de gel, jamais de silence.**

### Synchronisation Rust ↔ TS
La table des langages supportés existe en double : `resolve_lsp_binary` (Rust) et
`SUPPORTED_LANG_IDS` (TS). Toute modification touche les deux dans le même commit.

### Tests
- **Rust** : `cargo test` (résolution binaire) — via vcvars64 headless.
- **Vitest** : URI↔path, sanitizer, documentSymbol→outline, transition→état.
- **Smoke live (utilisateur, « en voyant »)** : rust-analyzer = preuve immédiate ;
  TS après Section 1 ; états « non installé » pour py/go/cpp.

### Gates avant merge
`pnpm typecheck` + `pnpm test` + `cargo check`/`cargo test`, puis revue par un agent
**sans contexte** (anti-biais), puis auto-merge si vert (mémoire `feedback_git_auto_merge`).

---

## 4. Ordre de build (dépendances)

1. **Section 1** — résolution binaire + TS (débloque tout le reste, testable de suite via TS/rust).
2. **Section 5** — sanitize HTML (couplée à 1 : referme la surface XSS ouverte par 1).
3. **Section 4** — statut + onboarding (rend tout le reste *visible* / vérifiable « en voyant »).
4. **Section 2** — Workspace + navigation cross-fichier.
5. **Section 3** — gestes (Ctrl+Clic, clic-droit, palette).
6. **Section 6** — langages supplémentaires + outline LSP.

---

## 5. Fichiers touchés (récap)

**Rust**
- `src-tauri/src/commands/lsp.rs` — `resolve_lsp_binary` (résolution + table langages).

**TS — nouveaux**
- `src/features/code/lsp/workspace.ts` — `ShuguWorkspace`.
- `src/features/code/lsp/lspBridge.ts` — pont openFile / EditorView.
- `src/features/code/lsp/clickToDefinition.ts` — Ctrl+Clic.
- `src/features/code/lsp/lspStatusStore.ts` — store d'état.
- `src/features/code/LspStatusIndicator.tsx` — indicateur statusbar.

**TS — modifiés**
- `src/features/code/lsp/client.ts` — `workspace:` + `sanitizeHTML:` + maj `lspStatusStore` + `SUPPORTED_LANG_IDS`.
- `src/features/code/CodeMirrorEditor.tsx` — monter `clickToDefinition` dans `lspCompartment`.
- `src/features/panels/ContextMenu.tsx` — section LSP.
- `src/lib/commands.ts` — commandes palette LSP.
- `src/features/code/views-code.tsx` — `<LspStatusIndicator/>` dans la statusbar.
- `src/features/code/OutlinePanel.tsx` (+ `outline/`) — source `documentSymbol` avec fallback Lezer.
- `src/routes/RootLayout.tsx` — publier `openFile`/EditorView dans `lspBridge`.
- `package.json` — `dompurify` (3.x, types inclus).

---

## 6. Non-objectifs (YAGNI)

- CodeLens, peek/inline definition popup.
- Installation automatique des serveurs LSP.
- Java « parfait » (jdtls best-effort seulement).
- Call hierarchy, semantic tokens, inlay hints (extensions futures possibles, hors baseline Cursor).
