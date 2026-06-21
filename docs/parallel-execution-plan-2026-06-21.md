# Plan d'exécution parallèle — N instances Claude Code

Date : 2026-06-21
Référence : [`gap-audit-consolidated-2026-06-21.md`](./gap-audit-consolidated-2026-06-21.md)

But : découper le backlog en **lanes à fichiers disjoints**, chacune exécutable par une **instance Claude Code séparée dans son propre worktree git**, sans conflit de merge.

---

## 0. Règle d'or & pièges à connaître AVANT de lancer

1. **Une lane = un worktree = une branche = une instance Claude Code.** Aucune lane n'édite un fichier « possédé » par une autre.
2. **Fichiers partagés à risque** (édités par plusieurs lanes) → règles de coordination en §2. Le principal est `src-tauri/src/lib.rs` (enregistrement des commandes Tauri).
3. **⚠️ PIÈGE RUST — le dossier `target/` fait 23 Go.** N worktrees Rust = N × 23 Go (≈ 160 Go pour 7 lanes). **Solution obligatoire** : un `target/` partagé via variable d'env, AVANT de lancer les builds :
   ```bash
   # dans chaque worktree Rust, ou globalement (PowerShell : $env:CARGO_TARGET_DIR="F:\Dev\.shugu-target-shared")
   export CARGO_TARGET_DIR="F:/Dev/.shugu-target-shared"
   ```
   Compromis : `cargo` **sérialise** les builds concurrents sur un target partagé (lock). C'est voulu — disque > vitesse de build ici. (Alternative haut de gamme : `sccache`.)
4. **Frontend lanes = parallélisme libre** (node_modules ≈ 0,2 Go/worktree, pas de target). Les lanes Rust sont les coûteuses.
5. **Nettoie d'abord les 57 Go** (voir Lane 0) — sinon tu empiles des worktrees sur 57 Go de déchets.
6. **Gate avant merge de CHAQUE lane** : `pnpm typecheck` + `pnpm test` + (si Rust touché) `cargo check`/`cargo test`.

### Setup d'un worktree (modèle)
```bash
cd F:/Dev/shugu_code
git worktree add ../shugu-<lane> -b lane/<lane>
cd ../shugu-<lane>
pnpm install
export CARGO_TARGET_DIR="F:/Dev/.shugu-target-shared"   # si lane Rust
# puis : lancer `claude` dans ce dossier et coller le prompt de la lane
```

---

## 1. Carte des vagues

```
VAGUE 0 (séquentielle, à faire en 1er) : Lane 0 — nettoyage worktrees/disque

VAGUE 1 (toutes parallèles, fichiers disjoints) :
  Lane 1  Exec security (Rust)          owns: exec.rs, tools.rs(run_command), +policy.rs
  Lane 2  Tauri+network hardening       owns: tauri.conf.json, capabilities/, chat.rs
  Lane 3  Mémoire (Rust)                owns: runner.rs, +memory.rs, vector.rs, skills/lessons
  Lane 4  Worktree+snapshot (Rust)      owns: +worktree.rs, +snapshot.rs (modules autonomes)
  Lane 5  Trust UX (Front)              owns: AgentsPanel, views-chat, ModeSelector, +primitives
  Lane 6  MCP inventory (full-stack)    owns: mcp.rs, McpServersSection, Connections
  Lane 7  Éval harness (nouveau)        owns: evals/ (100% nouveau)

VAGUE 2 (après vague 1) :
  Lane 8  Quality gates (lint/e2e/audit) · Lane 9 A11y+CSS · Lane 10 Opérabilité (Diag/Storage/Backup/Privacy)
```

**Pourquoi ces frontières tiennent** : Lane 1 borne l'exécution dans `tools.rs`/`exec.rs` **sans toucher `runner.rs`** (possédé exclusivement par Lane 3). Lane 4 livre des **modules autonomes** (`worktree.rs`, `snapshot.rs`) ; le câblage `snapshot()` dans `runner.rs` est une tâche de 5 lignes confiée à **Lane 3** (qui possède `runner.rs`), ou faite à l'intégration. Les lanes 2, 5, 6, 7 sont naturellement disjointes.

---

## 2. Fichiers partagés & règles de coordination

| Fichier partagé | Lanes concernées | Règle |
|---|---|---|
| `src-tauri/src/lib.rs` (`invoke_handler!`) | 1, 3, 4, 6, 7 | **Append-only** : chaque lane ajoute SES entrées de commande. Conflits = lignes additives triviales. **Ordre de merge** ci-dessous pour les résoudre une fois. |
| `src-tauri/src/commands/agents/runner.rs` | 3 (exclusif) | Lane 1 NE touche PAS runner.rs (risk-gate vit dans `tools.rs`). Lane 4 NE touche PAS runner.rs (le câblage snapshot est délégué à Lane 3). |
| `src-tauri/src/commands/agents/tools.rs` | 1 (exclusif) | Lane 3 n'ajoute aucun outil dans tools.rs (la mémoire vit dans runner.rs/memory.rs). |
| `package.json` (scripts) | 7, 8 | Additif (scripts distincts : `test:eval` vs `lint`/`test:e2e`). |
| `src/routes/RootLayout.tsx` | 5 (exclusif si besoin) | Si un badge shell est requis, **seule Lane 5** y touche. |

**Ordre de merge recommandé** (minimise les rebases sur `lib.rs`) :
`Lane 0 → 2 → 1 → 4 → 3 → 6 → 7 → 5` puis vague 2.
(Config/standalone d'abord, `runner.rs`/mémoire ensuite, front en dernier.)

---

## 3. Les lanes (périmètre + prompt prêt-à-coller)

> Chaque prompt suppose : instance Claude Code lancée DANS le worktree de la lane. Remplace `<…>` si besoin.

### Lane 0 — Nettoyage worktrees & disque (à faire en 1er, sur `main`)
- **Possède** : rien (opération git/FS).
- **Livrables** : rapport des 6 orphelins (`great-hellman`, `dazzling-kepler`, `frosty-liskov`, `naughty-mcnulty`, `upbeat-jemison`, `beautiful-volhard`) + suppression APRÈS validation ; `target/` réduit.
- **Prompt** :
  > Travaille sur `F:\Dev\shugu_code`. Objectif : récupérer de l'espace SANS rien perdre. 1) Pour chaque worktree dans `.claude/worktrees/`, distingue ceux trackés par `git worktree list` de ceux qui ne le sont pas. 2) Pour les 6 non-trackés (great-hellman, dazzling-kepler, frosty-liskov, naughty-mcnulty, upbeat-jemison, beautiful-volhard) : pour chacun, vérifie présence `.git`, `git -C <path> status`, dernier commit, branche, et s'il contient des changements non commités/non poussés. Produis un tableau {path, taille, branche, commits non poussés, verdict: SÛR-À-SUPPRIMER / À-INSPECTER}. 3) NE SUPPRIME QUE ceux marqués SÛR, après avoir affiché le tableau et demandé confirmation. 4) `git worktree prune` puis rapport d'espace libéré. Ne touche à aucun fichier source.

### Lane 1 — Exec security (Rust) · P0-a
- **Possède** : `src-tauri/src/commands/agents/exec.rs`, `src-tauri/src/commands/agents/tools.rs` (uniquement le dispatch `run_command`), **nouveau** `src-tauri/src/commands/agents/policy.rs`.
- **Partagé** : `lib.rs` (append handler).
- **Interdit** : `runner.rs`.
- **Livrables** : `enum ExecutionPolicy { ReadOnly, WorkspaceWrite, FullLocal }` ; `CommandRisk` (classifieur : `rm -rf`, `del /s`, `format`, `curl|sh`, `git push --force`, écriture hors workspace → DANGER ; reste → SAFE auto) ; risk-gate dans `run_command` (auto-run SAFE, signale DANGER via un `ToolResult`/event d'approbation — PAS de prompt bloquant systématique) ; **kill process-tree Windows via Job Object** ; log structuré {commande, cwd, policy, réseau, risque}. Tests Rust.
- **Prompt** :
  > Implémente une couche `ExecutionPolicy` pour le moteur agent (voir `docs/gap-audit-consolidated-2026-06-21.md` §3 P0-a). Périmètre STRICT : `src-tauri/src/commands/agents/exec.rs`, le dispatch `run_command` dans `agents/tools.rs`, et un nouveau `agents/policy.rs`. NE TOUCHE PAS `runner.rs`. Objectif UX : **fluide** — auto-run des commandes sûres, signalement (pas blocage) des dangereuses. Ajoute un kill process-tree Windows (Job Object) car le timeout actuel laisse survivre les descendants. Enregistre toute nouvelle commande Tauri dans `lib.rs` (append). Gates : `cargo check` + `cargo test` (VS Dev env, voir AGENTS.md). Ajoute des tests unitaires Rust pour le classifieur de risque.

### Lane 2 — Tauri + network hardening · P0-d / P1-e
- **Possède** : `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/commands/chat.rs` (allowlist `base_url`).
- **Livrables** : CSP stricte (remplacer `csp:null`) ; capabilities granulaires (retirer `shell:default`/`fs:default` si l'app boote sans) ; allowlist d'origins `base_url` + blocage IP privée/link-local + warning HTTP non-TLS + log provider/base_url par conversation.
- **Prompt** :
  > Durcis la surface renderer/réseau (voir consolidated §2/§3 P0-d). Périmètre STRICT : `src-tauri/tauri.conf.json` (CSP stricte au lieu de `null`), `src-tauri/capabilities/default.json` (permissions granulaires, tente de retirer `shell:default` et `fs:default` et vérifie que l'app démarre + que les commandes internes marchent), `src-tauri/src/commands/chat.rs` (allowlist `base_url` du provider `custom` : bloque localhost/IP privées/link-local sauf override explicite, warn si HTTP). Gate : `cargo check` + démarrage app OK. Documente toute capability retirée.

### Lane 3 — Mémoire orchestrée (Rust) · P1-c / AM-2
- **Possède** : `src-tauri/src/commands/agents/runner.rs`, **nouveau** `agents/memory.rs`, `src-tauri/src/commands/vector.rs`, `agents/skills.rs`, `agents/lessons.rs`.
- **Partagé** : `lib.rs` (append). **Reçoit** de Lane 4 : appel `snapshot::checkpoint()` à câbler en début de tour (5 lignes).
- **Livrables** : bus mémoire (couches working/episodic/procedural/semantic/compaction) ; hooks `recall()` avant tour / `remember()` après ; **compaction→épisodique** (résumer les vieux tours et les ÉCRIRE en mémoire au lieu de droper à 30 msgs) ; étendre le vecteur aux conversations+résumés (pas que le code) ; **surfacer les échecs d'indexation** (plus de `console.warn` muet → event/toast).
- **Prompt** :
  > Implémente la mémoire orchestrée (voir consolidated §3 P1-c et §0 AM-2). Périmètre : `agents/runner.rs` (possédé en exclusif), nouveau `agents/memory.rs`, `vector.rs`, `agents/skills.rs`, `agents/lessons.rs`. Ajoute 2 hooks dans la boucle : `recall()` avant le tour (top-k de {épisodique, sémantique, skills, lessons}) et `remember()` après. Remplace le drop brut à `MAX_HISTORY_MESSAGES` par une **compaction qui résume et écrit le résumé en mémoire épisodique**. Étends l'index vectoriel aux conversations/résumés. Fais remonter les échecs d'indexation au lieu de les avaler. Quand Lane 4 a livré `snapshot.rs`, câble `snapshot::checkpoint()` en début de tour. Enregistre les commandes dans `lib.rs` (append). Gates : `cargo check`+`cargo test`+`pnpm test`.

### Lane 4 — Worktree/session lifecycle + snapshot/revert (Rust) · P1-a / P0-b
- **Possède** : **nouveaux** `src-tauri/src/commands/worktree.rs`, `src-tauri/src/commands/snapshot.rs`.
- **Partagé** : `lib.rs` (append). **Interdit** : `runner.rs` (le câblage est délégué à Lane 3).
- **Livrables** : commandes `worktree_create(thread_id)` / `list` / `cleanup` / `size` ; détection orphelins ; `snapshot::checkpoint()` (commit sur ref fantôme `refs/shugu/turn/<id>`) + `revert(turn_id)`. Modules **autonomes** (appellent le CLI git en sous-process, ne modifient pas `git.rs`).
- **Prompt** :
  > Crée deux modules Rust autonomes (voir consolidated §3 P1-a/P0-b). `src-tauri/src/commands/worktree.rs` : create/list/cleanup/size + détection orphelins (modèle `git-worktrees.json` de Claude Desktop). `src-tauri/src/commands/snapshot.rs` : `checkpoint()` = commit léger sur une ref fantôme `refs/shugu/turn/<id>` avant action agent, + `revert(turn_id)` pour annulation 1-clic. Appelle le CLI `git` en sous-process ; NE MODIFIE PAS `git.rs` ni `runner.rs`. Enregistre les commandes dans `lib.rs` (append). Expose une API claire pour que Lane 3 appelle `snapshot::checkpoint()`. Gates : `cargo check`+`cargo test`.

### Lane 5 — Trust UX + primitives (Front) · P0-c
- **Possède** : `src/features/agents/AgentsPanel.tsx`, `src/features/chat/views-chat.tsx`, `src/features/chat/ModeSelector.tsx`, **nouveaux** `src/components/RiskBadge.tsx`, `PermissionBadge.tsx`, `ExecutionProfileCard.tsx`, `ConfirmDialog.tsx`, `InlineNotice.tsx`, et `src/routes/RootLayout.tsx` si badge shell requis.
- **Livrables** : `ExecutionProfileBadge` permanent (Acting in / Files / Network / Rollback) ; risk card avant `Grounded Run` (remplacer le vert trompeur) ; contrat Ask/Plan/Act affiché par message agent ; `ConfirmDialog` à niveaux (normal/destructive/irreversible).
- **Prompt** :
  > Implémente l'« UX de confiance » (voir consolidated §3 P0-c et `ui-ux-gap-audit`). Périmètre : `features/agents/AgentsPanel.tsx`, `features/chat/views-chat.tsx`, `features/chat/ModeSelector.tsx`, et de NOUVELLES primitives sous `src/components/` (RiskBadge, PermissionBadge, ExecutionProfileCard, ConfirmDialog, InlineNotice). Le bouton `Grounded Run` (actuellement vert = paraît safe) doit devenir une carte de risque explicite. Remplace le chip `local` ambigu par un badge de permission. Affiche le mode (Ask/Plan/Act) dans chaque message agent, pas juste le composer. Utilise des `<button>` sémantiques. Gates : `pnpm typecheck`+`pnpm test`. (Ces composants liront l'`ExecutionPolicy` exposée par Lane 1 — code défensif si l'API n'est pas encore là.)

### Lane 6 — MCP inventory + import multi-source · P1-b
- **Possède** : `src-tauri/src/commands/mcp.rs`, **nouveaux** adapters Rust, `src/features/mcp/McpServersSection.tsx`, `src/features/connections/Connections.tsx`.
- **Partagé** : `lib.rs` (append).
- **Livrables** : adapters `ClaudeDesktopMcpSource` / `CodexTomlMcpSource` / `OpenCodeMcpSource` (lecture des configs réelles : `Roaming\Claude\claude_desktop_config.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`) + dedup + secrets keychain ; UI inventaire (Source/Type/Status/Tools/Risk/provenance).
- **Prompt** :
  > Implémente l'inventaire + import MCP multi-source (voir consolidated §3 P1-b, audit RE §MCP). Périmètre : `commands/mcp.rs` + adapters Rust, `features/mcp/McpServersSection.tsx`, `features/connections/Connections.tsx`. Lis (sans modifier) les configs Claude/Codex/OpenCode listées dans l'audit, dédup par nom/type/command/url, migre les secrets vers le keychain (`cred_*`), surface les erreurs de parsing. UI : tableau Source/Nom/Type/Enabled/Tools/Secrets/Risk + badges de provenance. Enregistre commandes dans `lib.rs` (append). Gates : `cargo check`+`pnpm typecheck`+`pnpm test`.

### Lane 7 — Harness d'éval agent (NOUVEAU, 100% isolé) · P1-d / AM-1
- **Possède** : **nouveau** `evals/` (runner, tâches golden, fixtures), `package.json` (script `test:eval` uniquement).
- **Livrables** : un jeu de tâches golden (ex. « ajoute un outil X », « corrige le bug Y dans la fixture Z ») ; un runner qui invoque l'agent Shugu **en headless** sur chaque tâche, applique dans un dossier jetable, vérifie le résultat (commande de test passe), produit un **scorecard pass/fail** + base de non-régression.
- **Prompt** :
  > Crée un harness d'évaluation de l'agent (voir consolidated §0 AM-1, §3 P1-d) — c'est l'angle mort n°1 : personne n'a mesuré si l'agent code bien. Périmètre 100% NOUVEAU : dossier `evals/`. Conçois 8-12 tâches golden réalistes (chacune = prompt + dossier fixture + commande de vérif qui doit passer). Écris un runner qui lance l'agent Shugu headless sur chaque tâche dans un dossier temporaire jetable, puis exécute la vérif et produit un scorecard {tâche, pass/fail, durée, itérations, tokens}. Ajoute `"test:eval"` dans `package.json` (script additif uniquement). Établis une baseline. Gates : le harness tourne et produit un scorecard.

### Vague 2 (après vague 1)
- **Lane 8 — Quality gates** : `package.json` (`lint`, `test:e2e`), config Playwright Tauri, `pnpm audit`/`cargo audit`. *Coordonne `package.json` avec Lane 7 (scripts distincts).*
- **Lane 9 — A11y + CSS** : `src/styles/*.css` (`transition:all`→ciblé, `:focus-visible`, `prefers-reduced-motion`) + conversion `div/span`→`button` dans les fichiers NON possédés par Lane 5. *Lancer après que Lane 5 a figé ses composants.*
- **Lane 10 — Opérabilité** : Diagnostics Center / Storage Center / Backup-Restore / Privacy+redaction (nouvelles features, surtout nouveaux fichiers).

---

## 4. Checklist par instance avant merge
- [ ] `pnpm typecheck` OK
- [ ] `pnpm test` OK
- [ ] `cargo check` + `cargo test` OK (si Rust touché, via VS Dev env)
- [ ] Aucun fichier hors périmètre modifié (`git diff --name-only` ⊆ périmètre de la lane)
- [ ] Commandes Tauri ajoutées en append dans `lib.rs`
- [ ] Merge dans l'ordre : `0 → 2 → 1 → 4 → 3 → 6 → 7 → 5`
