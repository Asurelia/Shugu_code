# Step 02: Plan

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Planning Progress

## Overview

Conserver le socle Tauri/Rust/SQLite existant, mais remplacer les promesses textuelles par des contrats exécutables. Le chantier avance par tranches verticales : un état réel côté Rust, sa représentation SQLite/IPC, une UI honnête, puis une preuve native automatisée. Aucun nouvel écran décoratif n’est admis sans backend et test correspondant.

## Ordre de livraison

1. Contrat de cycle agentique et preuves de complétion.
2. Profils d’exécution Chat/Plan/Auto/Full Access et isolation déterministe.
3. Prompts composables et règles projet.
4. Matrice de capacités providers et parité agentique.
5. Vérité Settings/Connections et sécurité déclarative.
6. Persistance média/Gallery et correction des parcours natifs.
7. Reprise, observabilité et contrôle des processus.
8. Évaluations agents live et E2E Tauri/WebView2.
9. Durcissement dépendances, performances et accessibilité.

## File-by-file implementation plan

### Documentation et contrats

#### `docs/shugu-viability-roadmap.md` (nouveau)

- Publier le présent programme sous forme de matrice : capacité, état actuel, cible, preuve et gate de sortie.
- Définir « fonctionnel », « partiel », « expérimental » et « indisponible » pour empêcher le retour d’états fictifs.
- Référencer les commandes de validation pnpm/cargo/Tauri natives.

#### `docs/quality-gates.md`

- Remplacer les commandes npm/npx restantes par pnpm.
- Distinguer explicitement unit, integration, agent-live et Tauri-native.
- Rendre les gates P0 bloquantes et documenter les gates nécessitant credentials ou binaires externes.

### Contrôleur agentique déterministe

#### `src-tauri/src/commands/agents/lifecycle.rs` (nouveau, première tranche)

- Définir `AgentPhase` : `Orient`, `Plan`, `Execute`, `Verify`, `Review`, `Complete`, `Blocked`.
- Définir `RunEvidence` : plan observé, outils de lecture, mutations, dernière mutation, vérifications lancées/réussies, review observée, erreurs et blocages.
- Classifier les outils par effet sans dépendre du prompt.
- Refuser la complétion d’un run mutatif sans plan et sans vérification réussie postérieure à la dernière mutation.
- Autoriser une réponse purement informative sans imposer artificiellement un plan ou un test.
- Fournir une API pure et testable pour les transitions et la décision de complétion. Couvre AC2, AC8.

#### `src-tauri/src/commands/agents/mod.rs`

- Enregistrer le module lifecycle.
- Étendre `AgentEvent` avec les transitions de phase et preuves résumées.
- Étendre `SpawnArgs` avec un profil d’exécution explicite et une politique d’isolation.
- Ne plus réduire le mode à `read_only: bool`.
- Persister le profil et la phase, et distinguer succès, succès non vérifié, blocage et épuisement de budget.
- Conserver le même agent logique lors d’une reprise HITL, ou lier explicitement les segments d’exécution. Couvre AC2, AC3, AC5.

#### `src-tauri/src/commands/agents/runner.rs`

- Intégrer `RunEvidence` dans `tool_use_loop` (`runner.rs:1724`).
- Remplacer « aucune tool_call = succès » (`runner.rs:2053`) par une décision du contrat.
- Si la preuve manque, injecter une correction structurée et poursuivre dans le budget ; ne jamais enregistrer `max_iterations` comme succès vérifié.
- Émettre les phases et preuves sur `agent://lifecycle`.
- Exiger que la vérification postérieure à une mutation corresponde au projet ou à une commande fournie.
- Transmettre le profil et l’isolation aux sous-agents.
- Rendre les limites/erreurs de répétition actives dans le contrôle de flux.
- Préparer un point d’injection pour les prompts composables. Couvre AC2, AC4, AC5, AC9.

#### `src-tauri/src/commands/agents/tools.rs`

- Associer chaque outil natif/MCP à un effet `read/write/exec/network/external/destructive`.
- Appliquer le profil côté dispatcher, pas uniquement dans le manifest envoyé au modèle.
- Enregistrer dans `RunEvidence` les résultats structurés et les codes de sortie.
- Propager l’abort aux commandes longues et supprimer les réglages seulement visuels.
- Refuser les outils MCP non classés en Plan. Couvre AC2, AC3, AC5.

#### `src-tauri/src/commands/agents/policy.rs`

- Remplacer la politique consultative actuelle par des profils réels : `Chat`, `Plan`, `Auto`, `FullAccess`.
- Séparer `sandbox_mode`, `approval_policy`, `network_policy`, `isolation_policy` et `writable_roots`.
- Auto : aucune confirmation dans les racines autorisées, fail-closed hors frontière.
- Full Access : aucune confirmation par commande après activation explicite, journal complet et kill switch.
- Conserver les règles allow/deny comme règles exécutoires et non badges. Couvre AC3, AC4.

#### `src-tauri/src/commands/agents/exec.rs`

- Accepter la politique calculée et l’abort token.
- Retourner une provenance claire : sandbox réellement appliqué ou exécution directe.
- Tuer l’arbre de processus lors d’un kill/timeout.
- Ne jamais basculer silencieusement d’Auto sandboxé vers direct. Couvre AC4, AC5.

#### `src-tauri/src/commands/agents/sandbox.rs`

- Transformer les résultats best-effort en résultat typé `Confined/Unavailable/Failed`.
- En Auto, un sandbox indisponible doit bloquer ou basculer vers un worktree/conteneur explicitement annoncé, pas exécuter directement.
- En Full Access seulement, autoriser la voie directe explicite.
- Ajouter des tests Windows réels pour lecture, écriture, réseau, secrets et kill. Couvre AC3, AC5.

#### `src-tauri/src/commands/worktree.rs`

- Accepter un snapshot des changements non commités afin que l’agent isolé voie l’état réel du projet.
- Associer durablement worktree, agent, base SHA et diff.
- Garantir nettoyage/merge/rejet idempotents et récupérer les worktrees orphelins au boot.
- Ne plus continuer in-place après échec d’une isolation demandée. Couvre AC5.

#### `src-tauri/src/commands/snapshot.rs`

- Rendre le checkpoint obligatoire avant un run direct mutatif.
- Lier chaque snapshot au run et fournir restore/cleanup idempotents.
- Ajouter un statut explicite lorsque le projet n’est pas Git. Couvre AC5.

#### `src-tauri/src/lib.rs`

- Ajouter une migration pour profil, phase, relation de reprise, preuve de validation et état d’isolation.
- Ajouter une table de configuration workspace fiable si les settings globaux ne suffisent pas.
- Enregistrer les nouvelles commandes de profil/diagnostic.
- Retirer les seeds produit d’une base utilisateur neuve ou les placer derrière un mode démo explicite. Couvre AC1, AC3, AC5, AC7.

### Prompts et contexte projet

#### `src-tauri/src/commands/agents/prompts.rs` (nouveau)

- Extraire les prompts de `runner.rs:2952-3027` en fragments versionnés : core, mode, rôle, provider, cycle, sécurité et sortie.
- Ne décrire que les outils réellement présents dans le manifest.
- Adapter le langage et le niveau de détail aux capacités du modèle.
- Ne jamais utiliser un prompt pour prétendre appliquer une règle que le contrôleur n’applique pas. Couvre AC6, AC9.

#### `src-tauri/src/commands/agents/project_context.rs` (nouveau)

- Détecter `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, instructions OpenCode, packageManager, commandes de test et limites workspace.
- Résoudre les règles par proximité de fichier et borner la taille injectée.
- Fournir un contexte structuré au composeur de prompts et au contrôleur de vérification. Couvre AC6, AC9.

#### `src-tauri/src/commands/agents/runner.rs` — prompts actuels

- Supprimer les prescriptions npm/npx codées en dur (`runner.rs:2973-2989`).
- Remplacer les rôles génériques qui annoncent trois outils alors que le manifest réel diffère.
- Versionner le prompt utilisé dans chaque événement de run pour reproductibilité. Couvre AC9.

#### `src/features/chat/persona.ts`

- Garder la mascotte comme couche de voix uniquement ; ne pas mélanger personnalité, politique d’outils et cycle agentique.
- Afficher explicitement lorsque la reformulation vocale échoue ou n’est pas disponible. Couvre AC1.

### Frontend des modes et du cycle

#### `src/lib/agents.ts`

- Ajouter types `AgentPhase`, `ExecutionProfile`, `IsolationPolicy`, `RunEvidenceSummary` et événements correspondants.
- Exposer les commandes de lecture/écriture des profils par workspace.
- Étendre les types de spawn/continue et leurs résultats. Couvre AC2, AC3.

#### `src/features/chat/chat-sync.ts`

- Transmettre le profil explicite et l’isolation choisie à chaque spawn et continuation.
- Faire de `Auto + isolation` le défaut pour les tâches mutatives, sans confirmations unitaires.
- Ne jamais lancer silencieusement un provider non agentique en mode Agent.
- Réconcilier les runs repris avec leurs preuves/segments persistés. Couvre AC3, AC4, AC5, AC6.

#### `src/features/chat/ModeSelector.tsx`

- Séparer mode de travail (`Chat/Plan/Agent`) et profil d’accès (`Auto/Full Access`).
- Ajouter une activation Full Access explicite au niveau session/workspace, sans demandes répétitives ensuite.
- Afficher sandbox, réseau, isolation et racines autorisées réels. Couvre AC1, AC3, AC4.

#### `src/components/trust/trust.ts`

- Remplacer la taxonomie purement visuelle par une projection fidèle du profil backend.
- Ajouter états `verified`, `unverified`, `blocked`, `sandbox unavailable`, `direct` et `isolated`.

#### `src/components/trust/ExecutionProfileCard.tsx`

- Lire le profil effectif depuis le backend.
- Montrer la frontière réelle et les conséquences avant activation, puis rester non bloquant pendant le run.

#### `src/features/agents/useEvents.ts`

- Consommer les transitions de phase et preuves persistées.
- Restaurer l’état exact après remount/reload plutôt qu’un simple statut running/error.

#### `src/features/chat/AgentPlan.tsx`

- Afficher le graphe contrôlé par le runtime, ses dépendances et la preuve de chaque étape.
- Distinguer plan proposé, plan actif et plan terminé.

#### `src/features/chat/CommandRiskCard.tsx`

- Afficher la décision réellement appliquée : autorisé, refusé, sandboxé ou Full Access.
- Retirer les actions « toujours autoriser/refuser » tant qu’elles ne modifient pas l’exécution.

#### `src/features/agents/AgentsPanel.tsx`

- Afficher phase, profil, isolation, vérification et relation parent/enfant.
- Donner accès aux preuves, au kill d’arbre, à la reprise et au merge/rejet worktree.

### Providers et intégrations

#### `src-tauri/src/commands/model_capabilities.rs`

- Remplacer les heuristiques dispersées par une matrice de capacités sérialisable et testée : tools, streaming, vision, reasoning, context, agent loop, MCP, efforts.
- Ajouter un statut probe/version pour les serveurs locaux et CLI.

#### `src/lib/modelCapabilities.ts`

- Consommer la matrice Rust comme source de vérité ; retirer les duplications frontend.
- Empêcher la sélection Agent pour un modèle text-only sans adaptation disponible.

#### `src/lib/providers.ts`

- Réduire le registre aux identités/résolutions statiques nécessaires ; ne plus dupliquer les capacités et modèles dynamiques.
- Modéliser OpenCode comme endpoint compatible seulement lorsque réellement configuré.

#### `src-tauri/src/commands/models.rs`

- Retourner le catalogue unifié ou les probes réels au lieu d’un petit catalogue divergent.
- Conserver les protections SSRF existantes.

#### `src-tauri/src/commands/codex_app_server.rs`

- Traiter les requêtes serveur→client, approvals et erreurs de version.
- Exposer un tour agentique outillé ou déclarer explicitement le bridge Chat-only.
- Ajouter un fake app-server déterministe pour tests d’intégration. Couvre AC6, AC8.

#### `src-tauri/src/commands/codex.rs`

- Séparer clairement chat Codex read-only et agent Codex.
- Persister thread/turn et permettre reprise/kill selon les capacités app-server.

#### `src-tauri/src/commands/mcp.rs`

- Ajouter metadata d’effets/risque aux outils et appliquer Plan/Auto/Full.
- Ajouter garde SSRF pour transports HTTP.
- Garder secrets importés au keychain et migrer les configurations manuelles sensibles.

#### `src-tauri/src/commands/mcp_sources.rs`

- Ajouter un adaptateur Cursor seulement pour les formats observables et documentés.
- Marquer la profondeur de compatibilité de chaque source : config, MCP, agents, rules.

#### `src-tauri/src/commands/agent_defs.rs`

- Borner read/write aux répertoires autorisés `.claude/agents`/`.shugu/agents`.
- Appliquer `enabled` et `tools` au runtime.
- Valider frontmatter, modèle et capacités avant lancement.

### Vérité Settings et Connections

#### `src/features/code/views-code.tsx`

- Extraire puis supprimer les sections statiques/session-only identifiées à `:451-527`, `:648-708`.
- Ne conserver aucune valeur `connected`, AES, version, plateforme ou capacité sans source backend.
- Remplacer les contrôles cliquables `<div>` par des composants sémantiques.

#### `src/features/settings/GeneralSettings.tsx` (nouveau)

- Persister chaque option dans SQLite, avec valeur effective et défaut documenté.

#### `src/features/settings/ModelSettings.tsx` (nouveau)

- Afficher uniquement les providers réels depuis Connections/model discovery.
- Lier choix de modèle, advisor, autocomplete et image aux mêmes registres.

#### `src/features/settings/PrivacySettings.tsx` (nouveau)

- Afficher honnêtement SQLite non chiffré et keychain pour secrets.
- Brancher télémétrie ou retirer l’option.
- Conserver effacement/export/backup derrière confirmation réelle.

#### `src/features/settings/AboutSettings.tsx` (nouveau)

- Lire version Tauri, OS, arch, WebView2, schéma DB et versions providers depuis diagnostics.

#### `src/features/connections/Connections.tsx`

- Séparer catalogue de providers et instances configurées.
- Déclarer connecté uniquement après probe/auth réel.
- Retirer Google Drive/iCloud vides ou les marquer indisponibles.
- Rendre modales, labels, boutons secrets et navigation accessibles.

#### `src/lib/credentials.ts` / `src-tauri/src/commands/credentials.rs`

- Limiter les lectures de secret brut au strict besoin IPC et éviter leur conservation frontend.
- Ajouter tests d’intégration keychain derrière flag environnement.

#### `src-tauri/src/commands/diagnostics.rs`

- Exposer version produit, Tauri, OS/arch, WebView2, DB, sandbox et probes providers pour About/diagnostics.

### Média et Gallery

#### `src/features/chat/views-chat.tsx`

- Corriger la structure tabs/panels média avec rôles ARIA et panels non recouvrants.
- Retirer prompts/quota/plan codés en dur.
- Unifier la persistance Image/Vidéo/Musique et leurs états erreur/progress/cancel.
- Ajouter labels explicites à chaque champ.

#### `src/styles/styles.css`

- Retirer l’overlay `.image-shell { position:absolute; inset:0 }` qui intercepte les onglets (`:740`).
- Ajouter focus visible, reduced-motion et styles des vrais tabpanels.

#### `src/lib/mediaGenProviders.ts`

- Unifier les capacités/probes médias et déclarer quels types chaque provider supporte réellement.

#### `src-tauri/src/commands/video.rs` / `music.rs` / `image.rs`

- Retourner un résultat média commun, progress events, cancel et metadata persistables.
- Valider URL/provider, taille et type des téléchargements.

#### `src/lib/db.ts`

- Étendre `generations` ou créer `media_assets` pour type, chemin, provider, statut et metadata.
- Retirer tous seeds produit hors mode démo explicite.

#### `src/features/code/views-code.tsx` — Gallery

- Ne plus rendre comme génération terminée une ligne sans fichier.
- Ajouter états missing/error/retry et filtrage réel.

#### `src/mocks/seedGalleryFolders.ts`

- Supprimer de la composition production ; conserver uniquement comme fixture de test.

### Tests réels et qualité

#### `src-tauri/src/commands/agents/lifecycle.rs` tests (première tranche)

- Tester : réponse informative, mutation sans plan, mutation sans vérification, vérification échouée, vérification réussie, mutation après vérification, lecture seule et budget épuisé.

#### `src-tauri/src/commands/agents/runner.rs` tests

- Introduire un provider fake scripté pour exécuter le vrai `tool_use_loop` sans API payante.
- Tester plan→write→test→final, repair après échec, stall, kill, sous-agent et compaction.

#### `evals/lib/agent.mjs` / `evals/run.mjs`

- Partager ou générer le prompt réel afin d’éviter la dérive.
- Renommer self-check pour ne jamais l’afficher comme score modèle.
- Ajouter baselines live par famille provider avec coûts/credentials explicites.

#### `playwright.config.ts`

- Corriger pnpm immédiatement.
- Conserver le smoke web comme gate distincte, sans le présenter comme E2E produit.

#### `scripts/tauri-native-tour.mjs` (nouveau)

- Lancer `tauri-dev.cmd` avec port CDP WebView2 réservé.
- Se connecter au vrai WebView, dérouler Chat/Plan/Auto/Full, Settings, Connections, Image/Vidéo/Musique, Gallery, Agents/Git et capturer console/captures.
- Garantir nettoyage exact des processus lancés.

#### `e2e-native/*.spec.mjs` (nouveau)

- Vérifier les IPC et données locales dans le vrai binaire, avec workspace fixture temporaire.
- Interdire toute utilisation du profil utilisateur réel durant les scénarios mutatifs.

#### `package.json`

- Ajouter `test:native`, `test:agent-integration`, `test:eval:live:*`, `verify:p0`.
- Conserver pnpm exclusivement.

#### `eslint.config.js` et dépendances

- Faire échouer les règles bug-shaped et réduire progressivement les 302 warnings.
- Mettre à jour Vitest/Vite/ws et autres dépendances vulnérables après tests de compatibilité.

## Initial implementation slice

La première tranche implémentée immédiatement sera :

1. `agents/lifecycle.rs` avec contrat et tests purs.
2. Intégration du completion gate dans `runner.rs` sans changer encore les profils de permissions.
3. Correction des prompts pnpm les plus dangereux.
4. Correction de `playwright.config.ts` pour pnpm.
5. Exécution des tests Rust ciblés, du cycle complet Rust, de Vitest/typecheck/build, puis lancement Tauri natif et observation WebView2.

Cette tranche crée la première propriété vérifiable du futur système : un agent ayant modifié le projet ne peut plus sortir proprement sans plan et vérification réussie après sa dernière mutation.

## Acceptance criteria mapping

- AC1 : Settings/Connections/media/Gallery/docs vérité produit.
- AC2 : `lifecycle.rs`, `runner.rs`, événements/phases et tests fake-provider.
- AC3–AC4 : `policy.rs`, `tools.rs`, `exec.rs`, `sandbox.rs`, ModeSelector et profils persistés.
- AC5 : worktree, snapshot, kill, persistence/recovery.
- AC6 : capacités modèles, Codex/OpenCode/MCP/agent definitions.
- AC7 : Settings, Connections, médias, Gallery et SQLite.
- AC8 : tests lifecycle/runner, fake providers, evals live et E2E Tauri.
- AC9 : `prompts.rs`, `project_context.rs`, règles projet et package manager.
- AC10 : package scripts, quality gates, audits, lint et dépendances.

## Risks and constraints

- Une gate trop stricte peut bloquer les questions informatives : la décision se base donc sur les effets réellement observés, pas sur une classification fragile du texte utilisateur.
- L’isolation worktree doit intégrer les modifications non commitées avant de devenir le défaut.
- Les providers dépourvus de tool-calling natif nécessitent une adaptation testée ou doivent être déclarés non agentiques.
- Les tests natifs doivent utiliser une base et un workspace temporaires, jamais les données utilisateur réelles.
- Full Access restera volontaire et persistant seulement pour un workspace de confiance ; il ne générera aucune confirmation par commande une fois actif.

---

## Step Complete

**Status:** Complete — auto-approved
**Initial files planned:** 4 modified/new files plus tests
**Roadmap scope:** runtime, providers, data, UI, media, security and native verification
**Next:** step-03-execute.md
**Timestamp:** 2026-07-22

## Tranche 2 — plan exécutable par fichier

### `src-tauri/src/commands/agents/policy.rs`

- Ajouter `ExecutionProfile { Chat, Plan, Auto, FullAccess }` sérialisé en camelCase.
- Centraliser la conversion profil → politique, la lecture seule, l’exigence de sandbox et l’autorisation des effets.
- Faire des règles persistées `deny` un blocage exécutoire ; conserver `allow` comme réduction explicite du bruit sans contourner les détections structurelles dangereuses.
- Tester sérialisation, mapping, outils autorisés et refus explicites. Couvre AC3–AC4.

### `src-tauri/src/commands/agents/exec.rs` et `sandbox.rs`

- Remplacer le fallback implicite par une provenance typée : confiné, direct Full Access, ou indisponible/refusé.
- En Auto, retourner une erreur d’infrastructure sans démarrer le processus lorsque le confinement n’est pas disponible.
- En Full Access, ignorer volontairement le sandbox et journaliser l’exécution directe.
- Conserver codes de sortie/timeouts et préparer la propagation d’un abort token. Tester les deux voies Windows réelles et l’échec fermé. Couvre AC4–AC5.

### `src-tauri/src/commands/agents/tools.rs`

- Recevoir le profil effectif dans `execute_tool` et `run_command`.
- Bloquer une règle `deny` avant l’appel d’exécution.
- Rendre la provenance d’exécution visible dans le `ToolResult` et les logs.
- Garder les sorties non nulles comme feedback agentique. Couvre AC3–AC5.

### `src-tauri/src/commands/agents/runner.rs`

- Remplacer `read_only: bool` par `ExecutionProfile` tout au long de `run_agent_task`, `tool_use_loop`, appels outils et délégations.
- Utiliser une même fonction d’autorisation pour le manifest et le dispatcher ; en Chat/Plan, refuser tout MCP non classé plutôt que le laisser passer.
- Faire hériter le profil aux sous-agents ; faire d’Atelier/Grounded des runs Auto explicites.
- Ne jamais continuer in-place si une isolation demandée échoue. Couvre AC2–AC5.

### `src-tauri/src/commands/agents/mod.rs`

- Étendre `SpawnArgs`, `ContinueArgs`, `AgentRow` et l’événement `spawn` avec `execution_profile` et `isolate`.
- Résoudre une valeur par défaut rétrocompatible (`plan→Plan`, `chat→Chat`, sinon Auto), puis persister la valeur effective.
- Faire conserver profil/isolation aux reprises ; propager aux chemins Atelier, Grounded et délégué. Couvre AC3–AC5.

### `src-tauri/src/lib.rs` et `src-tauri/src/commands/backup.rs`

- Ajouter une migration V20 immuable avec `agents.execution_profile TEXT NOT NULL DEFAULT 'auto'` et `agents.isolate INTEGER NOT NULL DEFAULT 0`.
- Passer `TARGET_SCHEMA_VERSION` à 20 et vérifier l’alignement des migrations.
- Mettre à jour tous les INSERT/SELECT d’agents et ajouter des tests de mapping/persistance. Couvre AC3, AC5.

### `src/lib/agents.ts`

- Ajouter `ExecutionProfile` et les champs persistés à `AgentRow`, `SpawnArgs`, `ContinueArgs` et événements.
- Garder les champs obligatoires sur les nouvelles écritures, avec tolérance de lecture pour anciens événements. Couvre AC3.

### `src/features/chat/chat-sync.ts`

- Ajouter un profil d’accès session-scoped `auto|fullAccess`, Auto par défaut, synchronisé entre WebViews.
- Mapper explicitement Chat→Chat, Plan→Plan, Agent+Auto→Auto, Agent+Full Access→FullAccess.
- Transmettre profil et isolation à spawn/continue ; empêcher les conversions silencieuses Chat→Agent par agent personnalisé/mascotte.
- Ajouter des fonctions pures testables pour le mapping et les payloads. Couvre AC1, AC3–AC4.

### `src/features/chat/ModeSelector.tsx`

- Séparer les trois modes de travail du choix Auto/Full Access visible seulement en Agent.
- Afficher les conséquences réelles : Auto = sandbox obligatoire et workspace ; Full Access = machine directe, activation explicite, aucune confirmation par commande.
- Ne pas persister Full Access au redémarrage de l’application. Couvre AC1, AC3–AC4.

### `src/features/chat/QuestionCard.tsx` et `PlanApprovalCard.tsx`

- Conserver le profil/isolation du run source lors d’une reprise.
- Une approbation Plan bascule vers Auto par défaut, jamais vers Full Access implicite ; rollback UI en cas d’échec. Couvre AC3–AC4.

### `src/components/trust/trust.ts`, `ExecutionProfileCard.tsx`, `CommandRiskCard.tsx`

- Projeter le profil backend réel et la provenance (`sandboxed`, `direct`, `blocked`).
- Remplacer les formulations prétendant à une confidentialité/isolation non prouvée.
- Ne proposer les règles persistantes que lorsqu’elles modifient réellement la décision. Couvre AC1, AC3–AC4.

### Stratégie de tests de la tranche 2

- Rust : policy mapping/serde, gate Plan/MCP, deny bloquant, Auto fail-closed, Full Access direct, reprise et propagation de profil.
- Vitest : mode→profil, défaut Auto, Full Access non persistant, payload spawn/continue et cartes d’approbation.
- Gates : `cargo test`, `cargo check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm test:e2e`, `pnpm ui:tour`.
- Validation native : lancement `tauri-dev-log.cmd`, inspection des événements/SQLite et scénario réel Auto puis Full Access sur workspace temporaire.

**Statut :** plan complet, auto-approuvé ; passage à l’exécution.
