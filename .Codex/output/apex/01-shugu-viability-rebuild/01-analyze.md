# Step 01: Analyze

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Context Discovery

### Architecture observée

- Application Tauri 2 native, React 18, TanStack Router en mémoire et composition globale dans `src/routes/RootLayout.tsx`.
- Backend Rust découpé en 40 domaines de commandes, 19 migrations SQLite et 158 commandes enregistrées dans `src-tauri/src/lib.rs`.
- Le frontend contient les surfaces Chat, Code, Git, Image, Studio, Agents, Gallery, Settings, Profile et Connections.
- Le dépôt comprend 63 fichiers de test identifiés et deux bancs distincts : Vitest/Rust d’une part, un harness d’évaluation agents d’autre part.

### Runtime agentique existant

- Une vraie boucle `LLM → tool_calls → exécution → tool_results → LLM` existe dans `src-tauri/src/commands/agents/runner.rs:1724`, avec un budget de 24 tours.
- Les agents, événements, messages assemblés, outils, résultats et états terminaux sont persistés dans SQLite (`src-tauri/src/commands/agents/mod.rs:750`).
- Trois modes existent : Chat, Plan et Agent (`src/features/chat/chat-sync.ts:1454`). Plan retire les outils mutants natifs ; Agent travaille par défaut directement dans le checkout réel (`src/features/chat/chat-sync.ts:1039`).
- Skills, leçons validées, mémoire vectorielle, compaction, advisor, délégation, `todo_write`, `ask_user` et `submit_plan` sont déjà présents.
- La FSM persistée reste limitée à `pending/running/complete/error/killed`; les phases orient/plan/execute/verify/review ne sont pas représentées dans l’état durable.
- Une sortie sans `tool_calls` termine immédiatement le run (`runner.rs:2053`), indépendamment de l’existence d’un plan, d’une modification ou d’un test réussi.
- L’isolation worktree existe mais est opt-in et best-effort ; un échec d’isolation continue in-place (`runner.rs:1068`).
- Le sandbox Windows LOW-integrity est fail-open (`sandbox.rs:78-97`). Les niveaux de danger et règles allow/deny sont actuellement consultatifs : ils modifient l’affichage, pas la décision d’exécution.
- Un redémarrage marque les runs actifs comme orphelins en erreur ; aucune reprise de l’état de boucle n’existe (`agents/mod.rs:667`).

### Prompts et modèles

- Des prompts spécialisés existent pour orchestrateur, Plan, Grounded, Atelier, Studio, advisor, sous-agent et compaction (`runner.rs:2952-3027`).
- Les obligations de planifier, lire, modifier, tester et revoir sont principalement textuelles dans le prompt orchestrateur (`runner.rs:3024`).
- Les prompts citent `npm`/`npx` et Atelier prescrit `npm install`, en contradiction avec les règles pnpm-only du dépôt (`runner.rs:2973-2989`).
- Le runner agent supporte le tool-calling Anthropic et OpenAI/custom. Ollama est text-only et le protocole Codex n’est pas accepté par le runner (`runner.rs:2715-2752`).
- Le bridge Codex app-server est réel pour le chat : processus persistant JSON-RPC, auth, modèles, efforts, limites et streaming (`src-tauri/src/commands/codex_app_server.rs:1`). Son chemin courant démarre en lecture seule et ne traite pas les requêtes serveur d’approbation.

### Intégrations et données

- Les providers chat, image et média sont réellement routés, mais les catalogues frontend et Rust sont maintenus séparément (`src/lib/providers.ts:90`, `src-tauri/src/commands/models.rs:20`).
- Claude Code est couvert par le format `.claude/agents/*.md`; seuls le rôle, le modèle et le body sont réellement consommés. Le champ `tools` et l’état `enabled` ne contraignent pas le runner.
- MCP stdio/HTTP est réel, fusionné dans les outils chat/agents et protégé contre l’injection de contenu. Le mode Plan ne connaît toutefois pas les effets des outils MCP.
- Les sources MCP Claude Desktop, Codex et OpenCode sont importées ; aucun adaptateur Cursor n’existe. OpenCode n’a pas de backend agent dédié.
- Les credentials providers utilisent le keychain natif ; SQLite n’est pas chiffré. Les sauvegardes utilisent `VACUUM INTO`, un manifest et `PRAGMA integrity_check`.
- Le seed d’une base neuve injecte encore des conversations et messages de démonstration (`src/lib/db.ts:1038`).

### Vérité produit et UI native

- Settings mélange état réel, état de session et valeurs statiques dans `src/features/code/views-code.tsx`.
- General et Image Generation sont session-only ; Models & Keys affiche des modèles et connexions codés en dur ; Privacy prétend un chiffrement AES-256 absent ; About affiche une version et une plateforme fictives.
- Image appelle réellement son backend et persiste les générations. Vidéo et Musique appellent de vrais backends mais ne persistent pas leurs résultats.
- La surface `.image-shell` absolue recouvre les onglets média dans le binaire natif (`src/styles/styles.css:740`).
- Gallery lit les vraies générations mais rend des fallbacks `unknown/no file`; ses dossiers latéraux sont un seed immuable (`src/mocks/seedGalleryFolders.ts:3`).
- Plusieurs contrôles sont non sémantiques : switches en `<div>`, cartes cliquables non clavier, champs média et Connections sans labels associés.

### Tests existants

- Les gates locales constatées passent : 543 tests Vitest et 394 tests Rust, soit 937 tests automatisés.
- 111 tests Rust ciblent policy/exec/sandbox/tools/runner/plan/worktree/snapshot, mais aucun n’exécute le cycle complet `agent_spawn → tool_use_loop → agent_continue/kill`.
- Le harness `pnpm test:eval` est un self-check des solutions de référence sans appel modèle (`evals/run.mjs:17`).
- L’unique E2E Playwright est explicitement un smoke navigateur sans Tauri (`playwright.config.ts:3-25`) et utilise `npm run` malgré la règle pnpm-only (`playwright.config.ts:62`).
- Aucun test natif ne couvre les parcours Settings, Connections, média, cycle agent complet, reprise crash, keychain, MCP live ou Codex app-server live.

## Inferred Acceptance Criteria

- AC1 : chaque état présenté par l’UI provient d’une capacité ou donnée réelle ; aucune connexion, sécurité, version, quota ou fonctionnalité fictive ne reste affichée.
- AC2 : le runtime impose un cycle agentique observable et durable, et ne déclare pas un travail vérifié sans preuves d’exécution correspondantes.
- AC3 : Chat, Plan, Auto et Full Access possèdent des politiques d’outils et d’exécution explicites, appliquées côté Rust et persistées par workspace/session.
- AC4 : le mode autonome normal n’interrompt pas l’utilisateur pour les actions ordinaires dans le workspace ; le mode Full Access n’émet aucune demande par commande après activation explicite.
- AC5 : l’isolation, les snapshots, l’annulation, la reprise et la terminaison des processus ont un comportement déterministe, sans fallback silencieux.
- AC6 : chaque provider proposé expose honnêtement ses capacités agentiques ; un modèle text-only ne peut pas être présenté comme agent outillé.
- AC7 : les surfaces média, Gallery, Settings, Connections, MCP et agents persistent leurs données et fonctionnent dans le binaire Tauri natif.
- AC8 : les tests comprennent des cycles agents déterministes, des intégrations locales contrôlées et des parcours E2E du véritable WebView2/Tauri.
- AC9 : les règles projet et le gestionnaire de paquets détecté sont injectés dans les prompts sans contradiction.
- AC10 : les gates TypeScript, Vitest, build, Rust, lint critique, audit et Tauri natif produisent des preuves reproductibles.

## Analysis Summary

Le socle est substantiel et réutilisable. Les absences structurantes sont l’enforcement déterministe du cycle, des profils d’exécution réellement appliqués, la vérité produit, la couverture agentique homogène des providers et les tests E2E natifs.

## Tranche 2 — audit ciblé profils, isolation et persistance

- `ExecutionPolicy` possède déjà `ReadOnly`, `WorkspaceWrite` et `FullLocal`, mais `policy_for_run(bool)` ne sélectionne jamais `FullLocal` et `run_command` force toujours `WorkspaceWrite` (`policy.rs:55-116`, `tools.rs:1174-1198`).
- Le mode Plan possède une double barrière manifest/dispatcher pour les outils natifs mutants, mais les outils `mcp__*` passent avant cette barrière et restent exécutables sans classification d’effet (`runner.rs:1853-1885`, `runner.rs:2379-2406`).
- Les verdicts de commande `deny` et `Danger` sont seulement des annotations : la commande est tout de même exécutée (`policy.rs:275-323`, `tools.rs:1191-1229`).
- Le sandbox Windows est fail-open : toute indisponibilité ou erreur d’armement retourne `None`, puis `exec.rs` lance directement la commande (`sandbox.rs:211-245`, `exec.rs:194-241`).
- `agent_kill` annule la future du runner mais ne transmet aucun token au processus lancé dans `spawn_blocking`; une commande peut donc continuer après le statut `killed` jusqu’au timeout (`runner.rs:2418-2486`).
- Le frontend persiste seulement `chat|plan|agent` dans `localStorage`. Aucun profil d’accès n’est envoyé, et le chemin chat omet volontairement `isolate`, malgré des textes UI affirmant l’isolation par défaut (`chat-sync.ts:1018-1039`, `AgentsPanel.tsx:684`).
- `agent_continue` crée une nouvelle ligne et ne possède ni profil d’accès ni isolation. Les cartes HITL remplacent en outre le mode courant par Plan/Agent sans conserver la politique effective (`agents/mod.rs:1055-1119`, `QuestionCard.tsx:44-60`, `PlanApprovalCard.tsx:29-53`).
- La table `agents` ne persiste ni mode, ni profil, ni isolation. Les snapshots sont best-effort et sans événement ; les worktrees demandés peuvent échouer puis retomber silencieusement in-place (`lib.rs:157-181`, `runner.rs:1060-1132`).
- Le chemin Chat réel peut avoir des outils de lecture via `chat_send`, mais un agent personnalisé ou l’heuristique mascotte peut le convertir en Agent. La description et le routage doivent donc être rendus explicites et testés (`chat-sync.ts:345-358`, `chat-sync.ts:676-693`).

### Décision de conception de la tranche 2

- Séparer le mode de travail (`chat`, `plan`, `agent`) du profil d’accès agent (`auto`, `fullAccess`).
- Représenter côté Rust quatre profils effectifs : Chat/Plan en lecture seule, Auto en écriture workspace obligatoirement confinée, Full Access en exécution locale directe explicitement activée.
- Appliquer le profil deux fois : filtrage du manifest puis refus central avant tout dispatch natif ou MCP.
- Rendre `deny` exécutoire. Auto échoue fermé si le sandbox ne peut pas être prouvé ; seul Full Access peut choisir la voie directe.
- Persister le profil effectif et l’isolation avec chaque ligne agent, et les propager lors des reprises et délégations.
