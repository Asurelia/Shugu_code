# Partition des conversations par projet — Design (Phase 1)

- **Date** : 2026-07-05
- **Statut** : design validé, en attente de relecture avant plan d'implémentation
- **Périmètre** : Phase 1 d'un chantier plus large « Mémoire & données scopées par projet »

---

## 1. Problème

La base `shugu.db` est un **ramasse-tout global**. Concrètement :

- La table `conversations` a une colonne `project_id` qui pointe vers une table `projects`
  **cosmétique et 100 % morte** (`name`/`color`/`sort_order` jamais lus ni écrits — vestige MVP).
- Les « groupes » de la sidebar sont **en mémoire seule** (`SEED_GROUPS`, état React), **remis à zéro
  à chaque reload** (`chat-sidebar.tsx:65`). Aucune persistance solide.
- Les conversations sont lues via `db.conversations.listNested()` **sans aucun filtre workspace**
  (`db.ts:334`) → **toute la soupe s'affiche quel que soit le dossier ouvert.**
- Il existe **deux notions de « projet » déconnectées** : le `workspace_root` (le vrai dossier ouvert,
  déjà utilisé par `studio_projects` V8, les fichiers, le git) et cette étiquette colorée manuelle.

Résultat, du point de vue utilisateur : « les conversations ne sont pas vraiment liées à leur projet,
c'est un ramasse-tout sans logique ».

## 2. Objectif

Les conversations (et donc leurs messages) doivent être **scopées au dossier réellement ouvert**
(`workspace_root`), façon Claude Code (qui range l'historique par chemin de projet). Ouvrir le dossier A
ne montre que les conversations de A ; ouvrir B bascule sur celles de B ; une vue « Tous » permet de
tout revoir.

### Décisions produit (validées)

1. **`.shugu/` canonique** (Phase 3) — hors périmètre ici, mais oriente l'ensemble.
2. **Conversations dans la base globale, partitionnées par `workspace_root`** — pas de base par projet
   (modèle Claude Code : stockage global, clé = chemin de projet).
3. **Identité projet = chemin exact du dossier.** Un worktree est un projet distinct (comme Claude Code).
   Pas de résolution de racine git en Phase 1.
4. **Vue « Projet courant » stricte** : uniquement `workspace_root = dossier ouvert`. Les conversations
   globales/legacy (`workspace_root IS NULL`) n'apparaissent que dans l'onglet « Tous ».

## 3. Non-objectifs (Phase 1)

- **Ne pas** persister les groupes colorés (`project_id`) — laissés tels quels comme sous-groupe optionnel
  *dans* un projet. Persistance des groupes = éventuelle phase ultérieure.
- **Ne pas** toucher à Convex (schéma cosmétique, jamais appelé depuis le TS pour les conversations).
- **Ne pas** scoper `agents`/`agent_events` explicitement (ils héritent via `conversation_id`).
- **Ne pas** dénormaliser `workspace_root` sur `messages` (ils sont toujours lus par `conversation_id`,
  donc déjà scopés par héritage — YAGNI).
- **Ne pas** auto-assigner les conversations legacy à un dossier (on ignore leur provenance — honnête).
- **Ne pas** unifier repo + worktrees (décision #3).

## 4. Le modèle de scoping

```
conversation.workspace_root = "C:/Dev/shugu_code"
   └─ clé = chemin d'AFFICHAGE : sans préfixe \\?\, séparateurs '/'
      = exactement ce que renvoie fsGetWorkspaceRoot()  (source unique, déjà normalisée)

  • ouvre dossier A  → sidebar ne montre que les convs de A
  • ouvre dossier B  → sidebar bascule sur les convs de B
  • chat sans dossier → workspace_root = NULL → bucket « Global / Sans projet »
  • bouton « Tous »   → montre tout (toutes workspaces + global)

  messages → hérités via conversation_id  (AUCUN changement de schéma)
```

**Point clé de cohérence** : la clé stockée est la **forme d'affichage** (préfixe Windows `\\?\` retiré,
`/`), telle que `fsGetWorkspaceRoot()` / l'event `workspace://changed` la fournissent côté TS. On évite
ainsi le piège récurrent du préfixe `\\?\`. NB : `studio_projects` stocke, lui, la forme canonique
Rust (avec `\\?\`) car il ne fait ses requêtes qu'en Rust. Les deux systèmes ne se croisent pas — on ne
tente PAS d'unifier ces deux formes en Phase 1 (noté comme divergence connue, sans impact fonctionnel).

## 5. Design détaillé

### 5.1 Schéma — migration V18 (additive & immuable)

Nouvelle migration `MIGRATION_V18` (on **n'édite jamais** une migration déjà appliquée — checksum) :

```sql
ALTER TABLE conversations ADD COLUMN workspace_root TEXT;               -- nullable = legacy/global
CREATE INDEX IF NOT EXISTS idx_conversations_ws
    ON conversations(workspace_root, updated_at);
DROP TABLE IF EXISTS projects;                                         -- table morte, zéro perte
```

- Enregistrer la migration dans le tableau `migrations` de `lib.rs` (version 18).
- **Bumper `TARGET_SCHEMA_VERSION` → 18** dans `backup.rs` (le `debug_assert` de `lib.rs:580` l'exige,
  et garantit qu'un backup pré-migration est pris).
- **Sécurité verrou/boot** : `ADD COLUMN` est O(1) (métadonnée, pas de réécriture de lignes) ;
  `CREATE INDEX` est léger. **Aucun `UPDATE` de masse, aucune grosse transaction au boot** → respecte
  la contrainte connue (migration lazy ~2 s + `busy_timeout` 5 s sans retry).

### 5.2 Écriture — création scopée

Deux points de création existent ; **les deux** stampent `workspace_root` en lisant le workspace courant
(`fsGetWorkspaceRoot()`), `NULL` si aucun dossier n'est ouvert :

- `newConvo()` — `chat-sidebar.tsx:336`
- `createConversation()` — `chat-sync.ts:1438`

`db.ts` reste une **couche de données pure** : le champ `workspace_root` est ajouté à `ConversationRow`
et à `db.conversations.create(row)` ; le *caller* fournit la valeur (jamais `db.ts` qui appelle
`fsGetWorkspaceRoot`). Un petit helper partagé (ex. `newConversationRow({ title })`) peut factoriser la
lecture du workspace pour éviter la divergence entre les deux points de création.

### 5.3 Lecture — sidebar filtrée + vue « Tous »

- `db.conversations.list()` / `listNested()` prennent un paramètre `workspaceRoot?: string | null` :
  - chaîne non vide → `WHERE workspace_root = $1` (vue « Projet courant », **stricte**),
  - `null` (aucun dossier ouvert) → `WHERE workspace_root IS NULL` (le « projet courant » est alors le
    bucket global — comportement voulu quand on chatte sans dossier),
  - sentinelle `"__all__"` → pas de filtre workspace (vue « Tous »).
- La sidebar lit le workspace courant via la query TanStack déjà existante `fsKeys.workspaceRoot()`
  (`views-chat.tsx:155`) et le passe au filtre.
- Nouveau switch d'en-tête de sidebar : **« Projet courant / Tous »** (2 états).
- La query key du chat inclut le `workspaceRoot` (variante de `chatKeys.conversations`) pour un cache
  correct par projet.

### 5.4 Rafraîchissement au changement de dossier

Le listener `workspace://changed` de `RootLayout.tsx:665` invalide déjà les caches scopés (git, arbre
fichiers, workspaceRoot). **Ajouter** l'invalidation de la query conversations
(`chatKeys.conversations`). Bascule de dossier ⇒ la sidebar se met à jour automatiquement.

## 6. Fichiers touchés (prévision)

| Fichier | Changement |
|---|---|
| `src-tauri/src/lib.rs` | Ajouter `MIGRATION_V18` + entrée `Migration { version: 18, … }` |
| `src-tauri/src/commands/backup.rs` | `TARGET_SCHEMA_VERSION` 17 → 18 |
| `src/lib/db.ts` | `ConversationRow.workspace_root` ; `create()` ; `list()`/`listNested()` param `workspaceRoot` ; **supprimer** le CRUD mort `db.projects.*` (db.ts:489-512) qui pointait vers la table droppée |
| `src/features/chat/chat-sync.ts` | `createConversation()` stampe `workspace_root` |
| `src/features/chat/chat-sidebar.tsx` | `newConvo()` stampe `workspace_root` ; switch « Projet courant / Tous » ; filtre |
| `src/features/chat/keys.ts` | `chatKeys.conversations(workspaceRoot)` |
| `src/routes/RootLayout.tsx` | Invalider `chatKeys.conversations` dans le listener `workspace://changed` |

## 7. Plan de test

- **Rust (headless, `cargo test` via vcvars64)** : migration V18 idempotente ; base V17→V18 conserve les
  conversations existantes (`workspace_root` NULL) ; `TARGET_SCHEMA_VERSION` == dernière migration
  (`debug_assert`).
- **Manuel / GUI (l'utilisateur juge au rendu)** :
  1. Ouvrir dossier A, créer 2 conversations → visibles.
  2. Ouvrir dossier B → la sidebar ne montre que les convs de B (les 2 de A disparaissent).
  3. Re-ouvrir A → les 2 convs de A reviennent.
  4. Onglet « Tous » → A + B + legacy visibles ensemble.
  5. Chat sans dossier ouvert → conv en « Global », absente de la vue « Projet courant » de A/B.
  6. Les conversations d'avant migration apparaissent dans « Tous » (legacy), jamais perdues.

## 8. Risques & points de vigilance

- **Migration immuable** : ne jamais rééditer une `MIGRATION_Vx` déjà livrée (checksum SHA-384 → base
  front morte). V18 est purement additive.
- **Verrou SQLite au boot** : pas d'écriture massive dans la migration (cf. §5.1).
- **Préfixe `\\?\`** : toujours stocker/filtrer sur la forme d'affichage (`fsGetWorkspaceRoot()`), jamais
  la forme canonique Rust.
- **Deux points de création** : risque d'en oublier un → factoriser via un helper partagé.
- **Worktrees = projets distincts** (décision assumée) : une conversation démarrée pendant qu'un agent
  travaille dans un worktree n'apparaîtra pas depuis le repo principal. Acceptable en Phase 1 ;
  réévaluable si gênant.

## 9. Suite

Phase 2 = mémoire projet + globale (`.shugu/memory.md` + `~/.shugu/memory.md`). Phase 3 = `.shugu/`
canonique + export `.claude` (agents/MCP) + nettoyage (junction mort, dossiers vides, commentaire
périmé 5→7). Chaque phase : spec → plan → implémentation propre.
