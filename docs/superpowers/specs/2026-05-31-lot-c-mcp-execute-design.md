# Lot C — MCP exécuté — Design

Date : 2026-05-31
Branche : `feat/lot-c-mcp-execute-20260531`
Statut : design validé (décisions tranchées avec l'utilisateur)

## Objectif

Faire passer MCP (Model Context Protocol) de **config-only** (l'UI accepte
`mcp__notion__search` mais aucun serveur n'est jamais lancé) à **réellement
exécuté** : Shugu lance de vrais serveurs MCP, découvre leurs outils, et les
rend appelables par le LLM **dans le chat ET dans les agents**. C'est le plus
gros écart vs Claude Desktop.

## Décisions validées

| Décision | Choix |
|---|---|
| Config des serveurs | **`.mcp.json` standard (lecture) + UI Settings (écriture du même fichier)** |
| Périmètre d'exécution | **Chat + agents** (partout où le LLM a des tools) |
| Sûreté d'exécution | **Serveur activé = autorisé** (toggle par serveur, activité visible, pas de confirmation par appel) |
| Transport | **stdio local + HTTP/SSE distant** |
| Implémentation protocole | **crate `rmcp` (SDK Rust officiel MCP)** — gère stdio (`transport-child-process`) ET SSE (`transport-sse-client`) avec une API uniforme `list_tools` / `call_tool` |

### Pourquoi `rmcp` plutôt que hand-roll
Le pont Codex (`codex_app_server.rs`) prouve qu'on SAIT faire du JSON-RPC stdio
à la main, mais MCP exige AUSSI le transport HTTP/SSE (parsing du flux SSE,
session, reconnect) — hand-roller les deux doublerait le travail et le risque de
bug protocole. `rmcp` v0.8 (officiel, trust 8.4) expose `TokioChildProcess` et
`SseClientTransport` derrière la même API client. Build-vs-buy → buy.
(À confirmer au plan : version exacte + features compilent sur la toolchain.)

---

## Architecture

### Nouveau module Rust `src-tauri/src/commands/mcp.rs`

Responsabilité unique : gérer le cycle de vie des connexions MCP + exposer
leurs outils. Découpé en sous-parties claires :

1. **Config** (`McpServerConfig`) — lecture de `.mcp.json` :
   - Projet : `<workspace>/.mcp.json`
   - Global : `~/.mcp.json` (et fallback `~/.claude.json` clé `mcpServers` si présent)
   - Format standard Claude Code :
     ```json
     {
       "mcpServers": {
         "notion": { "command": "npx", "args": ["-y", "@notionhq/..."], "env": {"TOKEN":"..."} },
         "remote":  { "url": "https://host/sse" }
       }
     }
     ```
   - `command`+`args`(+`env`) ⇒ transport stdio ; `url` ⇒ transport SSE.
   - Le projet écrase le global en cas de même nom (merge, projet prioritaire).

2. **État activé** — `mcp.<server>.enabled` dans la table `settings` (SQLite),
   sémantique « ON si !== "false" » comme `chat.autoEditorContext`. Par DÉFAUT
   un serveur fraîchement découvert est **désactivé** (OFF) : l'utilisateur
   l'active explicitement (sûreté = décision de confiance au niveau serveur).

3. **Gestionnaire de connexions** (`McpManager`) — `OnceLock<Mutex<HashMap<String, McpConn>>>`,
   même pattern que `AgentManagerState` / le singleton `codex_app_server`. Une
   `McpConn` détient le client `rmcp` (lazy-spawné au 1ᵉʳ usage d'un serveur
   activé), le `serverInfo`, et le **cache des outils** (`tools/list` au
   handshake). Mort du process ⇒ retrait du HashMap, respawn au prochain appel
   (calque `codex_app_server::ensure`).

4. **Découverte d'outils** (`mcp_list_tools_namespaced`) — pour chaque serveur
   ACTIVÉ, liste ses outils et les renomme `mcp__<server>__<tool>` (convention
   Claude Code, déjà attendue par l'UI). Renvoie une `Vec` de définitions au
   format provider (OpenAI `{type:function,...}` / Anthropic `{name,input_schema}`).

5. **Dispatch d'appel** (`mcp_execute`) — reçoit un nom `mcp__server__tool` +
   args JSON, route vers le bon client `rmcp` → `call_tool`, aplatit le résultat
   (content blocks MCP) en texte pour le LLM. Jamais de panic : erreur ⇒
   `(message, is_error=true)` (même contrat que `chat_tools::execute_chat_tool`).

### Commandes Tauri (enregistrées dans `lib.rs`)
- `mcp_list_servers()` → `Vec<McpServerStatus>` : nom, source (projet/global),
  transport, enabled, état connexion, nb d'outils, erreur éventuelle.
- `mcp_test_server(name)` → spawn + handshake + `tools/list` sans persister
  l'activation ; renvoie la liste d'outils ou une erreur lisible. (Le bouton
  « Tester » de l'UI — validable EN VOYANT dès la Phase 1.)
- `mcp_set_enabled(name, enabled)` → écrit `mcp.<server>.enabled` ; (dé)connecte.
- `mcp_add_server(name, config)` / `mcp_remove_server(name)` → écrit `.mcp.json`
  (projet par défaut ; choix projet/global dans l'UI). Préserve le reste du fichier.
- `mcp_call_tool(name, args)` → appel direct (pour le bouton « Essayer un outil »
  de l'UI + utilisable en debug).

### Injection dans les boucles d'outils (réutilise Lot A)
- **Chat** (`chat.rs::run_chat_tool_loop`) : aujourd'hui le schéma d'outils =
  `chat_tools_json_*(write_enabled)`. On **ajoute** `mcp_list_tools_namespaced(protocol)`
  à cette liste quand au moins un serveur MCP est activé. Au dispatch : si
  `tc.name` commence par `mcp__` → `mcp::mcp_execute(...)` ; sinon →
  `execute_chat_tool(...)` (inchangé). Visibilité : delta `kind:"tool"`
  « 🔌 notion__search … ».
- **Agents** (`agents/runner.rs` + `agents/tools.rs`) : même principe. Le schéma
  d'outils agent (`tools_json_*`) est complété par les outils MCP des serveurs
  activés ; le dispatcher `execute_tool` route les `mcp__*` vers `mcp::mcp_execute`.
  Émet `AgentEvent::ToolCall` / `ToolResult` comme pour les outils natifs.

### UI Settings — gestionnaire de serveurs MCP
- Nouvel onglet/section dans **Settings → Connections** : « Serveurs MCP ».
- Liste les serveurs (de `.mcp.json` projet + global) avec : nom, transport,
  badge source, **toggle activé/désactivé**, bouton **Tester** (montre les
  outils découverts), état (connecté / erreur).
- Bouton « Ajouter un serveur » : formulaire (nom, type stdio/SSE, command+args+env
  ou url, scope projet/global) → `mcp_add_server`.
- Réutilise les primitives existantes (`SettingRow`, `Switch`) + la charte glass.
- Le champ « Outils avancés (MCP) » du `AgentDefsManager` reste, mais les outils
  MCP sont désormais RÉELLEMENT exécutés (plus un placeholder).

---

## Découpage en phases

**Phase 1 — Client MCP + config + commandes (validable EN VOYANT)**
Module `mcp.rs` : lecture `.mcp.json`, `McpManager`, connexion stdio+SSE via
`rmcp`, `tools/list`, `tools/call`, commandes Tauri (`list_servers`, `test_server`,
`set_enabled`, `call_tool`). Vérif en voyant : configurer un serveur MCP simple
(ex. `@modelcontextprotocol/server-filesystem` via npx) dans `.mcp.json`, cliquer
« Tester » dans une UI minimale (ou via un appel), voir ses outils listés et un
`call_tool` renvoyer un vrai résultat.

**Phase 2 — Injection chat + agents**
Compléter les schémas d'outils (chat loop + agent runner) avec les outils MCP des
serveurs activés ; router les `mcp__*` au dispatch ; visibilité. Vérif : activer
un serveur, demander au chat « cherche X dans Notion » → tool-call MCP visible +
résultat réel ; idem via un agent.

**Phase 3 — UI Settings complète**
Section « Serveurs MCP » dans Connections : liste, toggle, Tester, ajouter/éditer/
supprimer (écrit `.mcp.json`). Vérif en voyant : tout le cycle via l'UI.

---

## Sûreté (rappel + garde-fous)
- **Activation explicite** : un serveur n'est jamais lancé ni ses outils exposés
  tant que l'utilisateur ne l'a pas activé (défaut OFF). C'est la frontière de
  confiance (mémoire « empêcher l'irréparable » : on n'expose pas par défaut une
  capacité qui peut agir hors workspace).
- **Visibilité** : chaque appel d'outil MCP est affiché (chat `kind:"tool"` /
  AgentEvent), jamais silencieux.
- **Secrets** : les `env` du serveur peuvent contenir des tokens. À l'écriture
  via l'UI, proposer de stocker les valeurs sensibles dans le keychain (réutilise
  `cred_set`/`cred_get`, mémoire « réutiliser provider/clés ») et n'écrire qu'une
  référence dans `.mcp.json` quand c'est possible ; à défaut, écrire en clair
  (comportement standard `.mcp.json`) en avertissant. Décision fine au plan.
- **Isolation des erreurs** : un serveur MCP qui cr(h)ash ne casse ni le chat ni
  l'agent — l'appel renvoie une erreur que le LLM voit, et le serveur est marqué
  en erreur dans l'UI.
- **Pas de timeout infini** : `call_tool` borné (ex. 60 s) comme les requêtes
  Codex (30 s) — un serveur MCP lent ne gèle pas la boucle.

## Ce qui N'EST PAS dans ce lot (YAGNI)
- MCP **resources** et **prompts** (on ne fait que les **tools** d'abord).
- MCP **sampling** (serveur qui rappelle le LLM) — hors scope.
- OAuth interactif pour serveurs SSE distants — si un serveur exige un flux
  d'auth navigateur, on documente la limite ; les tokens statiques (header/env)
  marchent.
- Approvals par appel (on a choisi serveur-activé=autorisé).

## Stratégie de vérification
- `cargo check` + `cargo test` headless (vcvars64) verts ; tests unitaires :
  parsing `.mcp.json` (stdio + url + merge projet/global), namespacing
  `mcp__server__tool`, aplatissement du résultat `call_tool`.
- `pnpm typecheck` + `pnpm test` verts.
- **Vérif EN VOYANT** (mémoire « user évalue en voyant ») à chaque phase, cf.
  ci-dessus. Smoke-test sur Windows (mémoire « agent supervision »).

## Risques / points ouverts (à figer au plan)
- `rmcp` : version exacte + set de features qui compile (client,
  transport-child-process, transport-sse-client) sur la toolchain du projet ;
  poids de la dépendance. Repli : hand-roll stdio (réutilise le pattern Codex)
  et reporter SSE si `rmcp` pose problème.
- Windows : spawn `npx`/`uvx` sans fenêtre console (réutiliser
  `apply_no_window_pub` du module codex), et résolution du binaire (npx via
  `cmd /d /c` ? — attention mémoire « pas de sous-cmd »). À tester tôt.
- Forme exacte d'injection des tools dans `call_*_structured` : Lot A a déjà
  ajouté un param `tools: Option<Value>` — on y concatène les outils MCP.
- Stockage secrets `env` : keychain vs clair dans `.mcp.json`.
