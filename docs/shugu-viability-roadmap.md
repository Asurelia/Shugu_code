# Shugu — plan de viabilisation complet

État de référence : 23 juillet 2026. Ce document décrit le produit local Tauri,
pas la branche distante. SQLite reste la source de vérité et aucun écran ne doit
annoncer une capacité que le backend n'applique pas.

## Légende

- **Validé** : backend réel, UI reliée et preuve automatisée ou native.
- **Fonctionnel** : parcours réel utilisable, avec au moins un test de contrat.
- **Partiel** : une partie du parcours est réelle, les limites sont visibles.
- **Indisponible** : contrôle retiré ou explicitement désactivé ; aucune fausse connexion.
- **À faire** : chantier non livré, avec gate de sortie ci-dessous.

## Priorités et état

| Lot | Capacité cible | État | Gate de sortie |
|---|---|---:|---|
| P0.1 | Cycle agentique plan → action → vérification | Validé | Une mutation ne peut pas finir sans plan antérieur et vérification verte postérieure. |
| P0.2 | Profils Chat / Plan / Auto / Full Access | Validé | Politique appliquée au dispatcher ; Auto fail-closed ; Full Access confirmé une fois par session. |
| P0.3 | Kill, timeout et reprise HITL atomique | Validé | Arbre de processus tué, statut CAS durable, double reprise impossible. |
| P0.4 | Sandbox Windows Auto | Validé | Processus LOW réel, écriture workspace autorisée, hors-workspace refusée, aucun fallback direct. |
| P0.5 | Prompts versionnés et règles projet | Fonctionnel | Prompt fingerprinté, outils exacts, AGENTS/CLAUDE/Cursor/OpenCode et package manager injectés avec bornes. |
| P0.6 | Capacités des définitions d'agents | Fonctionnel | `tools:` filtre le manifeste et le dispatch, y compris les noms MCP exacts. |
| P1.1 | Matrice provider/modèle unique | Fonctionnel | Sélection Agent bloquée pour un adaptateur Chat-only ; découverte réelle et badges cohérents. |
| P1.2 | Anthropic / OpenAI-compatible | Fonctionnel | Boucle structurée native, streaming, outils et tests d'intégration fake-provider. |
| P1.3 | Ollama agentique natif | Fonctionnel sans binaire local | NDJSON et tool calls testés par serveur local factice ; test live requis dès qu'Ollama est installé. |
| P1.4 | Codex CLI/app-server comme moteur Shugu | Partiel | Chat/probe réels ; bridge agentique Shugu non livré, donc état Chat-only obligatoire. |
| P1.5 | OpenCode / autres CLI | Partiel | Endpoint compatible utilisable ; bridge autonome non prétendu tant que lifecycle/preuves ne sont pas conservés. |
| P1.6 | MCP avec effets typés | Partiel | MCP fonctionne ; Auto refuse les effets inconnus. Reste à typer chaque outil et durcir le transport HTTP. |
| P2.1 | Settings réels | Fonctionnel | Valeurs effectives, persistance SQLite/local cache, diagnostics About réels, aucun switch sans consommateur. |
| P2.2 | Connections réelles | Fonctionnel | « Connecté » uniquement après probe ; intégrations absentes marquées indisponibles. |
| P2.3 | Conversations et dock | Fonctionnel | Aucun transcript seedé, agent dock relié à SQLite, Output/Problems alimentés par données réelles. |
| P2.4 | Médiathèque Image/Vidéo/Musique | Fonctionnel | Migration V23, fichiers locaux et metadata persistés ; Gallery rend chaque type. |
| P2.5 | Jobs média annulables/reprenables | Validé | Progression/annulation durables, fichiers atomiques, recovery honnête en `interrupted`, retry, reveal, delete et détection des fichiers manquants. |
| P3.1 | Isolation worktree fidèle à l'état non commité | Validé | Overlay de l'arbre utilisateur, base SHA durable, merge propre/conflit/rejet et double cleanup testés. |
| P3.2 | Recovery au boot | Fonctionnel | Claims HITL libérés, runs/jobs/assets/worktrees réconciliés ; un processus OS mort n'est jamais prétendu « repris ». |
| P3.3 | Backup/export/restauration | Validé | Bundle intègre, staging à côté de SQLite et swap avant ouverture SQL prouvés sur deux boots Tauri isolés. |
| P4.1 | E2E navigateur de la couche UI | Validé | Build, `ui:tour` et Playwright verts, avec erreurs Tauri absentes explicitement tolérées. |
| P4.2 | E2E Tauri/WebView2 automatisé | Validé | Harness CDP reproductible, identifiant/base/profil isolés, deux boots, captures, IPC natif et teardown exact. |
| P4.3 | Évaluations agents live multi-provider | Validé | Codex réel validé en chat/probe ; Qwen3 8B et Llama 3.1 8B validés séparément sur le même cycle Agent complet sous llama.cpp. |
| P5.1 | Accessibilité clavier/ARIA | Validé | 534 contrôles visibles nommés et 827 échantillons de contraste sans violation sur 11 états au dernier passage ; navigation clavier et focus-trap/restauration des dialogs prouvés dans WebView2. |
| P5.2 | Dépendances, lint et performances | Validé | Audit JS propre, exceptions Rust bornées, lint à 0/0, budgets dev/release/charge mesurés, indexation batchée et installateurs Windows produits. |

## Contrat produit non négociable

1. Un modèle ne devient pas un agent parce qu'un prompt lui demande de l'être :
   l'adaptateur doit supporter les outils et le contrôleur Shugu doit observer le
   cycle, les effets et la preuve de fin.
2. Chat et Plan ne mutent pas. Auto n'affiche aucune confirmation par commande,
   mais reste confiné et échoue fermé. Full Access n'est actif qu'après dialogue
   natif et peut être révoqué immédiatement.
3. Les prompts décrivent uniquement le manifeste réellement envoyé. Leur version,
   fingerprint, profil, provider, règles projet et outils sont persistés dans les
   événements du run.
4. Une connexion n'est « connectée » qu'après probe. Une intégration absente est
   marquée indisponible, jamais simulée.
5. Une création n'existe dans la Gallery que si elle vient de SQLite ; un fichier
   manquant est affiché comme manquant, pas comme succès.
6. Les tests mutatifs n'utilisent jamais la base ou le workspace personnels.

## Solde de la feuille de route

### R1 — providers et MCP

- **Livré** — fake provider HTTP commun pour tester un tour complet
  `todo_write → read → edit → test rouge → correction → test vert → final`.
- **Livré** — variantes Anthropic, OpenAI-compatible et Ollama sur ce contrat.
- **Livré en live** — `pnpm provider:smoke:live` valide Codex authentifié
  (probe + app-server), un chat GGUF Qwen 2B et deux familles d'agents réelles
  sous llama.cpp : Qwen3 8B et Llama 3.1 8B. Chaque preuve finale persiste
  `todo_write → fs_write_file → run_command(exit 0) → complete` dans SQLite.
- **Corrigé par la preuve live** — résolution du vrai CLI Codex hors
  `WindowsApps`, `submit_plan` strictement réservé au mode Plan, `todo_write`
  conservé dans le toolset des petits modèles, mutation impossible avant plan
  et réponse brute impossible en mode Agent sans action.
- **Livré** — effets MCP typés à la découverte et blocage Auto de toute
  capacité externe/destructive non déclarée.
- **Garde-fou maintenu** — Codex et OpenCode restent Chat-only jusqu'à ce qu'un bridge fournisse chaque
  ToolCall/ToolResult au lifecycle Shugu et respecte kill/profil/isolation.

### R2 — jobs média et stockage — livré

- `MediaJob`/`MediaAsset` unifiés pour image, vidéo et musique.
- Progression Rust, états persistés, annulation et écritures atomiques.
- Recovery au boot en `interrupted` si le fournisseur ne permet pas une reprise
  sans secret ; retry manuel fidèle au brouillon original.
- Suppression locale confinée aux dossiers gérés, révélation et réconciliation
  des fichiers déplacés/manquants.

### R3 — isolation et récupération — livré

- Overlay des modifications non commitées créé avant le worktree isolé.
- Base SHA, snapshot, worktree, branche et diff persistés par run.
- Au boot, runs `running`, processus absents, worktrees orphelins réconciliés
  et interactions claimées sans continuation.
- Merge propre, conflit conservé pour revue, rejet et double cleanup testés.

### R4 — preuves natives automatisées — livré pour le smoke reproductible

- Lancer Tauri via `tauri-dev-log.cmd` avec port CDP réservé et répertoire de
  données temporaire.
- Dérouler onboarding vide, Agent Auto, Settings, Connections, retry média,
  Gallery manquante et sauvegarde/restauration sur deux démarrages.
- Vérifier SQLite avant/après, absence de panic JS/Rust et teardown exact des
  processus/ports.
- Conserver captures et logs horodatés dans `dev-logs/`.

### R5 — finition produit

- **Livré** — onglets média clavier/ARIA, focus-trap avec restauration du focus
  et contrôle automatique des noms accessibles sur onze états de l'application.
- **Livré** — audit de contraste calculé dans la vraie WebView2 : 827 textes
  mesurés, y compris fonds opaques/composés et approximation conservatrice des
  dégradés, sans violation au seuil WCAG applicable.
- **Livré** — budgets shell/DOM/heap et mémoire Tauri+WebView2 en développement,
  puis démarrage, IPC et mémoire du binaire release embarqué sous profil isolé.
- **Livré** — 0 advisory JS, 0 erreur/0 warning ESLint ; exceptions RustSec
  documentées dans `docs/security-advisories.md`.
- **Livré** — build release Windows reproductible : binaire, MSI et
  installateur NSIS générés par `pnpm tauri build`.
- **Livré** — campagne native de charge isolée : 1 200 fichiers/6 000 chunks,
  streaming SSE concurrent, scan chaud, réindexation de 10 %, recherche et
  budgets renderer/mémoire.
- **Optimisé** — FastEmbed en micro-lots de 4 chunks et transaction native de
  32 fichiers : full-index réduit de 197,1 s à 89,2 s (−54,8 %) sans perte de
  réactivité ni d'atomicité.
- **Livré** — Codex chat/probe, Qwen3 8B agentique et Llama 3.1 8B agentique
  sont prouvés sur trois exécutions live isolées. Mistral n'est pas revendiqué :
  les GGUF essayés n'ont pas fourni un contrat d'outils suffisamment stable.

## Gates à exécuter avant chaque tranche

```powershell
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm ui:tour
pnpm exec playwright test
```

Sous Windows, Rust doit être lancé dans l'environnement développeur Visual Studio :

```powershell
cmd.exe /d /c F:\Dev\shugu_code\cargo-msvc.cmd check
cmd.exe /d /c F:\Dev\shugu_code\cargo-msvc.cmd test --no-fail-fast
```

Le tour natif final est `pnpm native:smoke`. Il utilise `tauri-dev-log.cmd`,
WebView2/CDP et un identifiant Tauri séparé. Un smoke Chromium valide la couche
web, mais ne remplace jamais cette preuve du binaire Tauri.

## Définition de « viable »

Le noyau local de Shugu est désormais viable : P0 à P3 sont validés ou
fonctionnels, un run mutatif complet passe sur trois protocoles de providers
factices et sur deux familles locales réelles, Qwen3 8B et Llama 3.1 8B, tandis
que Codex authentifié est prouvé en chat/probe. Kill/Auto/Full Access sont
prouvés dans le binaire natif, les médias persistent réellement et aucun écran
audité ne repose sur une donnée de démonstration ou un contrôle sans effet.
L'accessibilité critique, le runtime release isolé, la charge
indexation/streaming et les installateurs sont également prouvés.

## Dernière preuve locale — 23 juillet 2026

- Gates : 51 fichiers / 559 tests frontend et 455 tests Rust réussis ;
  typecheck, build Vite 8 (554 modules), ESLint 0/0, Playwright 1/1, tour UI et
  `git diff --check` verts.
- Sécurité : `pnpm audit` ne trouve aucun advisory JS ; RustSec est vert avec
  trois exceptions inactives/build-only documentées et 22 warnings transitifs
  visibles non promus en vulnérabilités.
- Binaire dev : `pnpm native:smoke` vert sur `dev.shugu.forge.native-smoke`,
  base SQLite de 479 232 octets, IPC natif, backup puis swap au second boot.
- Accessibilité : 534 contrôles visibles audités sans nom manquant, 827 textes
  sans violation de contraste sur 11 états, navigation des tabs média et
  focus-trap/restauration d'un dialog vérifiés dans WebView2.
- Budgets dev : shell 4 131 ms, DOMContentLoaded 2 532 ms et heap JS
  51 639 255 octets sur `dev-logs/native-smoke/20260723-085036/`.
- Charge native : 1 200 fichiers, 6 000 chunks en 88 552 ms, scan chaud
  97,4 ms, 120 fichiers réindexés en 10 408 ms et recherche initiale en
  54,5 ms. Les 1 200 fragments SSE deviennent 194 événements sans perte ;
  premier delta 302,8 ms, pause maximale 172,7 ms, heartbeat renderer maximal
  73 ms, working set total 1 244 061 696 octets et 0 erreur.
- Runtime release isolé : URL `http://tauri.localhost/`, shell 804 ms,
  DOMContentLoaded 164 ms, heap 23 100 199 octets, working set total
  682 434 560 octets, 0 erreur page/console/requête et profil de test supprimé.
- Teardown : 0 processus Shugu, 0 listener 1420, profil temporaire absent.
- Providers live : `dev-logs/live-provider-smoke/20260723-083956/` prouve
  Llama 3.1 8B (8 156 ms) et `20260723-084138/` prouve Qwen3 8B (7 156 ms).
  Chaque run Full Access confirmé puis révoqué persiste
  `todo_write → fs_write_file → run_command(exit 0) → complete`, crée
  exactement `LIVE_AGENT_OK` et ne laisse aucune erreur ou ressource
  résiduelle. `20260723-065615/` reste la preuve Codex `gpt-5.4-mini`
  authentifiée (probe + app-server).
- Packaging : `pnpm tauri build` vert ; binaire release 75 343 872 octets,
  MSI 30 064 640 octets et installateur NSIS 22 740 318 octets.
- SHA-256 : binaire `23030AC846BE8ED783DC7D18EAF7026A412C467D263CA170F88374CECCA04C10`,
  MSI `20E1C1AA67D4D9F51B4858BFBA50AD077318EF3E0BE94E0974CBDA03B1E8A906`,
  NSIS `34C2ECA1CE24A9D5BB940B97C6E84F631FB14C9C785FAF40C679377FC91E4E66`.
- Limites assumées : le quota Codex externe était épuisé lors des deux runs
  locaux finaux, donc `-SkipCodex` a enregistré un skip sans compter
  d'inférence. Ollama reste absent. Mistral n'est pas annoncé comme compatible
  tant qu'un GGUF avec template d'outils stable n'a pas passé le même gate.
