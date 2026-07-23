# Step 03: Execute

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Implementation Log

### Tranche 1 — contrat de complétion agentique

- Ajout de `src-tauri/src/commands/agents/lifecycle.rs`, module pur qui suit :
  plan accepté, mutations réussies, dernière mutation et vérification verte
  postérieure.
- Une vérification lancée dans le même tour qu'une écriture n'est pas acceptée :
  les outils du tour peuvent s'exécuter en parallèle et créeraient une course.
- Une commande non-zéro reste du feedback pour la boucle, pas une preuve.
- Une nouvelle mutation invalide la précédente vérification verte.
- `browser_test` peut fournir la preuve pour les parcours UI.
- Intégration dans `runner.rs` : une réponse texte prématurée est conservée dans
  l'historique, puis le contrôleur réinjecte l'action manquante. À épuisement du
  budget, le run devient `error` avec un motif explicite au lieu de `complete`.
- Suppression du second faux succès : les tool-calls demandés au dernier tour
  ne sont plus acceptés sans exécution.

### Tranche 1 — cohérence toolchain et tests

- Prompts Grounded, Atelier et Orchestrator rendus package-manager-aware ; dans
  un projet pnpm ils imposent `pnpm` / `pnpm exec`.
- Installation Playwright Atelier remplacée par la chaîne pnpm.
- `playwright.config.ts` exécute désormais le build et preview via pnpm.
- Le smoke navigateur tolère `transformCallback`, erreur documentée et attendue
  uniquement lorsque le bundle Tauri est ouvert hors WebView2.

### Fichiers modifiés

- `src-tauri/src/commands/agents/lifecycle.rs`
- `src-tauri/src/commands/agents/mod.rs`
- `src-tauri/src/commands/agents/runner.rs`
- `playwright.config.ts`
- `e2e/smoke.spec.ts`

### Tranche 2 — profils d'exécution réels et isolation fail-closed

- Ajout d'un profil sérialisé unique `chat | plan | auto | fullAccess`, résolu
  côté Rust et propagé à chaque agent, reprise, délégation et appel d'outil.
- `Chat` et `Plan` sont réellement en lecture seule ; les outils inconnus et
  MCP sont refusés par défaut au lieu de contourner la politique.
- `Auto` peut modifier le workspace uniquement sous confinement Windows. Si le
  sandbox est indisponible ou échoue à démarrer, la commande est bloquée : il
  n'existe plus de repli silencieux vers l'exécution directe.
- `Full Access` est le seul profil autorisant volontairement l'exécution directe
  sur la machine, sans demandes de confirmation par commande. Sa sélection est
  limitée à la session de l'application et revient à `Auto` au redémarrage.
- Les règles utilisateur `deny` bloquent désormais la commande avant création
  du processus. La provenance `sandboxed | fullAccessDirect | blocked` est
  conservée dans les résultats et les logs.
- Une isolation worktree explicitement demandée qui échoue arrête le run avant
  mutation au lieu de continuer en place.
- Migration SQLite v20 : persistance de `execution_profile` et `isolate` sur
  chaque agent, avec contraintes de validité et migration préservant les runs
  existants en `auto`.
- L'interface expose clairement Chat, Plan, Agent Auto et Agent Full Access ;
  les badges et panneaux affichent la politique réellement exécutée et ne
  promettent plus une confidentialité locale ou une isolation inexistante.
- L'approbation d'un plan bascule explicitement vers `Auto`, jamais vers
  `Full Access` de manière implicite.

### Tranche 2 — fichiers principaux

- `src-tauri/src/commands/agents/{policy,sandbox,exec,tools,runner,mod}.rs`
- `src-tauri/src/lib.rs`, `src-tauri/src/commands/backup.rs`
- `src/lib/agents.ts`, `src/features/chat/chat-sync.ts`
- `src/features/chat/{ModeSelector,PlanApprovalCard,QuestionCard,views-chat}.tsx`
- `src/features/agents/{AgentsPanel,useEvents}.tsx`
- `src/features/chat/executionProfiles.test.ts`

---
**Tranche 2 exécutée :** 2026-07-22T17:49:06+02:00

### Tranche 3 — résolution contradictoire et autorité native

- Profil demandé devenu autorité durable : aucun conflit IPC ne peut promouvoir
  Chat/Plan vers Auto.
- MCP inconnu refusé en Auto ; `browser_test` retiré des profils lecture seule ;
  capture d'écran revérifiée au dispatch.
- Règles de commande fail-closed et `deny` prioritaire quel que soit l'ordre SQL.
- Chemins de définitions d'agents limités aux répertoires `.claude/agents`
  globaux ou du workspace et aux fichiers Markdown canoniques.
- Mutations shell détectées par empreinte du workspace et intégrées au contrat
  plan → mutation → vérification ; assertions navigateur rouges non comptées.
- Kill propage un drapeau atomique aux processus et Job Objects Windows ; les
  transitions terminales utilisent un CAS SQLite et ne ressuscitent plus un run.
- Reprise HITL V21 : claim atomique, profil/isolation issus du run source,
  libération sur échec et annulation du nouveau run si la finalisation échoue.
- Sandbox Auto sérialisé et testé avec un vrai processus LOW : modification d'un
  fichier existant autorisée, écriture hors workspace refusée, lectures ouvertes.
- Caches Auto déplacés sous `.shugu/agent-runtime` ; aucun cache utilisateur
  global ni `%TEMP%` n'est désormais relabellisé par Shugu.
- Full Access protégé par une boîte native unique par session. Le grant en mémoire
  est revérifié avant chaque outil et une révocation prend effet immédiatement.
- Migration V22 : `profile_verified` et `isolation_status` rendent honnêtes
  l'historique antérieur et l'état worktree effectivement observé.

### Tranche 4 — providers, prompts et vérité produit

- Matrice de capacités backend/frontend enrichie : streaming, reasoning, MCP,
  effort et support de boucle `native | compatible | chatOnly`. Un modèle
  Chat-only ne peut plus démarrer un profil agent mutatif.
- Composeur `prompts.rs` versionné (`shugu-agent-v3.0`) avec fingerprint,
  manifeste d'outils exact et événement `PromptComposed` durable.
- Chargeur `project_context.rs` borné pour AGENTS.md, CLAUDE.md, règles Cursor,
  OpenCode, package manager et commandes de vérification.
- Adaptateur Ollama structuré natif : `/api/chat`, NDJSON, thinking et tool calls,
  avec fake serveur HTTP local. Codex reste explicitement Chat-only tant que son
  loop autonome ne remonte pas les preuves au contrôleur Shugu.
- Les capacités `tools:` d'une définition Claude/Shugu filtrent désormais le
  manifeste et sont revérifiées au dispatch ; les outils MCP exacts sont isolés.
- Settings et Connections n'affichent plus de valeurs/connecteurs fictifs :
  probes modèles réels, diagnostics About, confidentialité honnête, connexions
  indisponibles clairement désactivées.
- Suppression des conversations, messages et dossiers Gallery de démonstration.
  Un premier lancement crée uniquement une conversation vide.
- Dock Agent relié au chat SQLite ; Output lit le journal SQLite ; Problems lit
  et révèle les diagnostics LSP actifs au lieu d'erreurs codées en dur.
- Migration V23 : médiathèque unifiée Image/Vidéo/Musique, persistance locale
  et rendu Gallery par type. Suppression des faux textes de quotas/plans.
- Publication de `docs/shugu-viability-roadmap.md` avec lots, statut et gates.

### Tranches 5–6 — récupération, médias, sauvegardes et qualité release

- Lifecycle des jobs média persistant : progression, annulation, fichier
  temporaire atomique, recovery `interrupted`, retry fidèle, reveal/delete
  confinés aux dossiers gérés et statut `missing` réconcilié au boot.
- Overlay de l'arbre Git non commité avant worktree, base SHA durable, merge
  propre/conflit, rejet et cleanup idempotent couverts par tests.
- Restauration SQLite passée d'un remplacement impossible à chaud sous Windows
  à un staging validé `shugu.db.pending-restore`, consommé avant l'ouverture du
  plugin SQL au boot suivant avec rollback de swap.
- Harness `pnpm native:smoke` : identifiant Tauri isolé, WebView2 CDP, vraie
  SQLite, deux boots, captures, IPC, audit de 215 contrôles, budgets et teardown.
- Vite 8, Vitest 4, ESLint 10, DOMPurify 3.4.12 ; 0 advisory JavaScript et lint
  0 erreur/0 warning. La mise à niveau DOMPurify a provoqué la découverte puis
  le durcissement d'une passe structurelle LSP indépendante du DOM de test.
- Rust : `crossbeam-epoch` 0.9.20, `plist` 1.10/`quick-xml` 0.41 pour Tauri,
  `xcap` 0.9.7 et `git2` 0.21. Les trois exceptions RustSec non atteignables ou
  build-only sont justifiées dans `docs/security-advisories.md`.
