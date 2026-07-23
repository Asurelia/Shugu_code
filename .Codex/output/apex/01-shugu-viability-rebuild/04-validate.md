# Step 04: Validate

**Task:** Remise à niveau complète de Shugu
**Started:** 2026-07-22

---

## Validation Progress

- Compilation Rust du module et de son intégration : réussie.
- TypeScript strict selon la configuration du dépôt : réussi.
- Bundle Vite production : réussi (567 modules).
- Inspection du diff : aucune altération des trois scripts Palworld non suivis.
- `git diff --check` : aucune erreur d'espace ; seulement les avertissements
  CRLF habituels du worktree Windows.
- `cargo fmt --check` global n'est pas exploitable comme gate aujourd'hui : de
  nombreux fichiers préexistants sont déjà non conformes. Le nouveau module
  `lifecycle.rs` a été formaté isolément avec rustfmt.
- `cargo check` conserve deux warnings préexistants autour de
  `ExecutionPolicy::FullLocal` / `allows_exec`, sans erreur.

## Validation tranche 2 — profils et sandbox

- `pnpm typecheck` : réussi.
- `pnpm lint` : réussi avec 0 erreur ; 302 avertissements préexistants restent
  visibles mais ne bloquent pas la gate actuelle du dépôt.
- `pnpm test` : 546/546 tests Vitest réussis dans 46 fichiers.
- Tests ciblés des profils frontend : 3/3 réussis.
- `cargo test` : 412/412 tests Rust réussis.
- Tests Rust ciblés `commands::agents` : 108/108 réussis.
- `cargo check` via l'environnement MSVC : réussi sans erreur.
- `pnpm build` : bundle de production réussi.
- `pnpm test:e2e` : smoke Playwright réussi, 1/1.
- `pnpm ui:tour` : tour complet réussi ; captures produites dans
  `dev-logs/ui-tour/`.
- Test Tauri natif réel via `tauri-dev-log.cmd` : application démarrée, WebView2
  réactive, sélecteur Auto/Full Access vérifié visuellement puis remis sur Auto.
- Migration native réelle v19→v20 vérifiée dans
  `%APPDATA%/dev.shugu.forge/shugu.db` : version 20 appliquée, colonnes et valeurs
  par défaut présentes, 0 profil invalide sur les 87 agents existants.
- Captures natives : `dev-logs/native-profile-selector.png`,
  `dev-logs/native-profile-access.png`, `dev-logs/native-full-access.png` et
  `dev-logs/native-profiles-v20.png`.
- Arrêt propre de l'environnement de test : processus natifs absents et port
  Vite 1420 libéré.
- `git diff --check` : aucune erreur ; avertissements CRLF Windows uniquement.
- `cargo fmt --check` global reste rouge à cause de milliers de différences de
  formatage préexistantes hors chantier. Aucun formatage global destructeur n'a
  été appliqué ; compilation et tests Rust sont tous verts.

### Critères vérifiés

- [x] Aucun processus n'est créé pour une commande interdite par profil ou
  règle `deny` (test par fichier marqueur absent).
- [x] Auto ne peut pas retomber silencieusement vers l'accès direct.
- [x] Full Access est l'unique provenance d'exécution directe volontaire.
- [x] Chat/Plan refusent les écritures et les outils MCP inconnus fail-closed.
- [x] Le profil et l'isolation survivent au stockage/rechargement SQLite.
- [x] L'interface native affiche la politique réellement appliquée.

---
## Step Complete — tranche 2
**Status:** ✓ Complete
**Typecheck:** ✓
**Lint:** ✓ (0 erreur)
**Tests:** ✓ 546 frontend + 412 Rust + E2E/UI/native
**Next:** audit adversarial, puis tranche providers/capacités
**Timestamp:** 2026-07-22T17:49:06+02:00

## Validation tranche 3 — audit contradictoire résolu

- `pnpm typecheck` : réussi après grant Full Access et états d'isolation.
- `pnpm test` : 546/546 tests frontend réussis.
- `cargo test --no-fail-fast` : 417/417 tests Rust réussis.
- Tests Rust ciblés `commands::agents` : 113/113 réussis.
- Test sandbox Windows fonctionnel : processus LOW réel, modification d'un
  fichier existant, refus d'écriture hors workspace, lecture externe autorisée.
- `pnpm build` : 567 modules, bundle production réussi.
- `pnpm ui:tour` : réussi, captures dans `dev-logs/ui-tour/`.
- `pnpm exec playwright test` : smoke Chromium 1/1 réussi.
- Tauri natif via `tauri-dev-log.cmd` : binaire réactif, aucun panic/crash.
- Backup pré-migration natif : v20→v22, 55 447 552 octets, `integrity_ok=true`.
- SQLite réel : `MAX(_sqlx_migrations.version)=22`, colonnes
  `profile_verified`/`isolation_status` présentes ; 87 anciens runs marqués
  non vérifiés (`profile_verified=0`, `isolation_status=none`).
- Test interactif Full Access : annulation→Auto, acceptation→Full direct,
  révocation→Auto. Captures sous `dev-logs/native-v22/`.
- Teardown : 0 processus `shugu-forge`, 0 listener sur le port 1420.

## Validation tranche 4 — ciblée pendant l'implémentation

- `pnpm typecheck` : réussi après Settings, Dock et médiathèque V23.
- Tests purs `toGenerationRow` : 2/2 réussis (migration implicite image et
  préservation vidéo/fichier local).
- Tests Rust des capacités de définitions : 2/2 réussis (alias, refus mutation,
  nom MCP exact et délégation mutante).
- `cargo check` via MSVC : réussi après V23 et filtrage runtime.
- Probe locale : `codex-cli 0.125.0` disponible ; Ollama binaire/API absents,
  donc aucune prétention de test live Ollama sur cette machine.
- `pnpm typecheck` : réussi sur l'état final de la tranche.
- `pnpm test` : 548/548 tests frontend réussis dans 47 fichiers.
- `cargo test --no-fail-fast` : 428/428 tests Rust réussis.
- `cargo check` via l'environnement MSVC : réussi.
- `pnpm lint` : 0 erreur ; 297 avertissements hérités restent à traiter par
  lots et ne sont pas masqués.
- `pnpm build` : réussi, 566 modules ; le warning de taille du chunk SideGit
  reste une dette de performance explicite.
- `pnpm exec playwright test` : smoke Chromium 1/1 réussi.
- `pnpm ui:tour` : tour complet réussi. Le premier passage a exposé un timeout
  réel sur `document.fonts.ready` ; le harness bloque désormais les requêtes
  Google Fonts avant les captures, ce qui rend le test local reproductible.
- Tauri/WebView2 réel via `tauri-dev-log.cmd` : compilation, démarrage et hooks
  frontend réussis ; processus `shugu-forge` réactif, aucun panic/crash.
- Backup natif pré-migration v22→v23 : 55 451 648 octets,
  `integrity_ok=true`.
- SQLite locale réelle : schéma 23, colonne `generations.kind` présente,
  18 lignes historiques conservées en `image`, 0 valeur invalide.
- Teardown ciblé terminé : 0 processus `shugu-forge` et 0 listener sur 1420.

## Step Complete — tranche 4
**Status:** ✓ Validée pour le périmètre livré
**Typecheck/build/lint:** ✓ (lint : 0 erreur)
**Tests:** ✓ 548 frontend + 428 Rust + Playwright/UI/Tauri natif
**Limite:** Ollama n'est pas installé sur ce PC ; son adaptateur est couvert par
un faux serveur HTTP et ne doit pas être présenté comme testé contre un daemon live.
**Next:** R1 — fake provider commun et cycle agentique complet multi-provider
**Timestamp:** 2026-07-22T20:25:00+02:00

## Validation tranches 5–7 — viabilité locale et RC

- `pnpm typecheck` : réussi.
- `pnpm test` : 51 fichiers, 559/559 tests frontend réussis sous Vitest 4.
- `pnpm lint` : 0 erreur, 0 warning sous ESLint 10.
- `pnpm build` : Vite 8, 554 modules, bundle réussi.
- `cargo fmt --all -- --check` et `cargo check` : réussis avec Rust 1.88.
- `cargo test --no-fail-fast` : 440/440 tests réussis, dont provider HTTP,
  sandbox Windows, worktrees, médias et sauvegarde/restauration.
- `pnpm run audit` : aucun advisory JS ; RustSec vert avec trois exceptions
  documentées et 22 warnings transitifs laissés visibles.
- `pnpm ui:tour` et Playwright Chromium : réussis (1/1).
- `pnpm native:smoke` : réussi sur deux boots, 0 erreur page/requête, IPC natif,
  backup/restore, Gallery missing/retry et teardown complet.
- Accessibilité native : 541 contrôles visibles nommés et 832 textes sans
  violation de contraste sur 11 états ; tabs média, focus-trap, Escape et
  restauration du focus vérifiés.
- Mesures dev : shell 22 354 ms, DOMContentLoaded 21 066 ms, heap JS 54 359 561
  octets, Tauri+WebView2 920 600 576 octets, restore boot 10 825 ms.
- `pnpm release:smoke` : assets embarqués servis par `tauri.localhost`, IPC
  réel, shell 943 ms, DOMContentLoaded 223 ms, heap 22 956 056 octets, working
  set 675 610 624 octets et 0 erreur page/console/requête.
- `pnpm tauri build` : réussi ; binaire release 72,06 Mio, MSI 28,70 Mio et
  installateur NSIS 21,70 Mio produits.
- Empreintes SHA-256 : binaire `EB8132AD09612BB92FDD55697C3574E8EC65490536D45A93100A7EEE35744D9D`,
  MSI `6D437B180E2687941B5B85A49F6C1CE9223C897F028C83D1A2C63DCDD3645129`,
  NSIS `42622065EB44F76B7A7999FFBB7D84C1BB0663505D53D9743ED4C038BAB51DC1`.

**Limite externe :** Ollama n'est pas installé et aucun secret cloud n'a été
inventé. P4.3 reste donc une campagne live à exécuter avec les providers choisis.

## Validation tranche 8 — charge et optimisation vectorielle

- Nouveau `pnpm perf:smoke` sous identité, base, workspace et WebView2 isolés.
- Fixture : 1 200 fichiers TypeScript, 6 000 chunks FastEmbed/SQLite.
- Streaming concurrent : 1 200 fragments conservés, 196 événements coalescés,
  premier delta 437 ms, pause maximale 225 ms.
- Renderer : heartbeat maximal 57 ms, aucune erreur page/console/réseau.
- Full-index initial : 197,1 s ; après batch FastEmbed/transaction : 89,2 s
  (−54,8 % sur le dernier passage).
- Scan chaud : 147 ms ; incrémental 120 fichiers : 10,46 s ; recherche : 25 ms.
- Mémoire sous charge : 1 239 568 384 octets, sous le budget dur de 1,5 Gio.
- `cargo-msvc.cmd check`, 440 tests Rust, 559 tests frontend, build, lint,
  audit, tour UI, Playwright et smoke natif deux boots : tous verts.
- Teardown : 0 processus, 0 listener 1420, aucun profil/workspace de charge.

## Validation tranches 9–10 — providers live multi-famille et RC finale

- `pnpm provider:smoke:live` : vrai Tauri/WebView2, Codex authentifié
  `gpt-5.4-mini`, chat Qwen 2B/Vulkan et agents Qwen3 8B et Llama 3.1 8B sous
  llama.cpp.
- Le test live a exposé puis permis de corriger quatre défauts réels : résolution
  Codex vers le package WindowsApps non exécutable, `submit_plan` visible en
  Auto, `todo_write` absent du toolset réduit et mutation autorisée avant plan.
- Cycles agents finaux persistés :
  `todo_write → fs_write_file → run_command(exit 0) → complete`. Full Access a
  été confirmé par le dialogue natif une fois, utilisé sans confirmation par
  commande, puis révoqué. Le fichier preuve contient exactement les 13 octets
  `LIVE_AGENT_OK`.
- Preuves providers : `20260723-083956` pour Llama 3.1 8B,
  `20260723-084138` pour Qwen3 8B et `20260723-065615` pour Codex probe/chat.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `cargo fmt`, `cargo check`,
  `pnpm audit:js` et `git diff --check` : réussis.
- `pnpm test` : 559/559 ; `cargo test --no-fail-fast` : 455/455.
- `pnpm ui:tour` et Playwright Chromium : réussis.
- `pnpm native:smoke` :
  `dev-logs/native-smoke/20260723-085036/`, 534 contrôles et 827 textes sans
  violation, backup/restauration et teardown complets.
- `pnpm perf:smoke` :
  `dev-logs/perf-smoke/20260723-085249/`, 6 000 chunks en 88,55 s,
  streaming concurrent sans perte et 0 erreur.
- `pnpm release:smoke` :
  `dev-logs/release-smoke/20260723-090150/`, shell 804 ms,
  `tauri.localhost`, IPC réel et 0 erreur.
- `tauri-dev.cmd build` : binaire, MSI et NSIS actuels produits. Empreintes :
  binaire `23030AC846BE8ED783DC7D18EAF7026A412C467D263CA170F88374CECCA04C10`,
  MSI `20E1C1AA67D4D9F51B4858BFBA50AD077318EF3E0BE94E0974CBDA03B1E8A906`,
  NSIS `34C2ECA1CE24A9D5BB940B97C6E84F631FB14C9C785FAF40C679377FC91E4E66`.

**Limites honnêtes :** P4.3 est validé par deux familles locales réelles, sans
les confondre avec deux clouds distincts. Le quota Codex était épuisé lors des
deux derniers runs locaux : `-SkipCodex` l'a enregistré sans compter de succès,
et la preuve Codex antérieure reste la référence. Mistral n'est pas revendiqué,
car les GGUF essayés n'ont pas produit d'appels d'outils stables.
