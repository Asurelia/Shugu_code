# Quality Gates — Shugu Forge

This document covers the quality-gate tooling added under the **quality-gates**
lane: lint, end-to-end smoke, dependency/supply-chain audit, and the minimal CI
workflow. It maps directly to **Bloc C** of
[`global-gap-matrix-2026-06-21.md`](./global-gap-matrix-2026-06-21.md) (P2):
`lint`, `test:e2e`, `cargo audit` / dependency audit.

All scripts are **additive** — nothing existing was changed. They are wired into
`package.json` so the team can adopt them incrementally (lint runs even with
warnings; CI starts non-blocking and can be tightened later).

---

## 1. Lint (`npm run lint`)

ESLint v9 **flat config** in [`eslint.config.js`](../eslint.config.js).

- **Errors only on dangerous / bug-shaped patterns** — `no-debugger`,
  `no-unreachable`, `no-cond-assign`, `react-hooks/rules-of-hooks`, duplicate
  keys/args/cases, `use-isnan`, `valid-typeof`, etc.
- **Warns on smells** — unused vars (`^_`-prefixed ignored), `any`, missing hook
  deps, `prefer-const`. These never fail the build.
- **Off for style** — Prettier owns formatting; opinionated style rules are not
  enabled, so the gate does not demand a massive reformat of the existing tree.

Type-aware rules are intentionally **disabled** (no `parserOptions.project`):
they are ~10x slower and `npm run typecheck` (`tsc -b --noEmit`) already covers
types.

```bash
npm run lint        # report (exits 0 even with warnings — see note below)
npm run lint:fix    # apply autofixes
```

> The `lint` script does **not** pass `--max-warnings 0`, by design: warnings are
> a signal, not a blocker, for the first iteration. To make warnings fail CI
> later, change the script to `eslint . --max-warnings 0`.

**Dependencies** (added to `devDependencies`): `eslint`, `@eslint/js`,
`typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`,
`globals`. Run `pnpm install` to fetch them before the first lint.

---

## 2. End-to-end smoke (`npm run test:e2e`)

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
npm run test:e2e            # build + preview + run smoke
npm run test:e2e -- --ui    # Playwright UI mode (local debugging)
```

**Dependencies**: `@playwright/test` (added to `devDependencies`). First run
needs the browser binary:

```bash
pnpm install
npx playwright install chromium
```

### Upgrading to a real Tauri desktop E2E (future lane)

Driving the actual desktop binary needs
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/):

1. `cargo install tauri-driver` (msedgedriver must match the installed WebView2);
2. `pnpm tauri build --debug`;
3. a WebDriver/CDP harness that launches `tauri-driver`, points at the built
   binary, and drives the real window (open workspace, chat read-only, plan
   mode, run-command approve/block, MCP add/test, git diff review, worktree
   create/cleanup — the flow listed in the gap matrix §6).

That belongs to a dedicated desktop-E2E lane, not this gate.

---

## 3. Dependency / supply-chain audit (`npm run audit`)

Maps to gap-matrix §8. Two halves; `npm run audit` runs both.

### JavaScript — `npm run audit:js`

```bash
npm run audit:js        # → pnpm audit --audit-level high
```

Reports known CVEs in the npm dependency tree at **high** severity and above
(tune with `--audit-level`). Run `pnpm audit --fix` to apply safe upgrades.

### Rust — `npm run audit:rust`

Wraps [`cargo-audit`](https://github.com/rustsec/rustsec/tree/main/cargo-audit),
which checks `src-tauri/Cargo.lock` against the [RustSec advisory
DB](https://rustsec.org/).

**`cargo-audit` is not bundled** — install it once per machine:

```bash
cargo install cargo-audit --locked
```

Then:

```bash
npm run audit:rust      # → cargo audit (run inside src-tauri/)
```

The script is defined as
`cargo audit --file src-tauri/Cargo.lock` so it works from the repo root. If
`cargo-audit` is missing, the command fails with cargo's standard
"no such subcommand: `audit`" message — install it as shown above.

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
