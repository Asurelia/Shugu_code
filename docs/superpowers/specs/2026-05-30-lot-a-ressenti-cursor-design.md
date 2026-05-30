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
| Outils chat | **Lecture + écriture directe** (read / list / grep / write / edit) — choix explicite de l'utilisateur |
| Apply — cible | **Fichier nommé dans l'entête du bloc (```ts src/foo.ts) sinon fichier actif**, via diff accept/reject |

### Note sûreté (choix utilisateur vs design existant)

L'utilisateur a explicitement choisi **« lecture + écriture directe »** : le chat
peut modifier les vrais fichiers du workspace lui-même, sans étape de diff
obligatoire. C'est plus puissant (vrai « agent dans le chat »), mais cela
**déroge** au design actuel (chat read-only, mutations via miroir Grounded Run)
et à la mémoire « empêcher l'irréparable ».

Garde-fous retenus pour concilier le choix et ce principe (aucun ne retire la
capacité d'écriture) :
- **Périmètre verrouillé** : les outils d'écriture sont câblés sur les helpers
  path-guardés existants (`fs::safe_resolve_for_write`) → strictement dans le
  workspace, jamais `..`/chemins absolus. Pas de `run_command` (pas d'exécution).
- **Réversibilité** : chaque tour de chat qui écrit est **réversible en un clic**.
  On capture, avant la première écriture du tour, l'état des fichiers touchés et
  on expose un bouton « Annuler les modifications de ce message » (même esprit
  que `agent_reverse_patch` du Grounded Run). Détail d'implémentation au plan
  (journal en mémoire du tour, ou snapshot léger).
- **Visibilité** : chaque écriture est affichée dans le fil (« ✏️ a écrit
  `src/foo.ts` »), jamais silencieuse.
- **Réglage** : toggle `chat.writeTools` (défaut ON puisque c'est le choix
  utilisateur ; le mettre OFF redonne un chat lecture-seule).

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

## Feature 2 — Outils fs au chat (lecture + écriture)

### Comportement
- Le chat direct devient **multi-tour** quand le modèle demande un outil :
  - **Lecture** : `fs_read_file`, `fs_list_dir`, `fs_search`.
  - **Écriture** : `fs_write_file`, `fs_edit` (choix utilisateur). PAS de
    `run_command` (aucune exécution), PAS de `skill_save` (réservé aux agents).
  - Sous-ensemble des outils agents existants `agents/tools.rs` (mêmes schémas).
- Disponible pour les protocoles qui savent faire du tool-use :
  `anthropic`, `openai`, `custom`. `ollama` (pas de tool-use) et `codex` (a ses
  propres outils via app-server) restent **inchangés** — fallback : 1 tour, pas
  d'outils.
- Les tool-calls du chat sont **visibles** dans le fil : mini-rendu inline
  « 🔍 a lu `src/foo.ts` », « 📁 a listé `src/` », « grep `useShell` (3) »,
  « ✏️ a écrit `src/foo.ts` », alimenté par des deltas `chat://delta`
  de `kind:"tool"`.
- **Réversibilité du tour** : si au moins un fichier a été écrit pendant le tour,
  un bouton « Annuler les modifications de ce message » restaure l'état d'avant
  (cf. Note sûreté).
- **Toggles Settings** : `chat.readTools` (défaut ON) et `chat.writeTools`
  (défaut ON). `writeTools` OFF ⇒ chat lecture seule.

### Découpage technique (Rust)
`chat_send` est aujourd'hui single-shot. On ajoute une **boucle d'outils bornée** :
- Renderers de `agents/tools.rs` filtrés sur le sous-ensemble chat
  (lecture + write/edit, selon les toggles).
- Dispatcher réutilisant les helpers existants déjà path-guardés :
  `fs::read_file_inner`, `fs::list_dir_inner`, `grep::grep_inner` (lecture) et
  `fs::write_file_inner`, l'edit chirurgical de `agents/tools.rs` (écriture via
  `fs::safe_resolve_for_write`). `allow_exec = false` toujours.
- Boucle plafonnée (`MAX_CHAT_TOOL_ITERS = 8`), même forme que `tool_use_loop`
  du runner, mais : émet sur `chat://delta` (pas `agent://lifecycle`), pas de
  persistance d'événements, arrêt dès la première réponse sans tool-call.
- **Réversibilité** : avant la 1ʳᵉ écriture d'un tour, le dispatcher capture le
  contenu d'origine des fichiers visés (ou « absent » si création). À la fin du
  tour, `chat_send` renvoie ce journal au front, qui l'attache au message
  (bouton Annuler). Réutilise l'esprit de `mirror::reverse_patch` /
  `agent_reverse_patch` ; ici un journal `{path, before|null}` suffit (pas de
  Docker, écritures directes sur le workspace).
- **Réutilisation maximale** : extraire les builders multi-tour
  (`build_openai_messages` / `build_anthropic_native`) + l'accumulateur de
  tool-calls vers un module partageable chat↔runner, plutôt que dupliquer
  (mémoire « cleanup on replace »). Décision fine extraire vs mini-loop dédié
  prise au writing-plans après relecture de `chat.rs` + `runner.rs`.
- Le `with_tools` du chat devient conditionnel (toggles + protocole compatible).

### Sûreté
- Liste d'outils **fermée** côté Rust (pas de passe-plat de noms). Tout nom
  inconnu → `unknown tool` (comportement existant).
- Écriture **path-guardée** (workspace uniquement) ; pas d'exécution de commande.
- Chaque tour à écriture est **réversible** + chaque écriture est **visible**.

### Tests
- Rust unit : le renderer chat n'expose QUE le sous-ensemble attendu selon les
  toggles ; le dispatcher refuse `run_command` / `skill_save` ; une écriture hors
  workspace est rejetée ; le journal d'annulation capture bien `before`.

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
- **Branchement apply (pipeline existant confirmé)** : le bouton « Appliquer »
  appelle `applyCodeToFile(path, text, lang)` (RootLayout) qui ouvre+active le
  fichier puis pose une `ApplyRequest` (`applyController.setApplyRequest`,
  type `ai-edit/types.ts:ApplyRequest`). `useApplyRunner` (monté dans CodeView)
  attend que la view du fichier cible soit prête puis lance
  `startApply(view, { path, proposedText, lang, wasDirty })`
  (`aiEditController.ts:383`) : diff pleine-page accept/reject **sans appel LLM**.
  → Feature 3 = surtout du **câblage UI** + résolution de cible ; le moteur
  existe déjà (vérifier juste que `applyCodeToFile` est exporté/atteignable
  depuis le composant de bloc de code ; sinon exposer un point d'entrée mince).
- Fichier cible non ouvert : `applyCodeToFile`/`openFile` l'ouvrent (création si
  absent pour un nouveau chemin).

### Tests
- `parseCodeBlockTarget` : avec/sans chemin, styles `lang path`, `// path`.

---

## Ce qui N'EST PAS dans ce lot (YAGNI)
- @web / @docs / @folder, règles projet (`.cursorrules`) — lots ultérieurs.
- Tab autocomplete (FIM) — lot B.
- Multi-fichiers « Composer » en une passe — couvert par Grounded Run, hors lot.

## Stratégie de vérification
- `pnpm typecheck` (TS strict-ish) vert.
- `cargo check` headless (vcvars64) vert + tests Rust read-only.
- `pnpm test` (vitest) : nouveaux tests purs verts.
- **Vérif en voyant** (mémoire « user évalue en voyant ») : E2E manuel —
  ouvrir un fichier, poser une question sans @-mention (le modèle cite le bon
  fichier) ; demander au chat de « lire X » (tool-call de lecture visible) ;
  demander au chat de « modifie Y » (écriture directe visible + bouton Annuler
  qui restaure) ; demander un bloc de code et l'**Appliquer** (diff accept/reject
  sur le bon fichier).

## Risques / points ouverts (à figer au plan)
- Accesseur de sélection CodeMirror (existe ? sinon l'ajouter : un getter sur le
  `CodeMirrorEditorHandle` exposant `EditorView.state.selection.main`).
- Refactor de la boucle multi-tour Rust : extraire un helper partagé
  chat↔runner vs mini-loop dédié au chat (éviter la duplication).
- Journal d'annulation des écritures du tour : forme exacte (in-mem renvoyé au
  front vs persistance légère) + UX du bouton « Annuler » par message.
- `applyCodeToFile` atteignable depuis le composant de bloc de code du chat
  (sinon exposer un point d'entrée mince).
- Rendu multi-blocs dans le chat (parsing au rendu vs extension `parseAiReply`).
