# Matrice globale des ecarts - Shugu Forge

Date: 2026-06-21

## Reponse honnete

Non, je ne peux pas garantir "rien oublie" au sens absolu.

Ce qui est couvert maintenant:

- architecture agent / reverse engineering comparatif;
- securite execution locale;
- MCP / configs Claude-Codex-OpenCode;
- UI/UX produit;
- dette worktrees / stockage;
- validation locale typecheck/tests/cargo.

Ce qui n'avait pas encore ete formalise:

- release et update;
- privacy et telemetry;
- observabilite/logs;
- backup/restore;
- performance;
- accessibilite testee reellement;
- packaging Windows;
- dependencies/licences;
- tests E2E desktop;
- modele de donnees et migrations en condition de panne;
- onboarding utilisateur final.

Cette matrice complete la vue globale.

## Couverture globale

| Domaine | Etat | Risque | Priorite |
|---|---:|---|---:|
| Agent execution security | Audite | Commandes directes, pas de sandbox forte | P0 |
| Worktrees/session lifecycle | Audite | 33.8 Go de worktrees, orphelins possibles | P0 |
| MCP compatibility | Audite | Configs Claude/Codex/OpenCode non importees | P1 |
| UI/UX trust model | Audite | Permissions et risque pas assez visibles | P0 |
| Tauri hardening | Audite partiel | CSP null, permissions larges | P0 |
| Secrets/keychain | Audite partiel | Bon modele provider, MCP env encore en clair possible | P1 |
| Provider/network security | Audite partiel | SSRF custom base_url | P1 |
| Tests unitaires | Verifie | 426 tests OK, mais pas de coverage global | P2 |
| Tests E2E desktop | Non couvert | Pas de parcours Tauri automatises | P1 |
| Release/update | Non couvert | Pas de strategie updater/signing visible | P1 |
| Crash/log observability | Partiel | dev-logs present, pas de console produit unifiee | P2 |
| Data backup/restore | Non couvert | SQLite local-first sans UX backup claire | P1 |
| Performance | Non couvert | Gros workspaces, UI dense, caches lourds | P2 |
| Accessibility | Audite statique partiel | div/span clickable, focus/motion | P1 |
| Dependency/license audit | Partiel | THIRD_PARTY present, pas d'audit supply-chain | P2 |
| Onboarding | Partiel | Onboarding existe, pas centre sur permissions/trust | P2 |

## Ecarts globaux oublies dans les premiers rapports

### 1. Release / update / distribution

Constat:

- `tauri.conf.json` a bundle active;
- pas de configuration updater visible;
- pas de signature/certificat/documentation release visible;
- scripts `package.json` n'ont pas de `lint`, `e2e`, `release`, `audit`;
- version `0.1.0`.

Risque:

- app difficile a distribuer proprement;
- pas de rollback update;
- Windows SmartScreen/signing non traite;
- erreurs en prod plus difficiles a diagnostiquer.

Actions:

- definir une strategie release Windows;
- ajouter Tauri updater ou choix explicite "no auto-update";
- documenter signing/certificat;
- ajouter script `pnpm release:check`;
- generer changelog et notes de migration.

### 2. Privacy / telemetry

Constat:

- pas de telemetry produit evidente cote code;
- donnees local-first;
- secrets via keychain pour providers;
- presence de logs locaux et potentiellement de contenus sensibles dans dev-logs.

Risque:

- meme sans telemetry, les logs peuvent contenir chemins, prompts, erreurs, noms de fichiers;
- l'utilisateur n'a pas de panneau privacy clair;
- aucune politique de retention des logs/caches/worktrees.

Actions:

- page Privacy;
- bouton "Open data folder";
- bouton "Clear logs/cache/worktrees";
- politique de retention par defaut;
- redaction secrets dans logs;
- export diagnostic filtre.

### 3. Backup / restore local-first

Constat:

- SQLite est source de verite;
- Convex est optionnel/dormant;
- pas de parcours UX backup/restore clair dans l'audit.

Risque:

- perte de conversations/settings/generations;
- migrations irreversibles sans backup automatique;
- difficile de deplacer Shugu vers une autre machine.

Actions:

- `Export Shugu Data`;
- `Import Shugu Data`;
- backup SQLite avant migration;
- retention de backups N derniers;
- verification integrity SQLite;
- documenter ce qui n'est pas exporte: modeles, caches, images lourdes.

### 4. Observabilite produit

Constat:

- `tauri-dev-log.cmd` est utile en dev;
- agents ont transcripts;
- toasts existent;
- pas de console diagnostic centrale.

Risque:

- quand un MCP, provider, Codex app-server, LSP, llama-server ou agent echoue,
  l'utilisateur doit deviner ou regarder;
- support difficile.

Actions:

- `Diagnostics Center`;
- timeline par sous-systeme:
  - Codex;
  - Claude/OpenCode imports;
  - MCP;
  - agents;
  - LSP;
  - git;
  - model providers;
- bouton "copy diagnostic bundle";
- redaction automatique des secrets.

### 5. Performance et stockage

Constat:

- worktrees `.claude` tres volumineux;
- `src-tauri/target` ~23 Go;
- app gere deja lazy file tree et caps;
- pas d'UX globale storage.

Risque:

- l'utilisateur perd de l'espace sans comprendre;
- index/watchers peuvent ralentir;
- backups deviennent enormes.

Actions:

- ecran Storage:
  - worktrees;
  - target/cache;
  - logs;
  - images;
  - embeddings/vector DB;
  - node_modules;
- cleanup safe;
- exclusions d'index;
- alertes de taille.

### 6. Tests E2E desktop

Constat:

- unit tests OK;
- pas de script Playwright/E2E visible dans `package.json`;
- `tests/` existe mais pas integre comme gate principal d'apres scripts.

Risque:

- regressions Tauri/WebView2 non detectees;
- UI agentique difficile a valider avec unit tests seulement;
- bugs de windows, focus, dialogs, drag/drop, split panels.

Actions:

- ajouter `test:e2e`;
- smoke Tauri:
  - open app;
  - open workspace;
  - chat read-only;
  - plan mode;
  - run command blocked/approved;
  - MCP add/test;
  - Git diff review;
  - worktree create/cleanup;
- captures screenshots desktop/mobile-ish window sizes.

### 7. Accessibility reelle

Constat:

- audit statique UI/UX a repere des patterns;
- pas de test axe/playwright;
- beaucoup de surfaces custom.

Risque:

- navigation clavier incomplete;
- focus perdu dans overlays/portals;
- screen reader pauvre;
- motion non reduite.

Actions:

- ajouter axe-core/Playwright;
- remplacer div/span clickable;
- focus trap dans modals;
- `aria-live` pour toasts/async;
- `prefers-reduced-motion`;
- audit contrastes.

### 8. Dependency / supply-chain

Constat:

- `THIRD_PARTY_NOTICES.md` existe;
- dependances nombreuses cote npm/Rust;
- pas d'audit automatise visible.

Risque:

- vuln transitive;
- licence oubliee;
- executable externe/MCP package lance via `npx` sans pin strict.

Actions:

- `pnpm audit`;
- `cargo audit` ou equivalent;
- pin versions MCP recommandees;
- SBOM;
- policy pour external binaries;
- licence scan.

### 9. Donnees et migrations

Constat:

- migrations declaratives dans Rust;
- SQLite local-first;
- tests surtout front/pure logic.

Risque:

- migration partielle ou corruption;
- downgrade impossible;
- schema Convex/SQLite divergent.

Actions:

- tests migration SQLite depuis DB anciennes;
- backup pre-migration;
- checksum/integrity check;
- outil repair/export;
- documentation schema authoritative.

### 10. Onboarding et comprehension

Constat:

- onboarding existe;
- mais le sujet majeur pour Shugu est la confiance agentique.

Risque:

- utilisateur configure un provider/MCP sans comprendre les permissions;
- confusion entre chat, plan, agent, grounded run;
- incomprehension de local vs sandbox.

Actions:

- onboarding "Choose your safety profile";
- demo read-only;
- demo worktree;
- expliquer MCP local/remote;
- expliquer ou sont les donnees.

## Roadmap globale recommandee

### Bloc A - Trust foundation

1. Execution profiles visibles.
2. Worktree par defaut.
3. Approval UI.
4. MCP inventory multi-source.
5. Tauri hardening.

### Bloc B - Operability

1. Diagnostics Center.
2. Storage Center.
3. Backup/Restore.
4. Privacy page.
5. Log redaction.

### Bloc C - Quality gates

1. `lint`.
2. `test:e2e`.
3. `cargo audit` / dependency audit.
4. migration tests.
5. accessibility tests.

### Bloc D - Release

1. release checklist;
2. signing/updater decision;
3. installer validation;
4. changelog;
5. crash/recovery documentation.

## Conclusion

Les deux premiers rapports couvrent bien les zones les plus urgentes:

- execution agent;
- MCP/configs;
- UI/UX de confiance.

Mais au global, Shugu doit aussi devenir operable comme un vrai produit desktop:

- sauvegardable;
- nettoyable;
- diagnostiquable;
- testable end-to-end;
- distribuable;
- comprehensible par un utilisateur qui n'a pas le code ouvert.

Ce rapport est donc la checklist globale qui manquait.

