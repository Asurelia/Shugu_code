# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager — pnpm only

**npm is forbidden.** Use `pnpm` exclusively for everything: install, run, exec, dlx. `package.json` pins `packageManager: pnpm@9` and `.npmrc` sets `engine-strict`. `npx` → `pnpm dlx`. If a tutorial says `npm install foo`, translate to `pnpm add foo`.

## Commands

```bash
pnpm install                 # deps
pnpm dev                     # Vite web mode — http://localhost:5173 (runs WITHOUT Tauri/Convex, see below)
pnpm typecheck               # tsc -b --noEmit  — the TS gate
pnpm build                   # tsc -b --noEmit && vite build
pnpm tauri dev               # desktop app (needs the VS Developer env on Windows — see below)
pnpm tauri build             # package the desktop app
pnpm convex dev              # OPTIONAL — provisions a Convex deployment, generates convex/_generated/ + VITE_CONVEX_URL
```

**Rust / `cargo` on Windows:** a plain shell fails with `cl.exe`/`kernel32.lib` not found — Git's `link.exe` shadows MSVC's on PATH. Run cargo through the VS Developer environment:

```
cmd /c "\"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat\" >nul 2>&1 && cd /d F:\Dev\shugu_code\src-tauri && cargo check"
```

`.cargo/config.toml` exists locally as a partial linker fix but is **gitignored** (hardcoded machine-specific MSVC path) — don't rely on it cross-machine.

**No test runner is configured yet.** `pnpm build` + `pnpm typecheck` + `cargo check` are the only verification gates today.

## Two run modes — the app degrades gracefully

This is the single most important architectural fact. The app runs in **either**:
- **Web mode** (`pnpm dev`, plain browser): no Tauri, no Convex required. `src/lib/tauri.ts`'s `invoke()` falls back to an in-file `mocks` map; `src/lib/db.ts`'s `getDb()` returns `null` and every repository method no-ops/returns `[]`; `ConvexProvider` only mounts when `VITE_CONVEX_URL` is set.
- **Desktop mode** (`pnpm tauri dev`): real `invoke()` to Rust commands, real SQLite, optional Convex.

**Every new data/IPC call must keep this duality** — guard on `inTauri` / `getDb() === null` and degrade, never assume Tauri is present.

## Data architecture — LOCAL-FIRST (mandate)

Three tiers, in priority order:
1. **SQLite = source of truth** (`src/lib/db.ts` + `tauri-plugin-sql`). Holds conversations, messages, projects, generations, jobs, logs, settings. The `db` export is a repository API (`db.conversations.list/create/rename/...`) — it is NOT a cache of Convex. Schema lives in `src-tauri/src/lib.rs` as declarative migrations (`MIGRATION_V1`, `MIGRATION_V2`).
2. **Vector layer** (`src-tauri/src/commands/vector.rs`): `sqlite-vec` + `fastembed`, embeddings stored as `vec0` virtual tables **in the same `shugu.db` file** (one file, atomic with relational data). Frontend wrapper: `src/lib/vector.ts`. Plumbed but not yet wired into any UI.
3. **Convex = OPTIONAL sync mirror** — realtime / multi-device only, never required. `convex/` holds the schema (mirrors SQLite) + queries. SQLite always wins; Convex is a one-way sync target, never pulled down as authoritative.

Heavy/private/binary data (images, models, checkpoints, raw logs, ComfyUI cache) stays strictly local — never Convex. `src/mocks/seed*.ts` are bootstrap data (loaded once via `seedIfEmpty()`), not the live source.

## Composition & routing

- **`src/routes/RootLayout.tsx` is the real composition root** — it holds all shell state, exposes it via `ShellContext` + `useShell()`, and renders the chrome (Titlebar, Rail, SidePanel, dock, global overlays) around an `<Outlet/>`. `src/App.tsx` is a one-line re-export stub.
- **TanStack Router is code-based**, not file-based: routes are declared in `src/router.tsx` with `createMemoryHistory` (desktop app — avoids `file://` issues). There is NO `routeTree.gen.ts` and NO router Vite plugin. Per-route components live in `src/routes/*.tsx`, lazy-loaded via `React.lazy` + a `<Suspense>` boundary in `RootLayout`.
- `view` is derived from the pathname, not stored. `Rail` keeps its original `view`/`setView` props — `RootLayout` passes a navigate-based `setView`.

## Provider abstraction — never hardcode one provider

Chat and image generation are **provider-agnostic**, dispatched by `protocol`:
- Chat: `src-tauri/src/commands/chat.rs` dispatches `anthropic` / `openai` (OpenAI-compatible — also covers Mistral, Groq, OpenRouter, LM Studio, vLLM…) / `ollama`. Streams tokens via `chat://delta` events; `src/features/chat/useChatStream.ts` renders them live.
- Image: `src-tauri/src/commands/image.rs` dispatches `comfyui` / `replicate` / `openai` / `stability` / `custom`.
- Frontend registries `src/lib/providers.ts` + `src/lib/imageProviders.ts` resolve a `prefix/model` id (e.g. `groq/llama-3.3-70b`) → `{ protocol, baseUrl }`.
- API keys resolve **per-protocol env var** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `REPLICATE_API_TOKEN`, `STABILITY_API_KEY`, …) or an explicit `apiKey` override — keys never cross the IPC boundary by default. The `custom` protocol's `base_url` is a documented SSRF surface (acceptable: the user configures their own providers).

## Repo layout & conventions

- `src/features/{chat,code,image,agents,gallery,settings,panels,tweaks,...}` — feature-by-domain. Shared atoms in `src/components/`, shared libs in `src/lib/`, mocks in `src/mocks/`. Keep new code in this layout — the user values a modular, maintainable structure.
- `src-tauri/src/commands/` — one file per command domain (`chat`, `image`, `fs`, `terminal`, `models`, `vector`), registered in `lib.rs`'s `invoke_handler!`.
- `tsconfig.json` is intentionally `strict: false` (this codebase was ported fast from a prototype). Loose `any` typing is accepted; tightening `strictNullChecks` is a known follow-up (it would remove an `as any` on `createRouter`).
- The Celestial Veil CSS (`src/styles/*.css`) was copied verbatim from the design prototype — keep it that way; don't reformat or "improve" it.
- `_design_extracted/` (gitignored) is the original Claude Design handoff bundle — **reference only, never edit**. The chat transcript inside it is the source of design intent.
- Work on a feature branch, not `main`. Conventional-commit style with an emoji prefix is used (`✨ feat:`, `🔧 fix:`, `🔒 fix:`, `🎉 chore:`).
