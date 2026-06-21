# Audit RE comparatif - Shugu Forge vs Claude Desktop, Codex, OpenCode Desktop

Date: 2026-06-21
Projet audite: `F:\Dev\shugu_code`

## Resume franc

Shugu Forge n'est pas rate. La base est meme plutot solide: Tauri 2, SQLite
local-first, keychain pour les secrets, wrappers Tauri stricts, integrations Codex
en lecture seule, definitions d'agents compatibles Claude.

Le probleme principal est plus profond: Shugu a saute trop vite vers un moteur
agent local qui execute sur la machine reelle. Les outils recents que tu veux
prendre comme reference ne se distinguent pas seulement par l'UI ou par le modele:
ils sont organises autour de garde-fous systeme.

Le coeur a rattraper:

1. sandbox OS ou isolation equivalente pour les commandes agent;
2. permissions et approvals explicites;
3. worktree/session lifecycle propre;
4. import/adaptation des configs MCP existantes;
5. durcissement Tauri et reseau;
6. nettoyage des caches/worktrees orphelins.

## Methodologie

Ce rapport ne repose pas sur une decompilation intrusive des logiciels fermes.
J'ai utilise:

- fichiers et configs locales;
- binaires/manifests installes;
- traces AppData;
- source publique OpenCode;
- documentation officielle recente Claude/Codex/OpenCode;
- inspection statique du repo Shugu;
- checks locaux `pnpm typecheck`, `pnpm test`, `cargo check`.

## Environnement local trouve

### Shugu

- chemin reel: `F:\Dev\shugu_code`
- repo Git: `main`, remote `https://github.com/Asurelia/Shugu_code.git`
- etat: `main...origin/main [ahead 16]`
- modification visible: `src-tauri/Cargo.toml`, mais seulement dette LF/CRLF selon `git diff --check`
- stack: Tauri 2, React, Vite, CodeMirror, SQLite, Convex optionnel

### Codex

- binaire: `C:\Users\rafai\AppData\Local\OpenAI\Codex\bin\codex.exe`
- version locale: `codex-cli 0.130.0-alpha.5`
- config: `C:\Users\rafai\.codex\config.toml`
- point important: `sandbox = "elevated"` cote Windows
- MCP Codex: `[mcp_servers.*]` dans `~/.codex/config.toml`

### Claude Desktop / Claude Code

- donnees: `C:\Users\rafai\AppData\Roaming\Claude`
- config: `claude_desktop_config.json`
- versions Claude Code stockees: `2.1.177`, `2.1.181`
- extensions locales installees:
  - `ant.dir.ant.anthropic.filesystem`
  - `ant.dir.gh.socketdev.socket-mcp`
  - `ant.dir.cursortouch.windows-mcp`
  - autres extensions MCP
- presence de dossiers `claude-code-vm`, `vm_bundles`, `Claude Extensions`

### OpenCode Desktop

- version locale: `1.17.9`
- exe: `C:\Users\rafai\AppData\Local\Programs\@opencode-aidesktop\OpenCode.exe`
- stack upstream: Electron, Solid/UI, electron-vite, electron-builder
- config locale: `C:\Users\rafai\.config\opencode\opencode.json`
- MCP configure localement: `unityMCP` en remote HTTP sur `http://localhost:8080/mcp`

## Sources officielles recentes

- Codex sandbox: https://developers.openai.com/codex/concepts/sandboxing
- Codex Windows sandbox: https://developers.openai.com/codex/windows
- Codex app features: https://developers.openai.com/codex/app/features
- Codex worktrees: https://developers.openai.com/codex/app/worktrees
- Codex MCP: https://developers.openai.com/codex/mcp
- Claude MCP docs: https://code.claude.com/docs/en/mcp
- Claude Desktop Extensions: https://www.anthropic.com/engineering/desktop-extensions
- Claude local MCP support: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- OpenCode docs: https://opencode.ai/docs/
- OpenCode MCP: https://opencode.ai/docs/mcp-servers/
- OpenCode agents: https://opencode.ai/docs/agents/
- OpenCode config: https://opencode.ai/docs/config/
- OpenCode Desktop source: https://github.com/anomalyco/opencode/blob/dev/packages/desktop/README.md

## Architecture observee des references

### Claude Desktop

Claude Desktop fonctionne comme hote d'extensions et de connecteurs MCP.
La direction recente est tres claire:

- installation via Desktop Extensions `.mcpb`;
- configuration utilisateur au lieu de JSON manuel quand possible;
- separation entre extensions locales, connecteurs distants, politiques enterprise;
- Claude Code peut importer des MCP depuis Claude Desktop;
- Claude Code peut aussi servir de MCP server pour Claude Desktop.

Ecart avec Shugu:

- Shugu connait `.mcp.json`, mais pas le format Claude Desktop comme source primaire;
- Shugu ne lit pas les Desktop Extensions `.mcpb`;
- Shugu ne surface pas encore l'etat d'installation/erreur comme Claude Desktop;
- Shugu a de bonnes definitions `.claude/agents`, mais pas la meme maturite cote MCP.

### Codex

Codex est centre sur le triptyque:

- sandbox OS;
- approvals;
- worktrees.

Sur Windows, la doc officielle parle d'un sandbox natif avec utilisateurs moins
privilegies, frontieres de permissions filesystem, firewall et policy locale. Le
sandbox s'applique aussi aux commandes spawn: `git`, package managers, tests,
builds, etc.

Ecart avec Shugu:

- Shugu integre bien `codex app-server` pour le chat read-only;
- mais son propre moteur agent `run_command` contourne ce modele et lance les
commandes directement sur le workspace;
- l'avertissement Git n'est pas une barriere technique;
- pas de mode reseau off par defaut;
- pas de vrais approvals systematiques pour franchir les limites.

### OpenCode Desktop

OpenCode est open source, donc c'est la reference la plus lisible. Sa direction:

- app desktop Electron;
- serveur OpenCode local en sidecar;
- agents Build/Plan avec permissions differentes;
- MCP dans `opencode.json`;
- snapshots pour rollback, avec option de desactivation quand les repos deviennent gros;
- config extensible: agents, commands, plugins, rules, skills, LSP, formatters.

Ecart avec Shugu:

- Shugu a un cockpit riche, mais pas une separation assez dure Plan vs Build;
- pas de snapshot/rollback UI comparable;
- pas d'import OpenCode config;
- pas de permission model declare au meme niveau que les agents.

## Analyse Shugu fichier par fichier

### `src-tauri/src/commands/agents/exec.rs`

Constat:

- `run_command_direct` lance directement une commande shell dans le workspace.
- Sur Windows: `cmd /d /s /c`.
- Le preflight `check_git_safety` signale seulement l'etat Git.
- Le commentaire explique que le filet de securite est Git.
- Le timeout tue le child, mais le risque de descendants survivants existe sur Windows.

Risque:

- suppression de fichiers non suivis;
- ecriture hors controle via outils tiers;
- network exfiltration si une commande part sur internet;
- serveurs/dev processes qui restent vivants apres timeout;
- dirty tree qui devient difficile a restaurer.

Correction:

- remplacer `run_command_direct` par une couche `ExecutionPolicy`;
- modes: `ReadOnly`, `WorkspaceWrite`, `FullLocal`;
- approvals avant `FullLocal`;
- kill process tree Windows via Job Object;
- option reseau off par defaut;
- blocage si repo absent ou dirty pour les modes mutatifs.

### `src-tauri/src/commands/agents/tools.rs`

Constat:

- le tool `run_command` est expose aux agents;
- le dispatcher appelle directement `exec::run_command_direct`;
- le texte du tool assume un vrai toolchain et un acces machine reel.

Risque:

- l'agent peut convertir une intention de haut niveau en commande destructrice;
- l'UI peut donner une impression de securite superieure a la realite.

Correction:

- chaque appel `run_command` doit passer par une policy;
- afficher la policy effective dans l'UI;
- journaliser commande, cwd, env autorise, reseau, write scope, approval id.

### `src-tauri/src/commands/codex.rs`

Constat:

- tres bon point: le chat Codex passe par app-server;
- Shugu lance les tours chat avec `sandbox: read-only` et `approvalPolicy: never`;
- support d'un `CODEX_HOME` dedie.

Risque:

- incoherence mentale: Codex chat est bien borne, mais agents Shugu ne le sont pas.

Correction:

- prendre Codex comme backend d'execution quand l'utilisateur choisit le profil Codex;
- sinon reproduire explicitement les memes concepts dans Shugu.

### `src-tauri/src/commands/codex_app_server.rs`

Constat:

- client JSON-RPC app-server propre;
- les approvals serveur vers client ne sont pas traites, car chat read-only.

Correction:

- si Shugu utilise app-server pour des taches mutatives, il faudra implementer les
  notifications d'approval au lieu de les laisser timeout.

### `src-tauri/src/commands/mcp.rs`

Constat:

- Shugu lit `workspace/.mcp.json` et `~/.mcp.json`;
- un `.mcp.json` absent ou illisible devient config vide;
- pas d'import Claude Desktop;
- pas d'import Codex;
- pas d'import OpenCode;
- env/secrets potentiellement stockes en clair dans JSON.

Risque:

- l'utilisateur pense que MCP est configure ailleurs, mais Shugu ne le voit pas;
- erreurs silencieuses;
- fragmentation des secrets;
- divergence de schemas.

Correction:

- ajouter des adapters:
  - `ClaudeDesktopMcpSource`;
  - `CodexTomlMcpSource`;
  - `OpenCodeMcpSource`;
  - `ShuguMcpSource`;
- stocker les secrets dans keychain;
- afficher les erreurs de parsing;
- ajouter un ecran "MCP inventory" montrant source, statut, tool count.

### `src-tauri/tauri.conf.json`

Constat:

- `csp` est `null`.

Risque:

- surface XSS/IPC plus large que necessaire pour une app desktop agentique.

Correction:

- CSP stricte;
- autoriser uniquement les origins necessaires;
- verifier les previews/webviews si presentes.

### `src-tauri/capabilities/default.json`

Constat:

- `shell:default`;
- `fs:default`;
- SQL permissions larges.

Risque:

- trop de capacites exposees au renderer principal.

Correction:

- remplacer par permissions granulaires;
- isoler les operations sensibles cote Rust commands;
- limiter shell/fs aux commandes internes explicites.

### `src-tauri/src/commands/chat.rs`

Constat:

- le commentaire reconnait le risque SSRF pour `custom base_url`;
- TODO allowlist.

Risque:

- appel vers localhost, metadata services, IP privees, ou endpoints internes;
- exfiltration par provider custom mal configure.

Correction:

- allowlist explicite d'origins;
- blocage IP privee/link-local sauf override visible;
- confirmation pour HTTP non TLS;
- journaliser provider/base_url par conversation.

### `src/lib/credentials.ts`

Constat:

- bon modele: secrets vers keychain via `cred_*`;
- settings non secrets vers SQLite.

Action:

- reutiliser ce modele pour MCP env secrets et tokens provider.

### `src-tauri/src/commands/fs.rs`

Constat:

- tres bon modele de containment;
- `safe_resolve` et `safe_resolve_for_write` sont bien testes;
- rejet absolute, traversal, null byte, symlink escapes.

Action:

- prendre cette rigueur comme reference pour le moteur execution.

## Dette disque et worktrees

Mesure locale:

- `.claude`: environ 33.8 Go, 172144 fichiers;
- `.claude/worktrees`: environ 33.8 Go, 172138 fichiers;
- `src-tauri/target`: environ 23.0 Go;
- `node_modules`: environ 0.18 Go.

Worktrees Git enregistres:

- `infallible-galileo-130016`
- `lot-b-lsp`
- `peaceful-einstein-f8ba9f`
- `pedantic-noyce-50be22`
- `youthful-keller-593caf`
- `zealous-payne-bb4846`

Dossiers non enregistres dans `git worktree list`:

- `great-hellman-113a9b` (~9.5 Go)
- `dazzling-kepler-6d7705`
- `naughty-mcnulty-806a0e`
- `upbeat-jemison-55c3a0`
- `beautiful-volhard-7c8985`
- `frosty-liskov-f07762`

Important: `git worktree prune --dry-run --verbose` ne propose rien. Donc Git ne
voit pas ces dossiers comme prunable. Il faut les inspecter avant suppression.

Plan nettoyage:

1. fermer Claude/Codex/OpenCode/Shugu;
2. sauvegarder ou archiver les dossiers suspects;
3. pour chaque worktree enregistre, verifier `git status`;
4. supprimer via `git worktree remove <path>` si propre;
5. pour les dossiers non enregistres, verifier presence `.git`, changements, logs;
6. seulement ensuite supprimer manuellement;
7. ajouter dans Shugu un ecran "Worktree storage" avec age, taille, branche, statut.

## Priorites de correction

### P0 - Securite agent locale

Objectif: aucun agent Shugu ne doit executer une commande mutative sans cadre.

Fichiers:

- `src-tauri/src/commands/agents/exec.rs`
- `src-tauri/src/commands/agents/tools.rs`
- UI agent panel associee

Livrables:

- `ExecutionPolicy`;
- `ApprovalRequest`;
- kill process tree Windows;
- blocage dirty tree;
- logs auditables;
- tests Rust.

### P1 - Worktree/session model

Objectif: une session agent = un workspace isole et nettoyable.

Livrables:

- creation worktree par thread;
- handoff local/worktree;
- merge/apply diff;
- cleanup;
- size accounting.

### P1 - MCP inventory/import

Objectif: Shugu doit voir ce que tes autres outils voient.

Sources:

- `C:\Users\rafai\AppData\Roaming\Claude\claude_desktop_config.json`
- `C:\Users\rafai\.codex\config.toml`
- `C:\Users\rafai\.config\opencode\opencode.json`
- `C:\Users\rafai\.mcp.json`
- `F:\Dev\shugu_code\.mcp.json`

Livrables:

- adapters par format;
- validation schema;
- erreurs visibles;
- keychain env secrets;
- UI inventory.

### P2 - Tauri hardening

Objectif: reduire surface renderer.

Fichiers:

- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- commands Rust exposees

Livrables:

- CSP stricte;
- permissions granulaires;
- suppression `shell:default` si possible;
- suppression `fs:default` si possible.

### P2 - Provider/network hardening

Objectif: eviter SSRF et appels non voulus.

Fichiers:

- `src-tauri/src/commands/chat.rs`
- settings provider UI

Livrables:

- allowlist base_url;
- warnings pour localhost/private IP;
- confirmation pour HTTP;
- tests.

### P3 - TypeScript strictness

Objectif: reduire dette long terme.

Constat:

- `strict: false`
- `noImplicitAny: false`
- `skipLibCheck: true`

Action:

- ne pas tout activer d'un coup;
- commencer par modules sensibles: credentials, mcp, agents, db.

## Plan d'implementation recommande

### Phase 1: garde-fous minimaux

1. Ajouter `ExecutionPolicy` et `CommandRisk`.
2. Forcer approval pour commandes dangereuses.
3. Bloquer mutating command si repo dirty/no git.
4. Ajouter kill process tree Windows.
5. Afficher la policy dans l'UI agent.

### Phase 2: worktrees propres

1. Service Rust `worktree.rs`.
2. `create_agent_worktree(thread_id)`.
3. `list_agent_worktrees()`.
4. `cleanup_agent_worktree(id)`.
5. UI storage + status.

### Phase 3: MCP compatibility layer

1. Parser Claude Desktop JSON.
2. Parser Codex TOML.
3. Parser OpenCode JSON.
4. Dedup par nom/type/command/url.
5. Migrer secrets vers keychain.
6. Ecran inventory.

### Phase 4: durcissement

1. CSP.
2. permissions Tauri.
3. provider allowlist.
4. tests de securite.

## Checks effectues

- `pnpm typecheck`: OK
- `pnpm test`: OK, 34 fichiers, 426 tests
- `cargo check`: OK
- `pnpm lint`: absent du `package.json`

## Conclusion technique

Le bon modele pour Shugu n'est pas de copier l'UI de Claude, Codex ou OpenCode.
Le bon modele est de copier leur separation des responsabilites:

- UI conversationnelle;
- orchestrateur agent;
- politique de permissions;
- environnement d'execution borne;
- inventaire outils/MCP;
- stockage local clair;
- lifecycle worktree/session.

Aujourd'hui, Shugu a deja l'UI, le stockage local et une partie de l'orchestrateur.
Ce qui manque est le noyau de confiance: sandbox, permissions, isolation,
observabilite et nettoyage.

