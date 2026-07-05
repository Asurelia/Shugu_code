# Le Projet comme entité de première classe — Design (Phase 1)

- **Date** : 2026-07-05
- **Statut** : design validé (niveau « colonne vertébrale »), en attente de relecture avant plan
- **Périmètre** : Phase 1 du chantier « Mémoire & données scopées par projet »
- **Historique** : première version « rustine » (ajout d'une colonne `workspace_root`) écartée par
  l'utilisateur (« tu ne peux pas faire beaucoup mieux ? »). Ce design attaque la cause racine.

---

## 1. Problème (racine)

`shugu.db` est un **ramasse-tout global** parce que **Shugu n'a aucune notion de « projet » de première
classe** :

- La table `projects` (`id, name, color, sort_order`) est **100 % morte** — jamais lue ni écrite. Or ses
  colonnes `color` et `sort_order` prouvent qu'elle a été **conçue pour un sélecteur de projets** jamais
  construit.
- La colonne `conversations.project_id` sert aujourd'hui à stocker des ids de **« groupes » éphémères**
  (`chat-sidebar.tsx` : `SEED_GROUPS`, état React, **remis à zéro à chaque reload**). Pseudo-projets
  sans persistance.
- Les conversations sont lues **sans filtre** (`db.ts:334`) → toute la soupe s'affiche quel que soit le
  dossier ouvert.
- Le seul vrai scope-projet existant (`studio_projects.workspace_root`, V8) vit **à part**, déconnecté du
  chat.

Deux notions de « projet » déconnectées + une table morte + des groupes volatils = « ramasse-tout sans
logique ».

## 2. Objectif

Faire du **Projet une entité de première classe** : la colonne vertébrale à laquelle se rattachent les
conversations (et, plus tard, la mémoire, les agents, le studio). Un Projet = un dossier ouvert.

### Décisions validées

1. **Ressusciter la table `projects`** au lieu de la supprimer → registre réel des projets, clé =
   chemin du dossier.
2. **Ré-animer `conversations.project_id`** comme **vraie référence** vers `projects.id` (au lieu d'y
   coller une nouvelle colonne `workspace_root`).
3. **Identité projet = chemin exact du dossier** (forme d'affichage). Un worktree est un projet distinct
   (comme Claude Code). Pas de résolution git.
4. **Vue « Projet courant » stricte** : uniquement les conversations du projet ouvert. Les orphelines
   (`project_id IS NULL`) n'apparaissent que dans « Tous ».
5. **Backfill intelligent** : réattribuer les conversations *existantes* à leur vrai projet via les liens
   `studio_projects (conversation_id ↔ workspace_root)`. On nettoie la soupe actuelle, pas seulement la
   future.
6. **Vrai sélecteur de projets** visible (récents, couleur auto, compteur de convs, clic = ouvrir).

## 3. Non-objectifs (Phase 1)

- **Ne pas** scoper la mémoire / les agents / le MCP maintenant (option « convergence totale » écartée) —
  ils rejoindront le `project_id` en Phase 2/3, sur cette même fondation.
- **Ne pas** dénormaliser `messages` (scopés par héritage via `conversation_id`).
- **Ne pas** toucher Convex (cosmétique, jamais appelé côté TS pour les conversations).
- **Ne pas** unifier repo + worktrees (décision #3).

## 4. Modèle

```
projects  (registre, ex-table morte ressuscitée)
   id            ← PK
   root_path     ← clé UNIQUE = dossier ouvert, forme d'affichage (sans \\?\, en /)
   name          ← défaut = basename(root_path), éditable
   color         ← auto-assignée (palette), éditable
   sort_order    ← réordonnancement manuel
   last_opened_at, created_at
        ▲
        │  project_id  (colonne EXISTANTE ré-animée, = FK réel vers projects.id)
        │
conversations ──< messages           (messages hérités via conversation_id, inchangés)

  ouvre dossier → upsert projects(root_path), devient le « projet courant »
  nouvelle conv → project_id = id du projet courant  (NULL si aucun dossier ouvert)
  sidebar       → WHERE project_id = <courant>   (+ switch « Tous »)
```

**Clé = forme d'affichage** (`fsGetWorkspaceRoot()`, préfixe `\\?\` retiré, `/`). NB : `studio_projects`
stocke la forme canonique Rust ; les deux ne se croisent que dans le backfill, où l'on **normalise** la
valeur studio en forme d'affichage avant comparaison (voir §5.5).

## 5. Design détaillé

### 5.1 Schéma — migration V18 (additive & immuable)

On **n'édite jamais** une migration livrée. Nouvelle `MIGRATION_V18` :

```sql
ALTER TABLE projects ADD COLUMN root_path      TEXT;
ALTER TABLE projects ADD COLUMN last_opened_at INTEGER;
ALTER TABLE projects ADD COLUMN created_at     INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root ON projects(root_path);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at);
```

- Aucune colonne ajoutée à `conversations` (on réutilise `project_id`).
- Enregistrer la migration (version 18) dans `lib.rs` ; **bumper `TARGET_SCHEMA_VERSION` → 18**
  (`backup.rs`, exigé par le `debug_assert` de `lib.rs:580`).
- **Sécurité boot** : uniquement des `ALTER ADD COLUMN` (O(1)) + index → pas de réécriture de lignes,
  pas de grosse transaction. Respecte la contrainte verrou/migration-lazy. **Le backfill n'est PAS dans
  la migration** (cf. §5.5).

### 5.2 Le registre Projet (couche TS `db.projects`)

Les projets/conversations sont manipulés côté TS (SQL direct via `db.ts`) — on garde ce pattern, pas de
commande Rust.

- `db.projects.upsertForRoot(rootPath) → ProjectRow` : `SELECT … WHERE root_path=?` sinon `INSERT`
  (`name = basename(rootPath)`, `color` auto depuis une palette fixe indexée par nombre de projets,
  `created_at`, `last_opened_at = now`). Idempotent grâce à l'index unique.
- `db.projects.list() → ProjectRow[]` : ordonné `last_opened_at DESC` (ou `sort_order`).
- `db.projects.conversationCounts() → Map<projectId, n>` : badges du sélecteur.
- `db.projects.setProject(convId, projectId | null)` : déplacer une conversation vers un projet.
- `ProjectRow` (db.ts) : ajouter `root_path`, `color`, `sort_order`, `last_opened_at`, `created_at`.
- Hook `useCurrentProject()` : `fsGetWorkspaceRoot()` → `upsertForRoot` → projet courant (`null` si aucun
  dossier ouvert).

### 5.3 Écriture — création scopée

Les 2 points de création (`newConvo()` `chat-sidebar.tsx:336`, `createConversation()` `chat-sync.ts:1438`)
stampent `project_id = id du projet courant` (via `useCurrentProject()` / un helper partagé), `NULL` si
aucun dossier. `db.ts` reste pur : le caller fournit la valeur.

### 5.4 Lecture + sélecteur de projets

- `db.conversations.list(projectId?)` / `listNested(projectId?)` :
  - `projectId` (chaîne) → `WHERE project_id = ?` (vue « Projet courant » stricte),
  - `null` (aucun dossier / bucket global) → `WHERE project_id IS NULL`,
  - sentinelle `"__all__"` → pas de filtre.
- **Sélecteur** (nouveau composant `ProjectSwitcher`, en tête de sidebar) : liste `db.projects.list()`
  avec pastille couleur + compteur ; entrée « Global · sans projet » ; switch **« Projet courant / Tous »**.
  Cliquer un projet ≠ courant → `fsSetWorkspaceRoot(root_path)` (ouvre le dossier ; si `root_path`
  n'existe plus sur disque, marquer « indisponible », ne pas planter).

### 5.5 Backfill intelligent (post-boot, best-effort, one-shot)

**Pas dans la migration** (évite le verrou boot). Routine TS `backfillProjectsFromStudio()` déclenchée
après le démarrage (idle), gardée par un flag `settings.projects_backfill_done`, par **lots** :

1. **Normaliser le legacy** : `UPDATE conversations SET project_id = NULL WHERE project_id NOT IN
   (SELECT id FROM projects)` — vide les anciens ids de groupes éphémères (sinon ces conversations
   seraient orphelines, invisibles hors « Tous »).
2. **Réattribuer via studio** : pour chaque `studio_projects(conversation_id, workspace_root)` non nul,
   normaliser `workspace_root` en forme d'affichage, `upsertForRoot`, puis
   `UPDATE conversations SET project_id = <projet> WHERE id = <conversation_id> AND project_id IS NULL`.
3. Poser le flag. Les conversations sans lien studio restent `NULL` → « Global » (limite assumée : on ne
   peut pas deviner le dossier d'une conversation jamais passée par le studio).

### 5.6 Retrait des groupes éphémères

Le système de groupes en mémoire (`SEED_GROUPS`, `addGroup`/`renameGroup`/`deleteGroup`, `setGroup`)
disparaît : il était volatil et détournait `project_id`. Le vrai projet devient l'organisation de premier
niveau ; `pinned` (colonne existante) gère l'épinglage *dans* un projet. `setGroup` → remplacé par
`setProject` (déplacer une conv vers un projet). C'est une **simplification**, pas une perte de données
(les groupes n'étaient jamais persistés).

### 5.7 Rafraîchissement au changement de dossier

Le listener `workspace://changed` (`RootLayout.tsx:665`) : `upsertForRoot` (maj `last_opened_at`) +
invalider `chatKeys.conversations` et `projectKeys.list`. Bascule de dossier ⇒ sidebar + sélecteur à jour.

## 6. Fichiers touchés (prévision)

| Fichier | Changement |
|---|---|
| `src-tauri/src/lib.rs` | `MIGRATION_V18` + entrée `Migration { version: 18, … }` |
| `src-tauri/src/commands/backup.rs` | `TARGET_SCHEMA_VERSION` 17 → 18 |
| `src/lib/db.ts` | `ProjectRow` enrichi ; `db.projects` réécrit (upsertForRoot/list/counts/setProject) ; `conversations.create()` (project_id) ; `list()/listNested(projectId)` ; `backfillProjectsFromStudio()` |
| `src/features/projects/*` (nouveau) | `useCurrentProject`, `useProjects`, `ProjectSwitcher`, `projectKeys` |
| `src/features/chat/chat-sync.ts` | `createConversation()` stampe `project_id` |
| `src/features/chat/chat-sidebar.tsx` | retrait des groupes éphémères ; intégration `ProjectSwitcher` + filtre projet courant ; `setProject` |
| `src/features/chat/keys.ts` | `chatKeys.conversations(projectId)` |
| `src/routes/RootLayout.tsx` | listener `workspace://changed` : upsert projet + invalidations ; déclenchement one-shot du backfill |

## 7. Plan de test

- **Rust (headless, `cargo test` via vcvars64)** : V18 idempotente ; base V17→V18 conserve conversations
  et projets ; unicité `root_path` ; `TARGET_SCHEMA_VERSION` == dernière migration.
- **TS (unit)** : `upsertForRoot` idempotent ; backfill = normalisation NULL + réattribution studio,
  idempotent (flag), lots.
- **Manuel / GUI (l'utilisateur juge au rendu)** :
  1. Ouvrir dossier A → un projet apparaît dans le sélecteur (nom = basename, couleur). Créer 2 convs.
  2. Ouvrir dossier B → sélecteur ajoute B ; sidebar ne montre que les convs de B.
  3. Cliquer A dans le sélecteur → rouvre A, ses 2 convs reviennent.
  4. « Tous » → A + B + Global.
  5. Chat sans dossier → conv en « Global », absente des vues projet.
  6. Backfill : des conversations d'avant migration passées par le studio réapparaissent **sous leur
     projet** (pas dans Global).
  7. Aucune conversation perdue (les autres legacy sont dans « Global »).

## 8. Risques & vigilance

- **Migration immuable** : ne jamais rééditer une `MIGRATION_Vx` livrée. V18 additive.
- **Verrou SQLite au boot** : aucune écriture de masse dans la migration ; backfill = post-boot, lots,
  flag-gardé, best-effort.
- **`project_id` legacy pollué** (ids de groupes) : normalisés à NULL avant réattribution (§5.5 étape 1),
  sinon conversations orphelines.
- **Préfixe `\\?\`** : clé projet = forme d'affichage ; normaliser la valeur studio avant comparaison.
- **Deux points de création de conversation** : factoriser via un helper pour ne pas en oublier un.
- **Worktrees = projets distincts** (assumé) : une conv d'un agent en worktree n'apparaît pas depuis le
  repo principal.
- **`root_path` disparu** (dossier déplacé/supprimé) : le sélecteur marque le projet indisponible sans
  planter.

## 9. Suite

Même fondation `project_id` réutilisée par : Phase 2 = mémoire projet + globale
(`.shugu/memory.md` + `~/.shugu/memory.md`, liées au projet) ; Phase 3 = `.shugu/` canonique + export
`.claude` (agents/MCP) + nettoyage (junction mort, dossiers vides, commentaire périmé 5→7). Chaque
phase : spec → plan → implémentation.
