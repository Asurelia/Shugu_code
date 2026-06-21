# Audit d'écart consolidé — Shugu Forge (source de vérité)

Date : 2026-06-21
Projet : `F:\Dev\shugu_code`

Ce document **fusionne** quatre analyses en une seule source de vérité :

1. **RE profond** des 3 produits installés (Claude Desktop, Codex, OpenCode Desktop) — extraction réelle des binaires/asar + recherche web sourcée.
2. [`reverse-engineering-gap-audit-2026-06-21.md`](./reverse-engineering-gap-audit-2026-06-21.md) — sécurité d'exécution, MCP, durcissement Tauri.
3. [`ui-ux-gap-audit-2026-06-21.md`](./ui-ux-gap-audit-2026-06-21.md) — modèle de confiance UI/UX.
4. [`global-gap-matrix-2026-06-21.md`](./global-gap-matrix-2026-06-21.md) — opérabilité produit.

> **Verdict** : le cœur de Shugu est solide (vrai agent, pas un chat jouet). Les écarts ne sont pas dans le moteur mais dans **5 couronnes** autour : sécurité d'exécution *gouvernée*, mémoire *orchestrée*, UX *de confiance*, opérabilité *produit*, et **qualité d'agent *mesurée*** (le grand absent).

---

## 0. Les 5 angles morts (en tête de file — la vraie valeur ajoutée)

Ces points ne sont couverts par **aucune** des 4 analyses précédentes.

| # | Angle mort | Vérifié | Impact |
|---|---|---|---|
| **AM-1** | **Qualité / éval de l'agent** — aucun harness de tâches, `tests/`=`screenshots/` seul, 426 tests = logique pure | ✅ | On peut avoir une archi parfaite et un agent **médiocre**. Sans éval golden (pass/fail + non-régression comportementale), on améliore l'emballage sans savoir si le cœur progresse. **C'est la seule métrique qui dit si Shugu rattrape Claude Code/Codex là où ça compte.** |
| **AM-2** | **Mémoire / contexte orchestrée** — vecteur code-only + échec silencieux, pas d'épisodique, pas de hooks recall/remember, pas de compaction | ✅ | Les 3 docs parlent de backup SQLite, jamais d'orchestration mémoire. Le savoir s'évapore en session longue (drop à 30 messages, sans résumé). |
| **AM-3** | **Injection indirecte comme threat-model** — contenu web/fichier/**description d'outil MCP** non fiable → pilote l'agent → `run_command` | ✅ (démo live) | Doc 2 touche l'exfil réseau, Doc 3 l'UX, mais aucun ne traite l'injection→RCE comme principe de design. Une description d'outil MCP est une entrée **non fiable**. |
| **AM-4** | **Couche provider + couplage Codex** — routing, failover, budget tokens ; surtout Shugu **parse le JSONL de Codex** (qui a bougé 0.125→0.130→0.142 en jours) | ✅ (RE) | Une MAJ de Codex peut **casser Shugu en silence**. Aucune couche d'isolation de version / contrat de format. |
| **AM-5** | **Concurrence multi-agents** — worktree-par-session isole les *fichiers* mais pas la **DB SQLite ni l'index vectoriel partagés** | ✅ | Plusieurs agents en parallèle = races sur `shugu.db` et `vec_code`. |

---

## 1. Comment fonctionnent les 3 références (RE réel, condensé)

### Claude Desktop (v1.14271.0, MSIX, Electron 42)
- Moteur = **CLI `claude.exe` (Claude Code) embarqué et versionné à part** (`claude-code/2.1.181`), piloté en `--input/output stream-json`. Front = simple frontal.
- Exécution autonome (Cowork) = **microVM Hyper-V** (kernel Linux + `rootfs.vhdx` 7.8 Go + disque session jetable + pool « warm »). Mode code-sur-hôte = **worktree git par session** (`git-worktrees.json`, branche `claude/<nom>`, bail+merge+archive).
- Permissions : `auto` / `plan` / `bypassPermissions`. Extensions **DXT/MCPB** signées + double host MCP (utilityProcess in-process + multi-transport stdio/SSE/HTTP/WS). Secrets DPAPI.
- **Fait notable** : Claude Code a tourné sur **ce repo** (`cwd:"F:\\Dev\\shugu_code"`, `model:"claude-opus-4-8[1m]"`, `effort:"xhigh"`) — les worktrees `claude/*` orphelins viennent de là.

### Codex (app desktop MSIX **v26.616.32156**, modèle `gpt-5.5`/xhigh — RE local **vérifié sur disque 2026-06-21, preuves PE**)
- **Deux Codex coexistent** : le **CLI open-source** `@openai/codex` (npm `0.125.0`, lanceur Node `codex.js` → binaire Rust par plateforme `@openai/codex-win32-x64`) ET l'**app desktop packagée MSIX/Store** (`C:\Program Files\WindowsApps\OpenAI.Codex_26.608.1337.0_x64…`) dont le cœur est `codex.exe` Rust **245 Mo** (boucle submit/event, outils, system prompt embarqué, sandbox, MCP client+serveur, `app-server`).
- **Sandbox Windows = identité OS + DACL NTFS + WFP** (PAS intégrité, PAS AppContainer, **PAS** restricted-token comme primitive principale — *l'audit précédent disait `CreateRestrictedToken`, faux : les imports PE montrent `CreateProcessAsUserW`*) :
  - `codex-windows-sandbox-setup.exe` (élevé) crée **2 comptes locaux dédiés** `CodexSandboxOffline`/`Online` (`NetUserAdd`) + un **groupe sandbox** (`NetLocalGroupAdd`/`AddMembers`) ; mots de passe **chiffrés DPAPI** dans `.sandbox-secrets/sandbox_users.json` (pas en clair).
  - **DACL NTFS** (`SetNamedSecurityInfoW`) : **write-ACE** sur les write-roots (workspace + `Temp`) pour le groupe sandbox + un **capability-SID** ; **read-ACE sélectif** (« read-acl-only mode », ex. `.claude.json`, `.mcp.json`). ⇒ **lectures FERMÉES par défaut** (compte distinct = zéro accès au profil utilisateur), ouvertes au cas par cas.
  - **Réseau** : `FwpmEngineOpen`/`FwpmFilterAdd` (**WFP**) + `INetFwRule` → compte *offline* **coupé du réseau**, *online* autorisé. `[windows] sandbox = "elevated"`.
  - **Exécution** : `codex-command-runner.exe` (copié versionné dans `.sandbox-bin/`, ici `0.138.0-alpha.7`) lance chaque commande via **`CreateProcessAsUserW`** AS le compte choisi (+ `AdjustTokenPrivileges`). ⚠️ Provisioning lourd (élévation, comptes, DPAPI, WFP, helper) **mais invisible à l'usage** ; ce n'est PAS Docker.
- **Plateforme** (bien au-delà d'un CLI) : **marketplace de plugins** (`figma`, `github`, `google-calendar`, `documents/spreadsheets/presentations`, `pdf`, `browser`), **computer-use** (`runtimes/cua_node/**/@oai/sky/bin/windows/codex-computer-use.exe`, pipe nommé, clients browser **SHA-256-pinned**), **JS REPL natif comme serveur MCP** (`node_repl.exe`), **LSP via `@mizchi/lsmcp`** (typescript-language-server), **trust par projet** (`[projects.*] trust_level="trusted"` — dont `f:\dev\shugu_code`).
- **Persistance** `~/.codex` : `goals_1.sqlite`, `memories_1.sqlite`, `logs_2.sqlite` (WAL), `state_5.sqlite`, `sessions/`+`archived_sessions/`+`session_index.jsonl`, `skills/`, **`rules/default.rules`** = **règles d'auto-allow apprises** (`prefix_rule(pattern=[…], decision="allow")` → mémorise tes approbations de commandes entre sessions). Auth `chatgpt` JWT OAuth (`auth.json`).

### OpenCode Desktop (v1.17.9, Electron + SolidJS)
- Front Electron ↔ **serveur agent bundlé** (`utilityProcess`/sidecar) parlant **HTTP+SSE loopback authentifié** (password UUID + Basic auth + CORS `oc://`). Même serveur que la CLI → zéro duplication.
- Boucle = **Vercel AI SDK** `streamText`. Outils : bash (node-pty), edit/write/read, grep/glob (ripgrep), patch (apply_patch), webfetch, task (sous-agents), todowrite.
- **Pas de sandbox OS**, mais permissions **`allow/ask/deny` par outil, mémorisées** (table SQLite `permission`) + **snapshots git-like** (`snapshot/<sha>`) pour revert. Multi-provider via models.dev. Persistance SQLite (Drizzle) + event-sourcing.
- **A migré de Tauri → Electron** (cœur 22 Mo de TS). → valide le choix Tauri de Shugu (cœur Rust = pas ce problème).

---

## 2. Matrice d'écart globale

> État Shugu = **vérifié dans le code** (2026-06-21). Gravité : 🔴 critique · 🟠 élevée · 🟡 moyenne · 🟢 OK.

| Dimension | Claude Desktop | Codex | OpenCode | **Shugu (vérifié)** | Grav. | Direction recommandée |
|---|---|---|---|---|:--:|---|
| Cœur agent / boucle | CLI stream-json | Rust mono-binaire | serveur TS | **boucle Rust `runner.rs`** ✅ | 🟢 | garder |
| Front ↔ cœur | spawn stream-json | app-server ws | HTTP+SSE loopback | **IPC Tauri + events** ✅ | 🟢 | garder |
| Exécution / sandbox | microVM Hyper-V | **comptes dédiés+DACL+WFP** (`CreateProcessAsUserW`) | aucun OS | **MIC-low livré** (writes confinés ; reads/réseau ouverts) | 🟠 | OK comme 1er pas léger ; v2 = comptes+DACL+WFP si reads-deny / net-gate voulus |
| Permissions / auto | auto/plan/bypass | policy×sandbox | allow/ask/deny mémo. | **plan-mode seul** | 🔴 | risk-gate (pause *seulement* sur dangereux) |
| Revert / rollback | worktree merge | `apply`/fork | snapshots `<sha>` | **git utilisateur** | 🟠 | auto-snapshot + revert 1-clic |
| Mémoire / compaction | compaction + worktree | pipeline mémoire dédié | event-sourcing | **skills/lessons ✅, vecteur dormant, pas de compaction** | 🟠 | bus mémoire + hooks recall/remember + compaction→épisodique |
| Sessions / persistance | JSON | JSONL + SQLite | SQLite + ES + snapshots | **SQLite source de vérité** ✅ | 🟢 | garder, ajouter backup |
| Multi-agent | sub-agents Task | natif (graphe) | task | **advisor + délégués (partiel)** | 🟡 | formaliser + gérer la concurrence DB (AM-5) |
| MCP | DXT/MCPB + 4 transports | client+serveur | stdio/HTTP/SSE | **client `rmcp` (stdio+SSE)** ✅ | 🟡 | + import multi-source + inventaire UI |
| Édition fichiers | str_replace | apply_patch V4A | apply_patch | **`fs_edit` args JSON** ✅ | 🟢 | garder (robuste cross-provider) ; + fuzzy/repli gros fichiers |
| Secrets | DPAPI | **clair** ⚠️ | auth.json | **OS keychain** ✅ | 🟢 | garder ; étendre aux env MCP |
| Cycle worktree | bail+cleanup | worktrees | — | **aucun ; 6 orphelins / 57 Go** | 🔴 | service worktree + cleanup + storage UI |
| Sécurité Tauri/renderer | — | — | sandbox renderer | **`csp:null`, `shell/fs:default`** | 🔴 | CSP stricte + capabilities granulaires |
| Réseau / SSRF | — | net=approval | — | **`custom base_url` TODO allowlist** | 🟠 | allowlist + blocage IP privée |
| UX de confiance | connecteurs/permissions | threads/worktree/sandbox | Plan/Build | **`Grounded Run` vert trompeur, chip `local` ambigu** | 🔴 | ExecutionProfileBadge + risk card + contrat Ask/Plan/Act |
| Navigation / périmètre | focalisé | sobre code | Plan/Build/config | **rail large : +Image/Studio/Gallery/Voice/Mascot** | 🟡 | recentrer sur le cœur agent, périphérie en plugins |
| Accessibilité | natif | TUI/desktop | — | **`div/span` cliquables, `outline:none`, `transition:all`** | 🟠 | contrôles sémantiques + aria + focus-visible + reduced-motion |
| Design system | — | tokens | — | **inline styles partout** | 🟡 | primitives (RiskBadge, PermissionBadge…) + tokens |
| **Qualité agent (éval)** | — | (interne) | — | **AUCUN harness** (AM-1) | 🔴 | harness golden pass/fail + non-régression |
| Release / update | MSIX signé | MSIX | electron-updater | **pas d'updater, v0.1.0** | 🟠 | stratégie release Windows + signing |
| Backup / restore | — | — | — | **pas d'UX backup** | 🟠 | Export/Import + backup pré-migration |
| Observabilité | logs | logs SQLite | electron-log | **dev-logs seul** | 🟡 | Diagnostics Center + redaction |
| Tests E2E / supply-chain | — | — | — | **aucun e2e/audit script** | 🟡 | playwright Tauri + `pnpm/cargo audit` |

---

## 3. Backlog priorisé unifié

> « Copier de qui / éviter quoi » calibré par le RE réel.

### P0 — Fondation de confiance (sécurité fluide, SANS Docker ni prompts permanents)
- **P0-a (backend)** : `ExecutionPolicy` (ReadOnly/WorkspaceWrite/FullLocal) + `CommandRisk` (risk-gate : pause *seulement* sur dangereux) + kill process-tree Windows (Job Object). *Copier le **modèle d'auto-allow appris de Codex** (`~/.codex/rules/default.rules` : `prefix_rule(…, decision="allow")` mémorise tes approbations entre sessions) + la mémorisation `allow/ask/deny` d'OpenCode. Le sandbox-comptes de Codex (`CreateProcessAsUserW`+DACL+WFP) = option **forte** ; on a livré le **MIC-low** (writes-only) comme 1er pas léger.*
- **P0-b (backend)** : auto-snapshot avant chaque tour + revert 1-clic. *Copier d'OpenCode (`snapshot/<sha>`).*
- **P0-c (UI)** : `ExecutionProfileBadge` permanent + risk card avant `Grounded Run` + contrat Ask/Plan/Act par message. *Copier de Codex (worktree/permissions visibles).*
- **P0-d (config)** : CSP stricte + capabilities granulaires (retirer `shell/fs:default`).

### P1 — Opérabilité + intégration
- **P1-a** : service worktree/session (create/list/cleanup/size) + **nettoyage des 6 orphelins / 57 Go**. *Copier de Claude Desktop (`git-worktrees.json`, bail).*
- **P1-b** : MCP inventory + import Claude/Codex/OpenCode (adapters) + secrets keychain.
- **P1-c** : **mémoire unifiée** — bus + hooks recall/remember + compaction→épisodique + vecteur au-delà du code + surfacer les échecs d'index. *Copier de Codex (`memories_1.sqlite`).*
- **P1-d** : **harness d'éval agent** (AM-1) — tâches golden, run headless, score, non-régression.
- **P1-e** : provider/network allowlist (anti-SSRF) ; isolation de version du couplage Codex (AM-4).

### P2 — Qualité & robustesse produit
- Accessibilité (sémantique + aria + focus-visible + reduced-motion) · backup/restore + tests migration · Diagnostics + Storage Center + privacy/redaction · `lint`/`test:e2e`/`pnpm audit`/`cargo audit` · concurrence DB multi-agents (AM-5).

### P3 — Dette long terme
- Discipline périmètre (périphérie créative en plugins) · TS `strict` progressif (credentials/mcp/agents/db d'abord) · unification du registre de commandes ([`command-registry-mapping.md`](./command-registry-mapping.md)) · design-system / primitives.

---

## 4. Provenance des findings

| Finding | RE profond | Audit RE | Audit UI/UX | Matrice globale | Ce doc |
|---|:--:|:--:|:--:|:--:|:--:|
| Archi des 3 références (interne réelle) | ✅ | | | | |
| Calibrage sandbox (comptes+DACL+WFP, preuves PE) | ✅ | | | | ✅ vérifié 2026-06-21 |
| exec direct / git seul | ✅ | ✅ | | | |
| `csp:null` / capabilities larges | | ✅ | | partiel | ✅ vérifié |
| 6 worktrees orphelins / 57 Go | | ✅ | | ✅ | ✅ vérifié |
| `Grounded Run` vert / chip `local` | | | ✅ | | ✅ vérifié |
| Accessibilité (div/span, focus, motion) | | | ✅ | partiel | |
| Opérabilité (release/backup/diag/E2E) | | | | ✅ | |
| **Mémoire orchestrée** (AM-2) | ✅ | | | | ✅ |
| **Éval agent** (AM-1) | | | | | ✅ vérifié |
| **Injection threat-model** (AM-3) | ✅ | | | | ✅ |
| **Couplage Codex / providers** (AM-4) | ✅ | | | | ✅ |
| **Concurrence DB** (AM-5) | | | | | ✅ |

---

## 5. Architecture cible interne

```
┌─ Front Tauri (WebView) ── consommateur d'events (deltas, recall, exec-profile) ─┐
│                               ▲ IPC + events                                    │
└───────────────────────────────┼─────────────────────────────────────────────────┘
                                ▼
   CŒUR RUST — seule source de vérité de la logique agent
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Agent loop (runner.rs)                                               │
   │   ├─ MEMORY BUS ── recall() avant / remember() après        [P1-c]   │
   │   │     working · episodic · procedural(skills) · semantic · compact  │
   │   ├─ TOOL ROUTER ── ExecutionPolicy + risk-gate             [P0-a]   │
   │   │     └─ EXEC ── snapshot→run (token restreint+Job+net-off)[P0-b/d] │
   │   ├─ COMPACTION ── résume → écrit dans episodic             [P1-c]   │
   │   ├─ WORKTREE/SESSION lifecycle (bail + cleanup)            [P1-a]   │
   │   ├─ MCP client (multi-source) ✅ + import                  [P1-b]   │
   │   └─ providers (routing + failover + budget)               [P1-e]   │
   └──────────────────────────────────────────────────────────────────────┘
   Persistance : SQLite (vérité) + sqlite-vec ✅   |   Éval : evals/ (golden) [P1-d]
```

Principe directeur des 3 références : **cœur agent autonome, front jetable.** Shugu y est à ~80 % (cœur Rust + IPC découplé). Les 20 % = sécurité gouvernée + mémoire orchestrée + qualité mesurée.

---

## 6. Journal de vérification (confronté au code réel, 2026-06-21)

| Claim | Source | Vérif |
|---|---|---|
| `tauri.conf.json` → `"csp": null` | audit RE | ✅ ligne 43 |
| `capabilities/default.json` → `shell:default`+`fs:default`+SQL large | audit RE | ✅ lignes 17-23 |
| `Grounded Run` vert (#4ade80=success) | audit UI | ✅ `AgentsPanel.tsx:127` |
| `.claude`=33,8 Go, `target`=23 Go | audit RE/global | ✅ mesuré |
| 12 worktrees, 6 trackés → 6 orphelins | audit RE | ✅ `git worktree list` |
| pas de `lint`/`e2e`/`release`/`audit` ; `v0.1.0` | matrice globale | ✅ `package.json` |
| aucun harness d'éval ; `tests/`=`screenshots/` | **ce doc (AM-1)** | ✅ |
| secrets → OS keychain (`keyring`) | — | ✅ `credentials.rs` |
| MCP client `rmcp` stdio+SSE, `mcp__server__tool` | — | ✅ `mcp.rs` |
| skills/lessons injectés chaque run | — | ✅ `runner.rs:682,698` |
| vecteur auto-indexé (5 s, TTL 24 h) mais échec silencieux | — | ✅ `workspaceIndexer.ts`, `RootLayout.tsx:613` |

---

## 7. Plan d'exécution parallèle

Voir [`parallel-execution-plan-2026-06-21.md`](./parallel-execution-plan-2026-06-21.md) — découpage en *lanes* à fichiers disjoints pour N instances Claude Code en parallèle.
