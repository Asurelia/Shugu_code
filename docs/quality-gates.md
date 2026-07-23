# Quality Gates — Shugu Forge

This document covers the quality-gate tooling added under the **quality-gates**
lane: lint, end-to-end smoke, dependency/supply-chain audit, and the minimal CI
workflow. It maps directly to **Bloc C** of
[`global-gap-matrix-2026-06-21.md`](./global-gap-matrix-2026-06-21.md) (P2):
`lint`, `test:e2e`, `cargo audit` / dependency audit.

The gates are wired into `package.json`. ESLint now exits with zero errors and
zero warnings on the declared source perimeter; generated files, nested agent
worktrees and native Rust sources keep their own dedicated gates.

---

## 1. Lint (`pnpm lint`)

ESLint 10 **flat config** in [`eslint.config.js`](../eslint.config.js).

- **Errors only on dangerous / bug-shaped patterns** — `no-debugger`,
  `no-unreachable`, `no-cond-assign`, `react-hooks/rules-of-hooks`, duplicate
  keys/args/cases, `use-isnan`, `valid-typeof`, etc.
- **Warns on smells** — unused vars (`^_`-prefixed ignored), missing hook deps,
  `prefer-const`. Loose `any` remains accepted because this migrated codebase
  intentionally uses `strict: false`.
- **Off for style** — Prettier owns formatting; opinionated style rules are not
  enabled, so the gate does not demand a massive reformat of the existing tree.

Type-aware rules are intentionally **disabled** (no `parserOptions.project`):
they are ~10x slower and `pnpm typecheck` (`tsc -b --noEmit`) already covers
types.

```bash
pnpm lint        # report; current baseline: 0 error, 0 warning
pnpm lint:fix    # apply autofixes
```

> The `lint` script does **not** pass `--max-warnings 0`. The current baseline is
> nevertheless clean; CI can tighten this mechanically if warnings reappear.

**Dependencies** (added to `devDependencies`): `eslint`, `@eslint/js`,
`typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`,
`globals`. Run `pnpm install` to fetch them before the first lint.

---

## 2. End-to-end smoke (`pnpm test:e2e`)

Playwright config in [`playwright.config.ts`](../playwright.config.ts), spec in
[`e2e/smoke.spec.ts`](../e2e/smoke.spec.ts).

**Scope: a web smoke of the production bundle, not a full Tauri desktop E2E.**
Playwright runs `vite build` + `vite preview`, loads the bundle in a real
Chromium, and asserts:

1. navigation succeeds (HTTP ok);
2. `#root` from `index.html` is present;
3. React rendered children into `#root` (the entry module ran — no import-cycle
   or top-level throw nuked boot into a blank screen);
4. no *page-fatal* uncaught error during boot (errors caused purely by the
   absent Tauri/Convex runtime in a plain browser are tolerated).

This catches the highest-frequency regressions unit tests miss: broken bundle,
boot-killing import cycle, dead `#root`, asset/CSP path breakage.

```bash
pnpm test:e2e            # build + preview + run smoke
pnpm test:e2e -- --ui    # Playwright UI mode (local debugging)
```

**Dependencies**: `@playwright/test` (added to `devDependencies`). First run
needs the browser binary:

```bash
pnpm install
pnpm exec playwright install chromium
```

### Tauri/WebView2 natif (`pnpm native:smoke`)

Le gate natif est maintenant implémenté sans dépendre d'une version externe de
`msedgedriver`. `scripts/native-smoke.ps1` lance `tauri-dev-log.cmd` avec :

- un identifiant Tauri distinct (`dev.shugu.forge.native-smoke`) et donc une
  base SQLite qui ne peut pas être confondue avec celle de l'utilisateur ;
- un port CDP WebView2 réservé dynamiquement et un user-data-dir isolé ;
- un parcours Playwright CDP dans la vraie WebView : onboarding, Chat, Éditeur,
  Git, Agents, Studio, Média, Connections, Settings, Profil, Gallery, IPC et
  erreurs console/réseau ;
- une restauration préparée au premier lancement puis appliquée avant
  l'ouverture de SQLite au second lancement ;
- des audits clavier/ARIA sur 534 contrôles, un audit de contraste sur 827
  textes, le focus-trap/restauration d'un dialog et des budgets shell, DOM,
  heap et working set ;
- un teardown vérifiant processus, port 1420 et profil temporaire.

Les preuves horodatées (captures, `summary.json`, `native-proof.txt` et copie de
la base isolée) sont écrites sous `dev-logs/native-smoke/`.

### Providers et agent réels (`pnpm provider:smoke:live`)

Ce gate est volontairement séparé des faux providers déterministes. Il lance la
vraie application Tauri/WebView2 sous l'identifiant isolé
`dev.shugu.forge.live-provider-smoke`, puis vérifie les chemins de production
suivants :

- le CLI Codex réellement authentifié : découverte de version/modèles, probe
  structuré et `chat_send` app-server avec réponse sentinelle ;
- le modèle GGUF local Qwen 2B : démarrage/arrêt de `llama-server` par les IPC
  Shugu, backend Vulkan auto-détecté et chat OpenAI-compatible ;
- Qwen3 8B et Llama 3.1 8B GGUF : dialogue natif Full Access accepté une seule
  fois pour la session, puis run Agent réel avec événements SQLite
  `todo_write → fs_write_file → run_command(exit 0) → complete`.

Le parcours refuse tout `submit_plan` en Auto/Full Access, exige un plan dans un
tour antérieur à la mutation, rejette une réponse brute sans action en mode
Agent et n'accepte la fin qu'après une vérification postérieure réussie. Le
contrôleur force l'outil de planification manquant, puis une commande de
vérification après mutation. Les deux preuves finales emploient la commande
Windows exacte `cmd.exe /d /c type agent-proof.txt`; le fichier contient
exactement les 13 octets `LIVE_AGENT_OK`, sans saut de ligne.

Pré-requis locaux : Codex connecté, `llama-server` disponible et le petit modèle
GGUF installé. Les scénarios agents utilisent
`Qwen/Qwen3-8B-GGUF:Q4_K_M` et
`bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M`. Le harnais ne lit ni la
base ni le workspace personnels ; il conserve `summary.json`,
`agent-transcript.json`, la base isolée et le workspace preuve sous
`dev-logs/live-provider-smoke/`.

Les preuves finales sont :

- `20260723-083956` : Llama 3.1 8B, contexte serveur 32 768, prêt en 5 100 ms,
  run Agent en 8 156 ms, cycle exact de trois outils ;
- `20260723-084138` : Qwen3 8B, contexte serveur 32 768, prêt en 8 145 ms, run
  Agent en 7 156 ms, cycle exact de trois outils ;
- `20260723-065615` : Codex `gpt-5.4-mini` authentifié répond via probe et
  app-server, plus la première preuve Qwen.

L'option `-SkipCodex` permet d'isoler les gates locaux quand le quota externe
Codex est épuisé ; le résumé enregistre alors explicitement le skip et aucune
inférence Codex n'est comptée comme succès. Les essais Mistral ne sont pas
revendiqués : un GGUF doit exposer un template de chat/outils compatible. Shugu
accepte un contexte et un template llama.cpp explicites, limités à la liste
supportée, et échoue fermé si le modèle ne produit pas d'appel d'outil valable.
Aucun processus Shugu/llama, listener 1420/8090, profil Tauri ou grant Full
Access ne subsiste après les teardowns.

### Charge indexation + streaming (`pnpm perf:smoke`)

Ce gate utilise l'identifiant `dev.shugu.forge.perf-smoke`, un workspace
temporaire et un provider SSE OpenAI-compatible local. Il ne lit ni la base, ni
le workspace, ni les clés de l'utilisateur. Il vérifie dans la vraie WebView2 :

- 1 200 fichiers TypeScript réels, chunkés, vectorisés par FastEmbed et écrits
  dans SQLite (`6 000` chunks) ;
- un scan chaud sans ré-embedding, puis 120 modifications détectées et
  réconciliées ;
- la recherche sémantique avant/après modification ;
- 1 200 fragments SSE concurrents, leur coalescing sans perte, le premier delta
  et la pause maximale ;
- un heartbeat renderer, les erreurs page/console/réseau et un budget working
  set de 1,5 Gio ;
- teardown exact du processus, du port, du profil et du workspace temporaire.

La preuve `dev-logs/perf-smoke/20260723-085249/` mesure 88,55 s pour le
full-index (contre 197,1 s avant batching), 97,4 ms à chaud, 10,41 s pour 120
fichiers modifiés, 54,5 ms pour la recherche initiale, 302,8 ms au premier
delta, 172,7 ms de pause maximale, 73 ms de heartbeat renderer maximal et
1 244 061 696 octets de working set total.

### Runtime release isolé (`pnpm release:smoke`)

Le smoke release complète le gate de développement sans ouvrir le profil
utilisateur :

- compilation temporaire avec l'identifiant `dev.shugu.forge.release-smoke` et
  `bundle=false` ;
- sauvegarde puis restauration bit-à-bit du binaire release normal ;
- lancement d'une copie de preuve avec profil WebView2 et base SQLite isolés ;
- refus de toute URL Vite `:1420`, vérification de `http://tauri.localhost/`, de
  l'IPC, des erreurs page/console/réseau et des budgets mémoire/démarrage ;
- arrêt ciblé et suppression du seul profil isolé.

La dernière preuve exacte est sous
`dev-logs/release-smoke/20260723-090150/` : shell utilisable en 804 ms,
DOMContentLoaded en 164 ms, heap JS de 23 100 199 octets, working set total de
682 434 560 octets et aucune erreur page/console/requête.

### Packaging Windows (`pnpm tauri build`)

Le packaging release est un gate distinct du smoke natif isolé. Depuis
l'environnement développeur Visual Studio (`tauri-dev.cmd build`), il doit
produire :

- `src-tauri/target/release/shugu-forge.exe` ;
- le MSI x64 sous `src-tauri/target/release/bundle/msi/` ;
- l'installateur NSIS x64 sous `src-tauri/target/release/bundle/nsis/`.

Le 23 juillet 2026, les trois artefacts ont été produits avec succès. Le binaire
normal n'est pas lancé par le harness, afin de ne jamais ouvrir le profil
utilisateur `dev.shugu.forge`; l'exécution des assets release est prouvée avec
l'identifiant isolé `dev.shugu.forge.release-smoke`. Artefacts finaux :

- binaire : 75 343 872 octets, SHA-256
  `23030AC846BE8ED783DC7D18EAF7026A412C467D263CA170F88374CECCA04C10` ;
- MSI : 30 064 640 octets, SHA-256
  `20E1C1AA67D4D9F51B4858BFBA50AD077318EF3E0BE94E0974CBDA03B1E8A906` ;
- NSIS : 22 740 318 octets, SHA-256
  `34C2ECA1CE24A9D5BB940B97C6E84F631FB14C9C785FAF40C679377FC91E4E66`.

---

## 3. Dependency / supply-chain audit (`pnpm run audit`)

Maps to gap-matrix §8. Two halves; `pnpm run audit` runs both.

### JavaScript — `pnpm audit:js`

```bash
pnpm audit:js        # → pnpm audit --audit-level high
```

Reports every known advisory in the JavaScript dependency tree. The gate is
currently clean without an exception; vulnerable transitive versions are
bounded in `pnpm.overrides`.

### Rust — `pnpm audit:rust`

Wraps [`cargo-audit`](https://github.com/rustsec/rustsec/tree/main/cargo-audit),
which checks `src-tauri/Cargo.lock` against the [RustSec advisory
DB](https://rustsec.org/).

**`cargo-audit` is not bundled** — install it once per machine:

```bash
cargo install cargo-audit --locked
```

Then:

```bash
pnpm audit:rust      # → cargo audit sur src-tauri/Cargo.lock
```

Les trois exceptions explicites passées à la commande sont documentées, avec
chaîne de dépendances et condition de sortie, dans
[`security-advisories.md`](./security-advisories.md). Tout nouvel advisory reste
bloquant. Les warnings `unmaintained`/`unsound` restent visibles dans la sortie.

> **Why a wrapper instead of vendoring**: `cargo-audit` is a developer tool with
> its own release cadence and a network-fetched advisory DB; pinning it into the
> repo would rot. A documented one-line install keeps it current.

---

## 4. CI (`.github/workflows/ci.yml`)

A **minimal** GitHub Actions workflow that runs the cheap, deterministic gates on
push / PR:

- `typecheck` (`tsc -b --noEmit`),
- `test` (vitest),
- `lint` (eslint — non-blocking warnings),
- `audit:js` (`pnpm audit`, `continue-on-error` so an upstream CVE doesn't red-X
  every PR — it surfaces in logs).

The heavier gates (`test:e2e` Playwright, `cargo audit`) are **documented but not
yet enabled in CI**: e2e needs a browser download + a full Vite build, and cargo
audit needs the Rust toolchain + `cargo-audit` install. They run locally today
and can be promoted to CI jobs when the team is ready to pay that minute cost.
