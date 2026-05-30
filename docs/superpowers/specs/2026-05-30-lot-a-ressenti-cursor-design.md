# Lot A — « ressenti Cursor » — Design

Date : 2026-05-30
Branche : `feat/lot-a-ressenti-cursor-20260530`
Statut : design validé (décisions tranchées avec l'utilisateur)

## Objectif

Rapprocher Shugu Forge du « ressenti Cursor » : l'IA voit le code sur lequel on
travaille **sans effort**, peut **lire le workspace elle-même**, et ses
propositions de code s'**appliquent en un clic** avec une revue de diff. Les
briques existent déjà séparément (RAG `vector.rs`, @-mentions `mentions.ts`,
pipeline inline-edit `ai-edit/*`) — ce lot les **câble dans le chat**.

Trois sous-fonctions, livrées ensemble :

1. **Contexte auto** — injecter le fichier actif + la sélection dans chaque
   message du chat, sans `@-mention`.
2. **Outils lecture seule au chat** — le chat peut lire/lister/grep le workspace
   en multi-tour (jamais écrire).
3. **Apply-from-chat** — bouton « Appliquer » sur les blocs de code du chat →
   diff inline accept/reject vers le fichier cible.

## Décisions validées

| Décision | Choix |
|---|---|
| Contexte auto — quoi | **Fichier actif + sélection** (chip retirable, toggle Settings, défaut ON) |
| Outils chat — sûreté | **Lecture seule** (read / list / grep). Aucune écriture directe par le chat. |
| Apply — cible | **Fichier nommé dans l'entête du bloc (```ts src/foo.ts) sinon fichier actif**, via diff accept/reject |

Philosophie de sûreté respectée (mémoire « empêcher l'irréparable ») : le chat
ne mute **jamais** le projet directement. Toute écriture passe par un diff que
l'humain valide (apply-from-chat) ou par Grounded Run (miroir jetable existant).

---

## Feature 1 — Contexte auto (fichier actif + sélection)

### Comportement
- À l'envoi d'un message depuis le chat **du main IDE**, on injecte
  automatiquement : (a) le chemin + contenu du fichier de l'onglet actif, (b) le
  texte sélectionné dans l'éditeur s'il y en a (avec ses numéros de ligne).
- Injection **éphémère** : ajoutée au dernier message `user` envoyé au modèle,
  jamais persistée en SQLite (même pattern que `@-mentions` et RAG, voir
  `chat-sync.ts:401-429`). Le message affiché reste propre.
- **Chip retirable** au-dessus du composer : `📄 foo.ts` et, si sélection,
  `⊿ sélection (N lignes)`. Cliquer la croix retire l'injection **pour ce tour**.
- **Toggle Settings** `chat.autoEditorContext` (défaut `true`). OFF = ne jamais
  injecter automatiquement (les @-mentions restent disponibles).
- **Mascotte (FloatChat)** : pas de contexte auto (fenêtre sans éditeur). Aucune
  régression — le chemin reste celui d'aujourd'hui.

### Ordre d'injection (priorité décroissante dans le prompt)
`@-mentions explicites` → `sélection` → `fichier actif` → `RAG auto`.
Chaque source garde son cap (24 KiB/fichier, comme `resolveMentions`).
Dédoublonnage : si le fichier actif est déjà @-mentionné, on n'injecte pas
deux fois (on saute le fichier actif).

### Découpage technique
- **Nouveau module pur** `src/features/chat/editorContext.ts` :
  - `buildEditorContext(input: { path: string; content: string; selection?: { text: string; startLine: number; endLine: number } }): string`
  - Pur, testé (`editorContext.test.ts`). Renvoie `""` si rien à injecter.
  - Cap identique à mentions (24 KiB) ; sélection jamais cappée si < cap.
- `sendChatMessage(...)` gagne un param optionnel
  `editorCtx?: { path; content; selection? }`. Injecté dans `apiMessages` au
  même endroit que mentions/RAG. Dédoublonnage vs `parseMentions(trimmed)`.
- Le **composer** (ChatPanel / ChatView du main IDE) fournit `editorCtx` depuis
  le ShellContext (activeFile, fileContents) + la sélection courante de
  l'éditeur. Conformément à la mémoire « useShell pas dans RootLayout », le
  composer reçoit ces valeurs en props/args, pas via un hook global planté dans
  RootLayout.
  - La **sélection** est exposée par CodeMirror via un petit accesseur déjà
    pris en charge par l'éditeur (à confirmer au plan : ref handle exposant
    `getSelection()` → `{ text, startLine, endLine }`). Si l'accesseur n'existe
    pas, on l'ajoute (petit, `EditorView.state.selection.main`).
- **Chip** : composant léger dans la zone composer ; state local `dropped` pour
  retirer l'injection ce tour.

### Tests
- `editorContext.test.ts` : build avec/sans sélection, cap, dédoublonnage entrée.

---

## Feature 2 — Outils lecture seule au chat

### Comportement
- Le chat direct devient **multi-tour** quand le modèle demande un outil de
  lecture : `fs_read_file`, `fs_list_dir`, `fs_search` (sous-ensemble strict des
  outils agents existants `agents/tools.rs`).
- **Aucune écriture** : `fs_write_file`, `fs_edit`, `run_command`, `skill_save`
  ne sont **pas** exposés au chat. `allow_exec = false`. Path-guard via les
  helpers `fs::safe_resolve` existants.
- Disponible pour les protocoles qui savent faire du tool-use :
  `anthropic`, `openai`, `custom`. `ollama` (pas de tool-use) et `codex` (a ses
  propres outils via app-server) restent **inchangés** — fallback : 1 tour, pas
  d'outils.
- Les tool-calls du chat sont **visibles** dans le fil : un mini-rendu inline
  « 🔍 a lu `src/foo.ts` » / « 📁 a listé `src/` » / « grep `useShell` (3) »,
  alimenté par des deltas `chat://delta` de `kind:"tool"`.
- **Toggle Settings** `chat.readTools` (défaut `true`).

### Découpage technique (Rust)
`chat_send` est aujourd'hui single-shot. On ajoute une **boucle d'outils bornée
read-only** :
- Sous-ensemble read-only des renderers de `agents/tools.rs`
  (`tools_json_openai` / `tools_json_anthropic` filtrés sur les 3 outils lecture).
- Dispatcher read-only réutilisant `fs::read_file_inner`, `fs::list_dir_inner`,
  `grep::grep_inner` (déjà existants, déjà path-guardés).
- Boucle plafonnée (`MAX_CHAT_TOOL_ITERS = 6`), même forme que `tool_use_loop`
  du runner, mais : émet sur `chat://delta` (pas `agent://lifecycle`), pas de
  persistance d'événements, et arrêt dès la première réponse sans tool-call.
- **Réutilisation maximale** : on extrait les builders de messages multi-tour
  (`build_openai_messages` / `build_anthropic_native`) et l'accumulateur de
  tool-calls vers un endroit partageable, ou on les appelle tels quels. Décision
  fine (extraire vs dupliquer un mini-loop) prise au writing-plans après lecture
  de `chat.rs` + `runner.rs` (éviter une grosse duplication ; mémoire « cleanup
  on replace »).
- Le `with_tools` du chat devient conditionnel (toggle + protocole compatible).

### Sûreté
- Liste d'outils **fermée** côté Rust (pas de passe-plat de noms). Tout nom
  inconnu → `unknown tool` (comportement existant).
- Aucune mutation possible : pas d'outil d'écriture câblé, point.

### Tests
- Rust unit : le renderer read-only n'expose QUE les 3 outils lecture ; le
  dispatcher read-only refuse `fs_write_file` / `run_command`.

---

## Feature 3 — Apply-from-chat

### Comportement
- Chaque bloc de code rendu dans le chat gagne un bouton **« Appliquer »**
  (à côté de « Copier » / « Ouvrir dans l'éditeur »).
- **Cible** : si l'entête du bloc porte un chemin (```ts src/foo.ts``` ou
  première ligne `// src/foo.ts`), on cible ce fichier (ouvert/créé) ; sinon le
  **fichier de l'onglet actif**.
- « Appliquer » ouvre le fichier cible dans l'éditeur puis lance le **même flux
  de diff inline accept/reject** que l'édition Cmd+K, en lui passant le contenu
  du bloc comme **résultat déjà calculé** (pas de nouvel appel LLM) :
  réutilisation de `ai-edit/applyController.ts` + `unifiedDiffExtension.ts`
  (`@codemirror/merge` unifiedMergeView). L'utilisateur accepte/refuse par hunk.
- Si le bloc cible un **nouveau** fichier (chemin absent du disque), le diff est
  « tout ajouté » → accepter crée le fichier.

### Découpage technique
- **Parsing de l'entête** : petit util pur
  `parseCodeBlockTarget(lang: string, firstLine: string): string | null`
  (teste `lang path` et `// path` / `# path`). Testé.
- Aujourd'hui `Message.code` est **singleton** (1er bloc, `parseAiReply`).
  Pour appliquer **n'importe quel** bloc, le rendu chat doit parser **tous** les
  blocs au moment de l'affichage (ou étendre `parseAiReply`). Décision : étendre
  le rendu pour exposer chaque bloc avec son entête sans changer le schéma SQLite
  (le parsing se fait au rendu depuis `body`). À préciser au plan.
- **Branchement apply** : déterminer au plan la fonction exacte de
  `applyController` / `aiEditController` qui accepte un « contenu proposé »
  fourni (sans rappel LLM). Si elle n'existe pas telle quelle, on ajoute un
  point d'entrée mince qui réutilise l'extension de diff existante.
- Si le fichier cible n'est pas ouvert, on l'ouvre d'abord (réutilise
  `openFile` du shell).

### Tests
- `parseCodeBlockTarget` : avec/sans chemin, styles `lang path`, `// path`.

---

## Ce qui N'EST PAS dans ce lot (YAGNI)
- Écriture directe par le chat (refusée — sûreté).
- @web / @docs / @folder, règles projet (`.cursorrules`) — lots ultérieurs.
- Tab autocomplete (FIM) — lot B.
- Multi-fichiers « Composer » en une passe — couvert par Grounded Run, hors lot.

## Stratégie de vérification
- `pnpm typecheck` (TS strict-ish) vert.
- `cargo check` headless (vcvars64) vert + tests Rust read-only.
- `pnpm test` (vitest) : nouveaux tests purs verts.
- **Vérif en voyant** (mémoire « user évalue en voyant ») : E2E manuel —
  ouvrir un fichier, poser une question sans @-mention (le modèle cite le bon
  fichier), demander au chat de « lire X » (tool-call visible), demander un
  patch et l'appliquer (diff accept/reject).

## Risques / points ouverts (à figer au plan)
- Accesseur de sélection CodeMirror (existe ? sinon l'ajouter).
- Refactor de la boucle multi-tour Rust : extraire un helper partagé
  chat↔runner vs mini-loop dédié au chat (éviter la duplication).
- Point d'entrée « apply contenu fourni » dans le pipeline inline-edit.
- Rendu multi-blocs dans le chat (parsing au rendu vs extension `parseAiReply`).
