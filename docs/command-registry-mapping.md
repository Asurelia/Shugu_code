# Command Registry Mapping

**Document purpose:** Pre-implementation analysis for the unified command registry.
**Author:** Pathfinder research agent (analysis only — no source code was modified).
**Date:** 2026-05-14

---

## 0. Source Inventory

Three sources contribute commands today — not two. The third must be absorbed into the registry:

| Source | File | Shape | Has `run`? | Persisted? |
|--------|------|-------|-----------|-----------|
| **Registry A** — `cmds` array | `src/routes/RootLayout.tsx` lines 134–147 | `{id, group, name, hint, icon, kbd, run}` | Yes (some no-ops) | No — recreated each render inside a `useMemo` |
| **Registry B** — `DEFAULT_SHORTCUTS` | `src/features/settings/settings-extras.tsx` lines 9–62 | `{group, items:[{id, label, keys}]}` | No | Yes — `localStorage` key `shugu.shortcuts.v1`, mirrored to SQLite |
| **Registry C** — hardcoded `useEffect` | `src/routes/RootLayout.tsx` lines 414–425 | Imperative `addEventListener` | Hardcoded | No |

Registry C wires `Cmd+K` directly to `setPaletteOpen(true)`. The `open-palette` entry in DEFAULT_SHORTCUTS has the correct *label* and *keys* for this behavior but no `run`. The live behavior bypasses both registries. This means the shortcut editor UI shows `open-palette` as a user-remappable binding, but rekeying it in the Settings UI currently has no effect on the real behavior — a latent bug that the unified registry must fix.

---

## 1. ID Mapping Table

> Notation in **Keybinding** column: `⌘` = Cmd/Meta, `⇧` = Shift, `⌃` = Ctrl, `⌥` = Alt/Option, `` ` `` = backtick.
> Conflicts are flagged inline; full analysis in Section 2.

| Canonical ID | From `cmds` | From `DEFAULT_SHORTCUTS` | Title | Category | Keybinding | Has `run()` today? | Backend needed | Notes |
|---|---|---|---|---|---|---|---|---|
| `open-palette` | — | `open-palette` | Open command palette | Workbench | `⌘K` | No (hardcoded useEffect) | none | Registry C is the real impl. Settings UI shows this but rekeying has no effect. |
| `toggle-side` | — | `toggle-side` | Toggle side panel | View | `⌘B` | No | none | `setSideCollapsed` exists in RootLayout local state, not yet in ShellContext. |
| `toggle-tweaks` | — | `toggle-tweaks` | Toggle Tweaks panel | Workbench | `⌘,` | No | none | **CONFLICT with `view-settings` / `settings` — see Section 2.** |
| `open-settings` | `view-settings` | `settings` | Open Settings | Workbench | **CONFLICT** `⌘,` vs `⌘⇧,` — see Section 2 | Yes (`setView("settings")`) | none | Two ids, two different kbds. Human decision required. |
| `find-global` | — | `find-global` | Find anywhere | Workbench | `⌘P` | No | search | **CONFLICT with `anno-pin` — see Section 2.** Label "Find anywhere" is ambiguous vs VS Code ⌘P = quick-open. |
| `view-chat` | `view-chat` | `view-chat` | Open Chat | View | `⇧⌘C` | Yes (`setView("chat")`) | none | Consistent across both sources. |
| `view-code` | `view-code` | `view-code` | Open Editor | View | `⇧⌘E` | Yes (`setView("code")`) | none | **CONFLICT: `⇧⌘E` also bound to `ai-explain` in DEFAULT_SHORTCUTS/Editor group — see Section 2.** |
| `view-image` | `view-image` | `view-image` | Open Image Studio | View | `⇧⌘I` | Yes (`setView("image")`) | none | Consistent. |
| `view-agents` | `view-agents` | `view-agents` | Open Agents | View | `⇧⌘A` | Yes (`setView("agents")`) | none | Labels differ: cmds says "Show Agents", DEFAULT_SHORTCUTS says "Open Agents". |
| `view-gallery` | `view-gallery` | `view-gallery` | Open Gallery | View | `⇧⌘G` | Yes (`setView("gallery")`) | none | Consistent. |
| `new-chat` | `new-chat` | `new-chat` | New Conversation | File | `⌘N` | Yes (calls `newChat()` after `setView("chat")`) | none | `newChat()` is `() => setMessages([])` — no persistence. Real impl will need db call. |
| `new-image` | `new-image` | — | Generate Image… | File | — | Yes (no-op: navigates to image view only) | ai-editor | No create action wired. |
| `new-agent` | `new-agent` | — | Dispatch Agent… | File | — | Yes (no-op: navigates to agents view only) | ai-editor | No create action wired. |
| `set-model` | `set-model` | — | Switch Model · shugu-sonnet-5 | Workbench | — | No-op (`() => {}`) | none | See Section 2: should this be one parameterized command? |
| `set-model-h` | `set-model-h` | — | Switch Model · shugu-haiku-4-5 | Workbench | — | No-op (`() => {}`) | none | See Section 2. |
| `set-model-l` | `set-model-l` | — | Switch Model · local qwen-32b | Workbench | — | No-op (`() => {}`) | none | See Section 2. |
| `next-tab` | — | `next-tab` | Next tab | Go | `⌃Tab` | No | none | Scoped to dock tab strip or editor tabs — needs a `when` guard. |
| `prev-tab` | — | `prev-tab` | Previous tab | Go | `⌃⇧Tab` | No | none | Same scoping concern as `next-tab`. |
| `new-chat-message` (renamed) | — | `send-message` | Send message | Edit | `Enter` | No | none | **Input-local scope only.** See Section 2. Single-key `Enter` must NOT fire globally. |
| `new-line-in-chat` (renamed) | — | `new-line` | New line in chat | Edit | `⇧Enter` | No | none | Input-local scope only. |
| `focus-float` | — | `focus-float` | Focus floating chat | Workbench | `⌘⇧Space` | No | none | Targets `FloatChat` component — needs `pinnedAnno` or focus ref in ctx. |
| `switch-model` | — | `switch-model` | Switch model (inline) | Workbench | `⌘/` | No | none | Distinct from the palette `set-model*` entries. Likely opens an inline model picker inside chat. Human should clarify relation to `set-model`. |
| `regenerate` | — | `regenerate` | Regenerate last reply | Edit | `⌘R` | No | ai-editor | Needs access to message history and stream runner. |
| `save-file` | — | `save-file` | Save file | File | `⌘S` | No | filesystem | **Context-scoped: editor only.** Conflicts with `img-save` in Image context — see Section 2. |
| `save-all` | — | `save-all` | Save all | File | `⌘⌥S` | No | filesystem | |
| `find-in-file` (renamed) | — | `find` | Find in file | Edit | `⌘F` | No | none | CodeMirror has built-in search; command likely delegates to it. |
| `replace-in-file` (renamed) | — | `replace` | Replace | Edit | `⌘⌥F` | No | none | Same — delegates to CodeMirror. |
| `toggle-terminal` | — | `toggle-terminal` | Toggle terminal | Terminal | `` ⌘` `` | No | pty | `setDockState` exists in RootLayout but is not in ShellContext. |
| `toggle-diff` | — | `toggle-diff` | Toggle diff view | View | `⌘D` | No | git | |
| `ai-rewrite` | — | `ai-rewrite` | AI rewrite selection | Selection | `⌘E` | No | ai-editor | Operates on editor selection — needs selection state from CodeMirror. |
| `ai-explain` | — | `ai-explain` | Explain selection | Selection | `⌘⇧E` | No | ai-editor | **CONFLICT with `view-code` (`⌘⇧E`) — see Section 2.** |
| `img-generate` | — | `img-generate` | Generate image | Image | `⌘Enter` | No | ai-editor | Context-scoped: Image view only. |
| `img-variation` | — | `img-variation` | Variations of current | Image | `⌘⇧V` | No | ai-editor | Context-scoped: Image view only. |
| `img-save` | — | `img-save` | Save to gallery | Image | `⌘S` | No | filesystem | **Context-scoped. Shares `⌘S` with `save-file` (editor). Intentional if guarded by `when`.** |
| `anno-comment` | — | `anno-comment` | Add comment to selection | Selection | `⌘⇧M` | No | none | Backed by `onAnnotate` in RootLayout — needs `ctx` access. |
| `anno-flag` | — | `anno-flag` | Add flag | Selection | `⌘⇧F` | No | none | Same. |
| `anno-pin` | — | `anno-pin` | Pin to floating chat | Selection | `⌘P` | No | none | **CONFLICT with `find-global` — see Section 2.** |
| `list-pin` | — | `list-pin` | Pin / unpin | Workbench | `P` | No | none | **Input-local scope: conversation list rows only.** Single bare key. |
| `list-rename` | — | `list-rename` | Rename | Workbench | `R` | No | none | Input-local scope. Single bare key. |
| `list-unread` | — | `list-unread` | Toggle unread | Workbench | `U` | No | none | Input-local scope. Single bare key. |
| `list-duplicate` | — | `list-duplicate` | Duplicate | Workbench | `F` | No | none | Input-local scope. Single bare key. |
| `list-archive` | — | `list-archive` | Archive | Workbench | `A` | No | none | Input-local scope. Single bare key. |
| `list-delete` | — | `list-delete` | Delete | Workbench | `⇧D` | No | none | Input-local scope. |

**Total distinct canonical commands: 43**
(Registry A contributes 12 entries; Registry B contributes 45 items across groups; after deduplication and the hardcoded Cmd+K: 43 unique commands.)

---

## 2. Conflicts and Ambiguities

### 2.1 Keybinding Collisions

**Collision A — `⌘,` (three-way)**

| Entry | Source | Binding | Intent |
|---|---|---|---|
| `toggle-tweaks` | DEFAULT_SHORTCUTS/General | `⌘,` | Open Tweaks panel |
| `view-settings` | cmds (Registry A) | `⌘,` | Navigate to Settings view |
| `settings` | DEFAULT_SHORTCUTS/General | `⌘⇧,` | Open Settings |

Three entries across two registries, two different chords, for what may or may not be the same two intents. `view-settings` in cmds uses `⌘,` (which VS Code standard uses for Settings). `toggle-tweaks` also claims `⌘,` but Tweaks is a different panel. `settings` in DEFAULT_SHORTCUTS uses `⌘⇧,` and is presumably the canonical "open settings" action. **Human decision required:** (1) are Tweaks and Settings separate commands with separate bindings? (2) which of `view-settings` / `settings` survives as the canonical id? (3) what binds to `⌘,` — Tweaks, Settings, or neither?

**Collision B — `⌘⇧E` (two-way)**

| Entry | Source | Binding | Intent |
|---|---|---|---|
| `view-code` | cmds + DEFAULT_SHORTCUTS/Navigation | `⌘⇧E` | Navigate to Code Editor view |
| `ai-explain` | DEFAULT_SHORTCUTS/Editor | `⌘⇧E` | Explain current selection via AI |

This is a real collision that will cause misfires once both commands are wired. In VS Code, `⌘⇧E` opens the Explorer panel. If `ai-explain` is editor-scoped (via `when`), it can shadow `view-code` only while the editor has focus. But even then, the user cannot navigate away from code view using `⌘⇧E` while editing — which is counter-intuitive. **Human decision required:** rebind `ai-explain` or `view-code`.

**Collision C — `⌘P` (two-way)**

| Entry | Source | Binding | Intent |
|---|---|---|---|
| `find-global` | DEFAULT_SHORTCUTS/General | `⌘P` | "Find anywhere" |
| `anno-pin` | DEFAULT_SHORTCUTS/Annotations | `⌘P` | Pin selection to floating chat |

Additionally, `⌘P` is the universal "Quick Open / Go to File" shortcut in VS Code and Cursor. The label "Find anywhere" could mean file quick-open, global text search, or symbol search — the intent is not clear from the current id and label. **Human decision required:** (1) clarify `find-global`'s actual scope; (2) rebind `anno-pin` if `⌘P` is reserved for quick-open.

**Collision D — `⌘S` (context-scoped, may be intentional)**

| Entry | Source | Binding | Intent | Active when |
|---|---|---|---|---|
| `save-file` | DEFAULT_SHORTCUTS/Editor | `⌘S` | Save current file | Code editor view |
| `img-save` | DEFAULT_SHORTCUTS/Image | `⌘S` | Save generation to gallery | Image view |

These are likely intentional — same chord, different contexts, separated by `when` guards. No human decision strictly required, but the implementation must ensure the guards are watertight. Noted here for implementer awareness.

### 2.2 ID Ambiguities

**`set-model` vs `switch-model`**

Registry A has three separate palette entries: `set-model`, `set-model-h`, `set-model-l`, each hardcoded to a specific model name in the `name` field. DEFAULT_SHORTCUTS has `switch-model` (group: Chat, binding: `⌘/`) with label "Switch model". These appear to address the same user intent via two different UX patterns (palette list vs. inline picker). It is unclear whether:
- The three `set-model*` entries should become one parameterized command `set-model` with a `modelId` argument (and the palette lists available models dynamically), or
- They remain as static palette entries while `switch-model` opens a separate context-local picker.

Both are valid designs. **Human decision required.**

**`view-settings` (cmds) vs `settings` (DEFAULT_SHORTCUTS)**

Both intend to open the Settings view. They have different ids, different bindings, and one has a `run()` while the other does not. The canonical id should be one of these — or a new name. See Collision A above.

**`new-image` and `new-agent` — navigate-only vs. create**

Both currently only navigate to the respective view; they perform no actual creation. The names (`Generate Image…`, `Dispatch Agent…`) imply an action beyond navigation. Until the creation flows are implemented, these are effectively aliases for `view-image` and `view-agents`. Flag for implementer: do not wire these to `setView()` alone in the final registry.

### 2.3 Input-Local Scope — Critical Implementation Risk

The following entries in DEFAULT_SHORTCUTS use bare keys (no modifier) or `Enter`/`Shift+Enter`. A global event listener will fire these while the user is typing in any input field, causing data loss or silent mutation:

| ID | Keys | Risk |
|---|---|---|
| `send-message` | `Enter` | Will intercept every Enter keypress globally |
| `new-line` | `Shift+Enter` | Same |
| `list-pin` | `P` | Will fire when user presses P in a text field |
| `list-rename` | `R` | Same |
| `list-unread` | `U` | Same |
| `list-duplicate` | `F` | Same |
| `list-archive` | `A` | Same |
| `list-delete` | `Shift+D` | Same |

These are **not global commands** — they are input-context keybindings. The `when` predicate system must enforce scope. Suggested `when` conditions:

- `send-message` / `new-line`: `when: (ctx) => ctx.activeElement === 'chat-input'`
- `list-*`: `when: (ctx) => ctx.focusedRegion === 'conversation-list'`

The registry must not globally register bare-key listeners for these. They should either be excluded from the global keyboard handler (handled locally by the component) or have `when` guards that are extremely specific. The implementer must resolve this architecture decision before wiring.

### 2.4 The Hardcoded `open-palette` (Registry C)

`src/routes/RootLayout.tsx` lines 414–425 contains:

```
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPaletteOpen(true);
    } else if (e.key === "Escape" && paletteOpen) {
      setPaletteOpen(false);
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [paletteOpen]);
```

This bypasses both registries. When the unified registry is implemented:
1. This `useEffect` must be replaced by a registry subscription.
2. The `setPaletteOpen` setter must be exposed in `CommandContext`.
3. The rekeying in ShortcutsSettings will then actually affect the `open-palette` behavior.

---

## 3. Proposed `Command` TypeScript Interface

```typescript
// Proposed — not yet implemented. Analysis only.

type CommandCategory =
  | "File"
  | "Edit"
  | "Selection"
  | "View"
  | "Go"
  | "Terminal"
  | "Help"
  | "Workbench";

/**
 * CommandContext is the runtime argument passed to `run` and `when`.
 * It is a superset of ShellContextValue plus RootLayout-local setters
 * that are currently NOT in ShellContext.
 *
 * RootLayout will need to either:
 *   (a) lift these setters into ShellContext, or
 *   (b) construct the registry instance inside RootLayout (passing them as closure),
 *       which works but couples the registry to the component tree.
 * Option (a) is cleaner for a standalone `src/lib/commands.ts`.
 */
interface CommandContext {
  // Already in ShellContextValue
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  openFiles: string[];
  activeFile: string | null;
  generations: any[];
  agents: any[];

  // Navigation — already in RootLayout, not in ShellContext
  navigateTo: (view: string) => void;
  currentView: string; // derived from pathname via pathToView()

  // Shell visibility — RootLayout local state, not in ShellContext
  setPaletteOpen: (open: boolean) => void;
  setSideCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  sideCollapsed: boolean;

  // Dock — RootLayout local state, not in ShellContext
  dockState: DockState;
  setDockState: React.Dispatch<React.SetStateAction<DockState>>;

  // Tweaks — RootLayout local state via useTweaks, not in ShellContext
  setTweak: (key: string, value: any) => void;
  tweaks: typeof TWEAK_DEFAULTS;

  // Conversation operations — RootLayout local
  newChat: () => void;

  // Annotations — RootLayout local
  onAnnotate: (payload: { kind: string; payload: any; target: any }) => void;

  // Active DOM focus hints (for scoped/when guards)
  activeElement: string | null; // e.g. 'chat-input', 'editor', 'conversation-list'
  focusedRegion: string | null; // coarser region hint

  // Model state — does not yet exist; needed for set-model* commands
  // activeModel: string;
  // setActiveModel: (modelId: string) => void;
}

interface Command {
  /** Kebab-case unique identifier. Stable across renames. */
  id: string;

  /** Human-readable title shown in palette and menus. */
  title: string;

  /** Menu category. Controls where the command appears in a menu bar. */
  category: CommandCategory;

  /**
   * Optional short description / hint line shown below the title in the palette.
   * Maps to `hint` in the current cmds shape.
   */
  description?: string;

  /** Icon name resolved by the Icon component. */
  icon?: string;

  /**
   * Default keybinding. Stored as an ordered array of key names using the
   * same token vocabulary as DEFAULT_SHORTCUTS (e.g. ["Cmd", "Shift", "K"]).
   * The user-overridden binding lives in localStorage/SQLite under
   * `shugu.shortcuts.v1` and takes precedence at runtime.
   */
  keybinding?: string[];

  /**
   * When this predicate returns false, the command appears in menus/palette
   * but is disabled (greyed out). When absent, the command is always enabled.
   * Must NOT be used to scope input-local bare-key bindings — use component-level
   * handlers for those (see Section 2.3).
   */
  when?: (ctx: CommandContext) => boolean;

  /**
   * Execute the command. Called by the palette, menu bar, context menus, and
   * the global keybinding dispatcher.
   * Commands that are UI-only (no backend) receive ctx and call setters directly.
   * Commands requiring a backend receive ctx and fire an IPC call (invoke/Tauri).
   */
  run: (ctx: CommandContext) => void | Promise<void>;
}
```

---

## 4. Proposed File Location and Structure

### New file: `src/lib/commands.ts`

This file should contain:

1. The `Command` and `CommandContext` type definitions (may be extracted to `src/lib/types.ts` if that file already defines shared types — check `src/lib/types.ts` before deciding).
2. The `COMMANDS` array: a flat array of `Command` objects, one per canonical id.
3. A helper `getCommandById(id: string): Command | undefined`.
4. Nothing that imports React or any component — this module must be importable from anywhere without creating circular dependencies.

### What stays in `src/features/settings/settings-extras.tsx`

- `DEFAULT_SHORTCUTS` — should be **removed** from this file once the registry is live. During the migration it can be derived from `COMMANDS`: `DEFAULT_SHORTCUTS = toShortcutsMap(COMMANDS)` where `toShortcutsMap` groups commands by category and maps `keybinding` to `keys`.
- `ShortcutsSettings` component — stays, but reads from `COMMANDS` rather than the hardcoded array.

### What changes in `src/routes/RootLayout.tsx`

- The `cmds` `useMemo` inside `CommandPalette` is replaced by `COMMANDS.filter(...)`.
- `CommandPalette` receives a `CommandContext` prop (or reads from a context) instead of the current `setView` / `onNewChat` props.
- The hardcoded `Cmd+K` `useEffect` is replaced by a generic keybinding dispatcher that reads the live shortcut map (user overrides from localStorage) and calls `getCommandById(id).run(ctx)`.

### Global keybinding dispatcher (new: `src/lib/keybindings.ts`)

A single `useEffect`-based hook — `useCommandKeybindings(ctx: CommandContext)` — that:
1. Reads the current shortcut map (user overrides merged with `COMMANDS` defaults).
2. On each `keydown`, matches the event against the map.
3. Calls `cmd.when(ctx) !== false` before dispatching.
4. Explicitly skips dispatch when the event target is an `<input>`, `<textarea>`, or `[contenteditable]` — this is the blanket guard that prevents bare-key commands from firing while typing. The `list-*` and `send-message` commands must rely on component-level handlers regardless; the dispatcher should not attempt to scope them via `when`.

### Suggested file tree delta

```
src/
  lib/
    commands.ts          # NEW — Command type + COMMANDS array
    keybindings.ts       # NEW — useCommandKeybindings hook
    types.ts             # EXISTING — add CommandContext here or in commands.ts
```

---

## 5. Open Questions for Human Decision

1. **`⌘,` assignment (Collision A):** Which of these three commands owns `⌘,`? What is the canonical id for "open settings" — `view-settings` (from cmds) or `settings` (from DEFAULT_SHORTCUTS)? Should Tweaks get a different binding entirely?

2. **`⌘⇧E` assignment (Collision B):** Should `ai-explain` be rebound to avoid conflict with `view-code`? Candidate rebindings: `⌘⌥E` or `⌘⇧X`. Or should `view-code` move off `⌘⇧E` (VS Code uses it for Explorer, which Shugu doesn't have)?

3. **`⌘P` intent (Collision C):** Is `find-global` a file quick-open (VS Code `⌘P` convention) or a cross-content text search? If it's quick-open, rename to `quickopen-file`. Rebind `anno-pin` regardless.

4. **`set-model*` vs `switch-model`:** Should the three hardcoded `set-model*` palette entries become one parameterized `set-model` command (with the model list supplied dynamically by the provider registry in `src/lib/providers.ts`)? Or do they remain as static entries? The former is architecturally correct for a real IDE; the latter is faster to ship.

5. **Input-local commands — architecture decision:** For `send-message`, `new-line`, and all `list-*` commands: should these remain exclusively as component-level keyboard handlers (no global registration), or should the registry include them with strict `when` guards? If the latter, what is the `when` predicate API shape that can reliably identify focus on a specific sub-component?

6. **`CommandContext` lifting:** Several setters needed by commands (`setPaletteOpen`, `setSideCollapsed`, `setDockState`, `setTweak`) live as RootLayout local state and are not exposed via `ShellContext`. Before the registry can be a standalone module at `src/lib/commands.ts`, these must be lifted into `ShellContext` (or a new `AppContext`). Is this acceptable given the current architecture, or should the registry be constructed inside RootLayout (as a closure) to avoid lifting?

7. **`new-chat` persistence:** `newChat()` currently calls `setMessages([])` only — it does not create a new conversation record in SQLite. Before the `new-chat` command is wired in the real registry, `db.conversations.create(...)` must be called. Is this in scope for the command registry milestone, or deferred?

8. **Naming convention for view-navigation commands:** Should the view-navigation commands (`view-chat`, `view-code`, etc.) be categorized as `View` (VS Code: Explorer/Source Control panels) or `Go` (VS Code: Go to File/Symbol)? Top-level workbench section switching is closest to `View` in VS Code terms, but `Workbench` is also defensible. Pick one and enforce it consistently.

9. **`find-global` vs `find-in-file`:** DEFAULT_SHORTCUTS has both `find-global` (`⌘P`, "Find anywhere") and `find` (`⌘F`, "Find in file"). If `find-global` becomes quick-open, what does "Find anywhere" (global text search across project) bind to? `⌘⇧F` is the VS Code standard.

10. **Palette groups vs. menu categories:** The current `cmds` use `group: "Navigate" | "Create" | "Models" | "Tools"` for palette display grouping. The proposed `category` field maps to menu bar categories. These two concerns may diverge (e.g., `new-chat` is category `File` but might appear under "Create" in the palette). Should the `Command` type carry both a `category` (menu) and a `paletteGroup` (palette display) field, or should one be derived from the other?
