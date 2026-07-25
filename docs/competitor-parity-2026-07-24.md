# Parité Claude Code / Codex — analyse comparative et plan de lots

Date : 24 juillet 2026. Source : dissection des installations réelles sur la machine
de référence (Codex desktop 26.721 + CLI 0.130.0-alpha.5, Claude Code 2.1.193),
croisée avec l'audit du code Shugu. Ce document alimente les lots P6.x de
`shugu-viability-roadmap.md`.

> Les colonnes « état Shugu » ci-dessous sont le **baseline avant exécution**
> des lots P6.1–P6.13, pas l'état courant du worktree. La source de vérité
> actuelle est `docs/shugu-viability-roadmap.md` (P6.12 validé le 25 juillet).

Réimplémentation uniquement : aucun code ni asset Anthropic/OpenAI n'est repris ;
seuls les mécanismes sont reproduits, avec l'esthétique Shugu et le contrat
local-first (SQLite source de vérité, aucun écran sans backend réel).

## 1. Inventaire Codex (OpenAI)

Architecture : CLI Rust (`codex.exe`, binaires auxiliaires `codex-command-runner`,
sandbox Windows élevée, `node_repl`, ripgrep bundlé), app desktop Electron
(packagée MSIX, fork interne « owl », UI Vite/React), runtime computer-use Node
(@oai/sky, Playwright, tesseract). Communication via `codex app-server`
(JSON-RPC stdio/ws).

Protocole app-server (extrait du binaire) :
- Thread : start/resume/fork/archive/list/read/compact/rollback/inject,
  tokenUsage, goal/*, memoryMode, backgroundTerminals, realtime (voix WebRTC).
- Turn : start/completed/interrupt/**steer**/plan/diff.
- Items : agentMessage(+delta), reasoning(+delta), commandExecution(+outputDelta,
  terminalInteraction), fileChange(+delta), plan, mcpToolCall(+progress),
  permissions, autoApprovalReview.
- Exécution : command/exec (+write/resize/terminate/wait) — PTY persistant ;
  approvals execCommandApproval/applyPatchApproval.
- MCP : tool/resource/elicitation/oauth/reload/startupStatus.
- Plugins/apps : plugin/list/read/install/uninstall/marketplace, app/list/web.

Plugins : manifeste `.codex-plugin/plugin.json` (description = instruction de
routing, skills, dépendances d'« apps » connecteurs, bloc `interface` riche) ;
skills = dossiers `SKILL.md` à frontmatter déclencheur sémantique + scripts/
assets/references. Marketplaces locales pinnées. Serveur `codex_apps`
(164 outils : github 89, sites 28, figma 27, calendar 12…) — infrastructure
cloud OpenAI, non réplicable.

État local : sessions JSONL (`rollout-*.jsonl` avec base_instructions,
token_count), SQLite `state_5` (threads : sandbox_policy, approval_mode,
tokens_used, agent_nickname, `thread_spawn_edges` = sub-agents,
`thread_dynamic_tools` à `defer_loading`), `goals_1.sqlite` (objectifs longs +
budget), `memories_1.sqlite`, `process_manager/chat_processes.json` (terminaux
d'arrière-plan par conversation).

UX distinctifs : follow-up queue (`followUpQueueMode: queue|steer|interrupt`,
Cmd/Ctrl+Shift+Enter = inverse ponctuel), modes de détail de conversation
(`STEPS_PROSE|STEPS_COMMANDS|STEPS_EXECUTION`), ambient suggestions,
notifications + son, Guardian approvals (révision auto des actions,
`item/autoApprovalReview`), worktrees au cœur de l'isolation, mascotte/pets,
ouverture vers 28 éditeurs, `show-context-window-usage`.

## 2. Inventaire Claude Code (Anthropic)

Binaire natif unique (Bun compilé, auto-updater avec rétention de 3 versions).
Config `~/.claude/settings.json` (+ `.local`, projet, policy admin).

- **Permissions** : trois listes `allow/ask/deny` × motifs sur outil+arguments
  (`Bash(git diff:*)`, `WebFetch(domain:…)`, `mcp__serveur__*`) ; précédence
  deny > ask > allow ; six modes (`default/plan/acceptEdits/auto/dontAsk/
  bypassPermissions`).
- **Hooks** : événements `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PreCompact`, `Stop` (+ Notification, SubagentStop,
  SessionEnd). Matcher regex sur nom d'outil, `timeout`, `async`, `asyncRewake`
  (le résultat d'un hook async réveille l'agent), sortie JSON
  `additionalContext` injectée dans la conversation, hooks `Stop` pouvant
  bloquer la fin de tour.
- **Plugins** : marketplaces git pinnées SHA ; plugin = manifeste
  `.claude-plugin/plugin.json` minimal + contributions conventionnelles
  (`commands/*.md`, `agents/*.md` avec `tools:`/`model:`/`color:`,
  `skills/*/SKILL.md`, `hooks/hooks.json`, `.mcp.json` en attente
  d'approbation, output styles, LSP).
- **Skills** : `description` du frontmatter = déclencheur sémantique ; listing
  injecté, corps chargé paresseusement.
- **Sessions** : JSONL par projet, arbre chaîné `parentUuid` (fork/resume/
  sidechains subagents), `usage` détaillé (cache 1h/5m, service_tier…),
  `queue-operation` (file de prompts), attachments (hooks, plan_mode,
  diagnostics…).
- **Rewind** : `file-history/` = snapshots de fichiers avant Edit/Write,
  couplés au fork de transcript → rewind double (conversation + fichiers).
- **Divers** : statusline commande externe, agent teams multi-modèles,
  auto-mode classifieur, plan mode tracé, worktrees `-w`, `doctor`, voix,
  remote control.

## 3. Matrice d'écarts Shugu

| Capacité | Claude/Codex | Shugu (preuve) | Lot |
|---|---|---|---|
| File de suivi / steer / interrupt pendant un run | Les deux (queue-operation, turn/steer) | **Absent** — envoyer pendant un run lance un flux concurrent (`views-chat.tsx`, `agents/mod.rs`) | P6.1 |
| Comptabilité tokens / coût | Les deux (`usage` détaillé, tokenUsage) | **Absent** — `tokens_used: None` en dur (`runner.rs:1495,1928`) | P6.2 |
| Indicateur fenêtre de contexte / compaction visible | Les deux (show-context-window-usage) | **Partiel** — événement `MemoryCompacted` émis sans consommateur UI (`mod.rs:397`) | P6.2 |
| Rewind checkpoints par tour | Les deux (file-history + fork, thread/rollback) | **Partiel** — backend complet (`snapshot.rs:374-398`, checkpoint auto `runner.rs:1354`), aucune UI | P6.3 |
| Hooks lifecycle utilisateur | Claude (8 événements, asyncRewake), Codex (flag hooks) | **Absent** (`lifecycle.rs` = contrat interne, pas de hooks) | P6.4 |
| Notifications OS natives | Les deux (+ son) | **Partiel** — toasts in-app seulement, pas de tauri-plugin-notification | P6.5 |
| Modes de détail de conversation | Codex (3 modes) | **Absent** (un seul rendu) | P6.6 |
| Plugins manifestés + marketplaces | Les deux (convention répertoires) | **Absent** — agent defs `.md` et MCP seulement | P6.7 |
| Skills fichiers SKILL.md sémantiques | Les deux | **Partiel** — skills apprises SQLite vérifiées (`skills.rs`), pas de fichiers SKILL.md | P6.8 |
| Shell persistant / terminaux background | Les deux (exec PTY, backgroundTerminals) | **Partiel** — process jetable par commande (`exec.rs`) ; PTY dock utilisateur seulement | P6.9 |
| Permissions allow/ask/deny par motifs d'arguments | Claude (3 listes × motifs) | **Partiel** — allow/deny par pattern de commande (`command_rules.rs`), pas de ask ni motifs d'arguments | P6.10 |
| Sub-agents parallèles | Codex (thread_spawn_edges), Claude (teams) | **Partiel** — `delegate` séquentiel (`runner.rs:2941`) ; 4 runs concurrents max | P6.11 |
| Outils LSP pour agents | Claude (plugins *-lsp) | **Partiel** — LSP éditeur seulement (`lsp.rs`), aucun outil agent | P6.12 |
| Auto-update | Les deux | **Absent** | P6.13 |
| Fork/resume de conversation | Les deux (parentUuid, thread/fork) | **Partiel** — conversations persistées, pas de fork ; runs en vol non repris (honnête) | P6.3 |
| Approbations graduées / sandbox | Les deux | **Présent** — profils Chat/Plan/Auto/Full Access, sandbox LOW Windows (P0.x validés) | — |
| Worktrees isolation | Les deux | **Présent** — P3.1 validé | — |
| MCP | Les deux | **Présent** — effets typés, OAuth à durcir (P1.6) | P1.6 |
| Computer-use / connecteurs cloud / app directory | Codex (infra OpenAI) | **Hors scope** — non réplicable localement ; équivalents : `browser_test`, MCP GitHub | — |

## 4. Traçabilité des lots P6.x

Les lots P6.1 à P6.13 correspondent aux lots 1 à 13 du plan approuvé
(fichier plan de session, 24 juillet 2026). Chaque lot livre backend + UI +
tests, avec les gates standards (typecheck, vitest, lint, build, cargo,
ui:tour, native:smoke pour les lots runtime). Les états sont suivis dans
`shugu-viability-roadmap.md`.
