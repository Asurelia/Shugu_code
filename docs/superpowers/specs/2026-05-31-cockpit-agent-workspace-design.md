# Cockpit « agent workspace » (façon Codex app) — Design

Date : 2026-05-31
Branche : `claude/upbeat-jemison-55c3a0`
Statut : design validé (décisions tranchées avec l'utilisateur, maquettes vues en voyant + doc Codex vérifiée)

## Objectif

Transformer Shugu Forge en **« agent workspace » centré chat**, façon *Codex app / Claude Code desktop*,
mais **branché sur le vrai IDE intégré** pour augmenter la puissance modèle ⇄ utilisateur. Le chat
devient la **scène commune utilisateur/IA** ; l'IDE (éditeur, Révision/diff, terminal, fichiers,
navigateur) devient des **surfaces contextuelles** dans un **panneau droit redimensionnable**, ouvertes
à la demande.

Ce n'est **pas** « cacher l'IDE » : c'est inverser la hiérarchie. Aujourd'hui le chat est un onglet parmi
dix (cul-de-sac) ; demain c'est la scène autour de laquelle le code, le diff, le terminal se matérialisent.

### Pourquoi c'est tractable (et pas juste « réutiliser »)

Le multi-panneau ne se gagne pas dans les panels (ils existent et sont autonomes), mais dans le **shell
qui les arrange**. Bonne nouvelle : l'état partagé est **déjà hissé** au bon niveau
(`RootLayout` / `ShellContext` : `openFiles`, `activeFile`, `fileContents`, `editorViewRef`). Le refactor
est donc **concentré dans un seul fichier d'arrangement**, à faible rayon d'explosion — `CodeView`,
`ChatView`, `Dock`, le moteur de diff restent intacts.

## Le virage architectural central

| | Aujourd'hui | Demain (cockpit) |
|---|---|---|
| Shell | `RootLayout` a **un** `<Outlet/>` ([RootLayout.tsx:1098](../../../src/routes/RootLayout.tsx)) | Plusieurs **surfaces montées en parallèle** + un **état de layout** |
| Chat / Code | Deux **routes** qui se **relaient** dans le créneau unique (route-commuté) | **Coexistent** : chat = scène, éditeur = surface du panneau droit |
| `editorViewRef` | **`null` hors `/code`** ([commentaire l.484](../../../src/routes/RootLayout.tsx)) | **Toujours vivant** tant que la surface Éditeur est montée |
| Terminal (Dock) | Lié à `isCode` ([l.1054](../../../src/routes/RootLayout.tsx)) | **Démarié** : dock bas (`Cmd+J`) **+** onglet du panneau droit |

C'est ce virage qui débloque le geste-clé (Cmd+clic dans le diff → saut éditeur:ligne) : impossible
aujourd'hui car l'éditeur est démonté hors `/code`.

## Décisions verrouillées

| Décision | Choix |
|---|---|
| Squelette | **A** — rail (projets+conversations) · chat central · panneau droit à onglets |
| Ouverture panneau droit | **Bouton de panneau** (haut-droite) ouvre/ferme ; redimensionnable (poignée) |
| `+` de la barre d'onglets | **Menu** de choix de surface (« Ouvrir l'onglet du panneau latéral ») |
| Surfaces (this lot) | **Révision · Éditeur · Terminal · Fichiers · Navigateur** (Skills / Conversations // = plus tard) |
| Cartes d'opération in-chat | **Réversibles** (« N fichiers modifiés · Annuler ↺ / Vérifier »), dépliables par fichier/hunk — = **Lot A** |
| Gestes du diff (Révision) | **clic nom** → ouvre fichier · **Cmd+clic ligne** → éditeur:ligne · **survol `+`** → commentaire inline à l'agent · stage/revert **diff/fichier/hunk** · portées **non-commités / branche / dernier tour** |
| Pilotage (qui ouvre) | **Tu ouvres, l'IA propose** : la carte in-chat apparaît seule, les panneaux ne s'ouvrent qu'au clic (bouton panneau ou « Voir la révision → ») — **layout souverain** |
| Terminal | **Les deux** : onglet du panneau droit **+** dock bas (`Cmd+J`) |
| Mascotte | **INTACTE** — fenêtre séparée, flotte par-dessus. **Hors scope.** |
| Destinations (Image Studio / Gallery / Studio) | **Plein écran séparées via le rail**, hors cockpit |

### Conformité Codex (vérifiée sur la doc officielle, mai 2026)

Modèle aligné sur la doc Codex : panneau latéral à surfaces (Files/Review/Editor/Browser/Terminal/Skills/
Parallel), ouvert par bouton, `+`-menu de surface, terminal `Cmd+J`. Gestes du diff confirmés :
**clic nom** = ouvre le fichier, **Cmd+clic ligne** = ouvre la ligne dans l'éditeur, **survol → `+`** =
**commentaire inline à l'agent** (≠ saut éditeur), stage/revert par diff/fichier/hunk, 3 portées.
Sources : `developers.openai.com/codex/app/review`, `/codex/app/features`, `/codex/changelog`.

## Composants — réutilisation maximale

| Surface / élément du cockpit | Brique existante | Neuf à ajouter |
|---|---|---|
| Scène chat | `ChatView` + **`useMessageDisplay`** (hook commun — **ne pas dupliquer**, cf. mémoire) | — |
| Carte d'opération in-chat | **Lot A** apply-from-chat + journal réversible + moteur diff `@codemirror/merge` | rendu inline dépliable + « Voir la révision → » |
| Révision (diff) | `SideGit` + git queries + `@codemirror/merge` | gouttière : **`+` commentaire** + **Cmd+clic** ligne→éditeur ; portées ; stage/revert hunk |
| Éditeur | `CodeView` / CodeMirror (`editorViewRef`) | montée **comme surface persistante** (onglet) |
| Terminal | `Dock` ([Dock.tsx](../../../src/features/dock/Dock.tsx)) — dock bas | instance **onglet droit** + `Cmd+J` |
| Fichiers | `SideFiles` | rendu comme surface |
| Navigateur | `preview://` | rendu comme surface |
| Rail (projets/convos) | `Rail` + `ChatSidebar` | — |
| Redimensionnement | patterns `SidePanel` / `DockWorkspace` existants | poignée chat ⇄ panneau droit |

**Pièces réellement neuves** : (1) le **shell cockpit** + **état de layout** ; (2) la **barre d'onglets**
du panneau droit + **`+`-menu** ; (3) les **gouttières du diff** (commentaire + cmd-click) ; (4) un
**gestionnaire keep-warm** des surfaces.

## Flux de données

- **Chat** : SQLite local-first + events `chat-sync` — **inchangé**, partagé par la scène (hook commun,
  jamais dupliqué entre IDE et mascotte).
- **Carte d'op** : le journal d'écritures par tour (Lot A) → rendu en carte dépliable ; bouton
  « Voir la révision → » **demande** l'ouverture du panneau droit sur la surface Révision.
- **Cmd+clic ligne (diff)** → `openFile(path)` (déjà dans `ShellContext`) + surface active = Éditeur +
  `editorViewRef.dispatch({ selection, effects: EditorView.scrollIntoView })`. Le `file:line` vient du
  hunk.
- **Survol `+` (diff)** → ajoute un **commentaire de ligne** structuré au suivi (message pré-rempli avec
  le contexte de la ligne, façon « Address inline comments »).
- **Stage/revert par hunk** → réutilise l'accept/reject de diff existant + opérations d'index git.

## Sûreté / cohérence (mémoire)

- **Layout souverain** : l'agent **n'ouvre pas** les panneaux ; il **propose** via la carte in-chat
  (cohérent « empêcher l'irréparable »). L'utilisateur garde la main sur sa disposition.
- **Pas de duplication chat** : la scène chat et la mascotte transitent les mêmes infos via le hook
  commun ; on ne duplique que les styles.
- **TanStack par défaut** : l'état de layout passe par un store TanStack ; toute dérogation justifiée et
  documentée à l'endroit du code.
- **`editorViewRef`** : vivant tant que la surface Éditeur est montée (fin du `null` hors `/code`).
- **Cleanup on replace** : tout code de l'ancien arrangement route-commuté remplacé est **supprimé** dans
  le même round.

## Découpage en lots (chacun visible & testable « en voyant »)

- **Lot Cockpit-1 — Le shell à surfaces.** `RootLayout` → cockpit : chat central + panneau droit
  redimensionnable + bouton panneau + `+`-menu. Surfaces **Éditeur** + **Révision** (vides/minimales mais
  persistantes). Destinations restent en routes. *Visible* : chat à gauche, ouvrir l'éditeur à droite, le
  redimensionner ; `editorViewRef` toujours vivant.
- **Lot Cockpit-2 — Révision branchée + gestes diff.** Le panneau Révision montre le vrai git diff
  (portées, stage/revert hunk) ; **clic nom** → ouvre fichier ; **Cmd+clic ligne** → éditeur:ligne ;
  **survol `+`** → commentaire à l'agent.
- **Lot Cockpit-3 — Cartes d'op in-chat + pont.** La carte « N fichiers modifiés / Annuler / Vérifier »
  (Lot A) rendue **inline**, dépliable par fichier/hunk, avec « Voir la révision → ».
- **Lot Cockpit-4 — Surfaces restantes.** Terminal (onglet droit + dock bas `Cmd+J`), Fichiers,
  Navigateur (`preview://`) via le `+`-menu. Budget **keep-warm**.
- **Plus tard (hors design) :** Skills, Conversations parallèles, idées changelog Codex (Appshots /
  Goal Mode / Remote Computer Use) — alimentent la vision agents, pas ce design.

## Stratégie de vérification

- `pnpm typecheck` vert · `cargo check` headless (vcvars64) vert · `pnpm test` (vitest) vert.
- **Vérif en voyant** (mémoire « user évalue en voyant ») — E2E manuel par lot :
  - C-1 : ouvrir le cockpit, glisser la poignée, ouvrir l'Éditeur à droite, le voir rester monté.
  - C-2 : **Cmd+clic** une ligne du diff → l'éditeur saute au bon `fichier:ligne`, éditable ; **survol `+`**
    → commentaire pré-rempli ; stage/revert d'un hunk.
  - C-3 : un tour qui écrit → carte « N fichiers modifiés », **Annuler** restaure ; « Voir la révision → »
    ouvre le panneau.
  - C-4 : terminal en bas **et** en onglet droit ; Fichiers + Navigateur comme surfaces.

## Risques / points ouverts (à figer au writing-plans)

- **Stratégie de montage keep-warm vs unmount** (perf webview Tauri) : quelles surfaces restent chaudes
  (éditeur + terminal), lesquelles lazy (navigateur, fichiers). Budget explicite, pas « tout monté ».
- **Où vit l'état de layout** : store TanStack vs `ShellContext` ; **persistance par workspace** (tailles,
  surface active, panneau ouvert).
- **Routing** : le cockpit devient la route par défaut ; destinations (image/studio/gallery/settings) en
  routes séparées via le rail. Vérifier que `Rail` / palette de commandes / keybindings continuent.
- **Terminal partagé** : une seule instance `Dock` pour bas **et** droite, ou deux instances (PTY
  partagé ?).
- **Forme du commentaire de ligne** (`+`) : structure du message de suivi pré-rempli (chemin + lignes).
- **Migration progressive** : garder `/code` et `/chat` fonctionnels derrière un *feature flag cockpit*
  pendant la transition (éviter un big-bang qui casse l'app le temps du refactor).
