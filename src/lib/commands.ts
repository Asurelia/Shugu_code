// Shugu Forge — Unified command registry.
// Pure data module — no React imports. Safe to import from anywhere.
// Pass 1: flat COMMANDS array with default keybindings, categories, run/when predicates.

import { fsOpenFolder, fsGetWorkspaceRoot } from "@/lib/fs";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openSearchPanel } from "@codemirror/search";
import type { CodeMirrorEditorHandle } from "@/features/code/CodeMirrorEditor";
import type { EditorPrefs } from "@/routes/shell-context";
import { formatCurrentDocument } from "@/features/code/format";

// ─── Types ────────────────────────────────────────────────────

export type CommandCategory =
  | "File"
  | "Edit"
  | "Selection"
  | "View"
  | "Go"
  | "Terminal"
  | "Help"
  | "Workbench";

/**
 * CommandContext is the runtime payload passed to `run` and `when`.
 * Assembled via useMemo in RootLayout from existing local state/setters.
 * NOT lifted into ShellContext — RootLayout-local only.
 */
export interface CommandContext {
  // Navigation
  navigateTo: (view: string) => void;
  currentView: string;

  // Palette
  setPaletteOpen: (open: boolean) => void;

  // Side panel
  sideCollapsed: boolean;
  setSideCollapsed: React.Dispatch<React.SetStateAction<boolean>>;

  // Dock
  dockState: { side: string; [key: string]: any };
  setDockState: React.Dispatch<React.SetStateAction<any>>;

  // Tweaks
  tweaks: Record<string, any>;
  setTweak: (key: string, value: any) => void;

  // Chat
  newChat: () => void;

  // Files
  activeFile: string | null;
  fileContents: Record<string, any>;
  fileTree: any[];
  openFiles: string[];
  saveAll: () => Promise<void>;
  saveFile: (path: string) => Promise<void>;
  setActiveFile: React.Dispatch<React.SetStateAction<string | null>>;
  setFileContents: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  /** Trigger un refetch du file tree (post-migration TanStack — voir
   *  `src/features/fs/queries.ts::invalidateFileTree`). */
  invalidateFileTree: () => void;
  setOpenFiles: React.Dispatch<React.SetStateAction<string[]>>;

  // Gallery / Agents
  generations: any[];
  agents: any[];

  // Annotations
  onAnnotate: (payload: { kind: string; payload: any; target: any }) => void;

  // Model selection
  setActiveModel?: (id: string) => void;

  // Editor (CodeMirror) — optional; only present when /code view is active.
  editorViewRef?: React.RefObject<CodeMirrorEditorHandle>;

  // ─── LOT 2 : Find-in-files panel toggle ────────────────────────────
  // Câblé par RootLayout depuis le shell-context (ShellContextValue).
  // Utilisé par la commande `search-in-files` (Cmd+Shift+F) pour ouvrir
  // le panel grep textuel à la place de l'ancien semantic search.
  setFindPanelOpen?: (open: boolean) => void;

  // ─── LOT 1 : Editor preferences ─────────────────────────────────────
  // Required (not optional) — one instantiation site in RootLayout cmdCtx.
  editorPrefs: EditorPrefs;
  setEditorPref: <K extends keyof EditorPrefs>(key: K, value: EditorPrefs[K]) => void;

  // ─── LOT 3 : Compare mode ────────────────────────────────────────────
  // When non-null, the /code view shows a 2-pane MergeView instead of the
  // CodeMirrorEditor. The `compare-files` command sets this; `close-compare`
  // clears it.
  compareFile?: { left: string; right: string } | null;
  setCompareFile?: React.Dispatch<React.SetStateAction<{ left: string; right: string } | null>>;
}

// ─── Command interface ─────────────────────────────────────────

/**
 * scope:
 *  - "global"  — handled by the global keybinding dispatcher (default)
 *  - "input"   — handled exclusively by the component; dispatcher SKIPS these
 */
export type CommandScope = "global" | "input";

export interface Command {
  id: string;
  title: string;
  category: CommandCategory;
  description?: string;
  icon?: string;
  /** Token array matching settings-extras.tsx key vocabulary. */
  keybinding?: string[];
  scope?: CommandScope;
  /**
   * When false the command is filtered from the palette and not dispatched.
   * Absent = always enabled.
   */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

// ─── COMMANDS array ───────────────────────────────────────────

export const COMMANDS: Command[] = [
  // ── Workbench ─────────────────────────────────────────────
  {
    id: "open-palette",
    title: "Open command palette",
    category: "Workbench",
    icon: "search",
    keybinding: ["Cmd", "K"],
    run: (ctx) => ctx.setPaletteOpen(true),
  },
  {
    id: "toggle-side",
    title: "Toggle side panel",
    category: "Workbench",
    icon: "folderTree",
    keybinding: ["Cmd", "B"],
    run: (ctx) => ctx.setSideCollapsed((c) => !c),
  },
  {
    id: "toggle-tweaks",
    title: "Toggle Tweaks panel",
    category: "Workbench",
    icon: "gear",
    keybinding: ["Cmd", "Shift", ","],
    run: (ctx) => ctx.setTweak("showTweaks", !ctx.tweaks.showTweaks),
  },
  {
    id: "open-settings",
    title: "Open Settings",
    category: "Workbench",
    icon: "gear",
    keybinding: ["Cmd", ","],
    description: "preferences",
    run: (ctx) => ctx.navigateTo("settings"),
  },
  {
    // Renamed from find-global; keeps ⌘P as quick-open per decision 3.
    id: "quickopen-file",
    title: "Quick Open File",
    category: "Workbench",
    icon: "search",
    keybinding: ["Cmd", "P"],
    // Backend (search index) not yet wired.
    when: () => false,
    run: () => { /* TODO: open quick-open file picker */ },
  },
  {
    id: "focus-float",
    title: "Focus floating chat",
    category: "Workbench",
    icon: "chat",
    keybinding: ["Cmd", "Shift", "Space"],
    // FloatChat focus ref not yet in ctx.
    when: () => false,
    run: () => { /* TODO: focus FloatChat via ref */ },
  },
  {
    id: "switch-model",
    title: "Switch model (inline)",
    category: "Workbench",
    icon: "sparkle",
    keybinding: ["Cmd", "/"],
    // Inline model picker not yet implemented.
    when: () => false,
    run: () => { /* TODO: open inline model picker */ },
  },

  // ── File ─────────────────────────────────────────────────
  {
    id: "new-chat",
    title: "New Conversation",
    category: "File",
    icon: "plus",
    keybinding: ["Cmd", "N"],
    description: "fresh chat",
    run: (ctx) => { ctx.navigateTo("chat"); ctx.newChat(); },
  },
  {
    id: "new-image",
    title: "Generate Image…",
    category: "File",
    icon: "sparkle",
    description: "open prompt with cursor",
    run: (ctx) => ctx.navigateTo("image"),
  },
  {
    id: "new-agent",
    title: "Dispatch Agent…",
    category: "File",
    icon: "agent",
    description: "background task",
    run: (ctx) => ctx.navigateTo("agents"),
  },
  {
    id: "save-file",
    title: "Save file",
    category: "File",
    keybinding: ["Cmd", "S"],
    when: (ctx) => ctx.currentView === "code" && ctx.activeFile !== null,
    run: (ctx) => ctx.saveFile(ctx.activeFile!),
  },
  {
    id: "save-all",
    title: "Save all",
    category: "File",
    keybinding: ["Cmd", "Alt", "S"],
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => ctx.saveAll(),
  },
  {
    id: "open-folder",
    title: "Open Folder…",
    category: "File",
    icon: "folder",
    keybinding: ["Cmd", "Shift", "O"],
    run: async (ctx) => {
      const root = await fsOpenFolder();
      if (!root) return;
      // LOT 3 — Disconnect tous les LSP clients AVANT le refetch tree :
      // leur workspaceUri pointe sur l'ancien dossier, les requêtes
      // go-to-def / find-refs y resteraient ancrées. Le prochain ouvrir
      // de fichier déclenchera un nouveau spawn LSP avec le bon root.
      // L'import est dynamique (évite de charger @codemirror/lsp-client
      // côté palette qui doit rester légère).
      try {
        const { disconnectAllClients } = await import("@/features/code/lsp/client");
        await disconnectAllClients();
      } catch (err) {
        console.warn("[open-folder] LSP disconnect failed:", err);
      }
      // Le file tree est maintenant un useQuery — on déclenche un refetch
      // au lieu de set manuellement. Le useFileTree hook propage à tous
      // les consumers automatiquement.
      ctx.invalidateFileTree();
      ctx.setOpenFiles([]);
      ctx.setActiveFile(null);
      ctx.setFileContents({});
    },
  },

  // ── View ─────────────────────────────────────────────────
  {
    id: "view-chat",
    title: "Open Chat",
    category: "View",
    icon: "chat",
    keybinding: ["Cmd", "Shift", "C"],
    description: "switch to conversation",
    run: (ctx) => ctx.navigateTo("chat"),
  },
  {
    id: "view-code",
    title: "Open Editor",
    category: "View",
    icon: "code",
    keybinding: ["Cmd", "Shift", "E"],
    description: "switch to code editor",
    run: (ctx) => ctx.navigateTo("code"),
  },
  {
    id: "view-image",
    title: "Open Image Studio",
    category: "View",
    icon: "image",
    keybinding: ["Cmd", "Shift", "I"],
    description: "switch to image generator",
    run: (ctx) => ctx.navigateTo("image"),
  },
  {
    id: "view-agents",
    title: "Open Agents",
    category: "View",
    icon: "agent",
    keybinding: ["Cmd", "Shift", "A"],
    description: "background workers",
    run: (ctx) => ctx.navigateTo("agents"),
  },
  {
    id: "view-gallery",
    title: "Open Gallery",
    category: "View",
    icon: "gallery",
    keybinding: ["Cmd", "Shift", "G"],
    description: "past generations",
    run: (ctx) => ctx.navigateTo("gallery"),
  },
  {
    // LOT 3 — Compare two files side-by-side via MergeView.
    // Opens the native file picker, then renders DiffView in the /code route.
    // NOTE: Cmd+D is NOT used — CodeMirror searchKeymap already binds
    // Mod-d → selectNextOccurrence and the editor would swallow it.
    id: "compare-files",
    title: "File: Compare with...",
    category: "File",
    keybinding: ["Cmd", "Shift", "D"],
    when: (ctx) => ctx.currentView === "code" && ctx.activeFile !== null,
    run: async (ctx) => {
      if (!ctx.activeFile || !ctx.setCompareFile) return;

      // Get workspace root so we can relativize the picked absolute path.
      const wsRoot = await fsGetWorkspaceRoot();
      if (!wsRoot) return;

      // Ensure we are on the /code view so the DiffView renders.
      ctx.navigateTo("code");

      const picked = await dialogOpen({
        multiple: false,
        defaultPath: wsRoot,
        filters: [{ name: "All files", extensions: ["*"] }],
      });

      if (typeof picked !== "string") return; // cancelled

      // Relativize: strip workspace root prefix + leading slash.
      // BUG fixed (user smoke): the picker returns native paths (\\) on
      // Windows, the Rust workspace root returns native paths too, but the
      // previous impl only normalized `picked` to forward-slash — leaving
      // `wsRoot` with backslashes and breaking startsWith entirely.
      // Also: Windows paths are case-insensitive (drive letter casing varies
      // between picker output and workspace state) — comparison must be
      // case-insensitive when running on Windows. We test platform via the
      // simple heuristic of looking for a Windows drive letter in wsRoot
      // (e.g. "C:" / "F:") since detecting platform in the browser without
      // an extra plugin is awkward; on POSIX this regex never matches so
      // the comparison stays case-sensitive.
      const normalize = (p: string) => p.replace(/\\/g, "/");
      const normalizedPicked = normalize(picked);
      const normalizedRoot = normalize(wsRoot);
      const rootWithSlash = normalizedRoot.endsWith("/")
        ? normalizedRoot
        : normalizedRoot + "/";
      const isWindowsRoot = /^[A-Za-z]:/.test(normalizedRoot);
      const matches = isWindowsRoot
        ? normalizedPicked.toLowerCase().startsWith(rootWithSlash.toLowerCase())
        : normalizedPicked.startsWith(rootWithSlash);
      const relative = matches
        ? normalizedPicked.slice(rootWithSlash.length)
        : null;

      if (!relative) {
        // File is outside the workspace — cannot read via fs_read_file.
        console.warn("[compare-files] picked file is outside workspace:", picked, "root:", wsRoot);
        return;
      }

      ctx.setCompareFile({ left: ctx.activeFile, right: relative });
    },
  },
  {
    // LOT 3 — Close compare mode, return to single-editor view.
    id: "close-compare",
    title: "File: Close Compare",
    category: "File",
    keybinding: ["Escape"],
    when: (ctx) => ctx.currentView === "code" && ctx.compareFile != null,
    run: (ctx) => {
      ctx.setCompareFile?.(null);
    },
  },
  {
    // LOT 3 — Toggle git inline diff decorations (added/modified/deleted lines).
    id: "toggle-git-decorations",
    title: "View: Toggle Git Decorations",
    category: "View",
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => ctx.setEditorPref("gitDecorations", !ctx.editorPrefs.gitDecorations),
  },
  {
    // LOT 1 — Word wrap toggle. Mirrors VS Code Alt+Z.
    id: "toggle-word-wrap",
    title: "View: Toggle Word Wrap",
    category: "View",
    keybinding: ["Alt", "Z"],
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => ctx.setEditorPref("wordWrap", !ctx.editorPrefs.wordWrap),
  },
  {
    // LOT 2a — Sticky scroll toggle. No standard VS Code keybinding.
    id: "toggle-sticky-scroll",
    title: "View: Toggle Sticky Scroll",
    category: "View",
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => ctx.setEditorPref("stickyScroll", !ctx.editorPrefs.stickyScroll),
  },
  {
    // LOT 2a — Minimap toggle. No standard VS Code keybinding.
    id: "toggle-minimap",
    title: "View: Toggle Minimap",
    category: "View",
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => ctx.setEditorPref("minimap", !ctx.editorPrefs.minimap),
  },

  // ── Models (palette-only, no keybinding) ──────────────────
  {
    id: "set-model",
    title: "Switch Model · shugu-sonnet-5",
    category: "Workbench",
    icon: "sparkle",
    description: "balanced · 200k ctx",
    run: (ctx) => ctx.setActiveModel?.("shugu-sonnet-5"),
  },
  {
    id: "set-model-h",
    title: "Switch Model · shugu-haiku-4-5",
    category: "Workbench",
    icon: "sparkle",
    description: "fast · default",
    run: (ctx) => ctx.setActiveModel?.("shugu-haiku-4-5"),
  },
  {
    id: "set-model-l",
    title: "Switch Model · local qwen-32b",
    category: "Workbench",
    icon: "sparkle",
    description: "ollama",
    run: (ctx) => ctx.setActiveModel?.("qwen-32b"),
  },

  // ── Edit ─────────────────────────────────────────────────
  {
    // Renamed from `find` per decision 9.
    id: "find-in-file",
    title: "Find in file",
    category: "Edit",
    keybinding: ["Cmd", "F"],
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => {
      const view = ctx.editorViewRef?.current?.getView();
      if (view) openSearchPanel(view);
    },
  },
  {
    // Renamed from `replace` per mapping doc.
    id: "replace-in-file",
    title: "Replace",
    category: "Edit",
    keybinding: ["Cmd", "Alt", "F"],
    when: (ctx) => ctx.currentView === "code",
    run: (ctx) => {
      // openSearchPanel also exposes the replace UI when called from a replace keybinding.
      const view = ctx.editorViewRef?.current?.getView();
      if (view) openSearchPanel(view);
    },
  },
  {
    // LOT 2b — Format document (Shift+Alt+F).
    //
    // Calls formatCurrentDocument with allowLsp=FALSE → CLI path only (prettier
    // / rustfmt / gofmt / black via format_code Tauri command). LSP-first was
    // tried initially but proved unreliable with typescript-language-server:
    //   1. LSP's formatDocument returns true synchronously even when the
    //      server has no formatter capability registered → editor receives
    //      no edits visibly.
    //   2. Duplicate textDocument/didOpen on CodeMirror remount triggers
    //      tsserver's "Can't open already open document" warning; in some
    //      paths this can desync tsserver's document view from the editor
    //      buffer, causing formatting to operate on stale content.
    // CLI path is consistent with format-on-save and yields reliable results.
    // Future: implement a custom ref-counting Workspace to fix the LSP path
    // and restore LSP-aware formatting for tsconfig/eslint-aware output.
    id: "format-document",
    title: "Format Document",
    category: "Edit",
    keybinding: ["Shift", "Alt", "F"],
    when: (ctx) => ctx.currentView === "code" && ctx.activeFile !== null,
    run: async (ctx) => {
      const view = ctx.editorViewRef?.current?.getView();
      if (!view || !ctx.activeFile) return;
      const langId = ctx.fileContents[ctx.activeFile]?.lang ?? "";
      await formatCurrentDocument(view, langId, ctx.activeFile, false);
    },
  },
  {
    id: "regenerate",
    title: "Regenerate last reply",
    category: "Edit",
    keybinding: ["Cmd", "R"],
    when: () => false,
    run: () => { /* TODO: retrigger last AI message (needs stream runner in ctx) */ },
  },
  {
    // input-local: Enter in chat input — never dispatched globally.
    id: "send-message",
    title: "Send message",
    category: "Edit",
    keybinding: ["Enter"],
    scope: "input",
    run: () => { /* handled by chat input component */ },
  },
  {
    // input-local: Shift+Enter in chat input — never dispatched globally.
    id: "new-line",
    title: "New line in chat",
    category: "Edit",
    keybinding: ["Shift", "Enter"],
    scope: "input",
    run: () => { /* handled by chat input component */ },
  },

  // ── Selection ─────────────────────────────────────────────
  {
    id: "ai-rewrite",
    title: "AI rewrite selection",
    category: "Selection",
    keybinding: ["Cmd", "E"],
    when: () => false,
    run: () => { /* TODO: AI rewrite selection (needs CodeMirror selection ref) */ },
  },
  {
    // Rebound from ⌘⇧E (collision with view-code) → ⌘⌥E per decision 2.
    id: "ai-explain",
    title: "Explain selection",
    category: "Selection",
    keybinding: ["Cmd", "Alt", "E"],
    when: () => false,
    run: () => { /* TODO: explain selection via AI (needs selection state) */ },
  },
  {
    id: "anno-comment",
    title: "Add comment to selection",
    category: "Selection",
    keybinding: ["Cmd", "Shift", "M"],
    // Disabled until selection target is available in CommandContext (Pass 2).
    // Calling onAnnotate with target:null crashes RootLayout's handler.
    when: () => false,
    run: () => { /* TODO: needs selection target in ctx — see Pass 2 */ },
  },
  {
    // NOTE: ⌘⇧F also claimed by search-in-files (both disabled in Pass 1).
    // Pass 2 decision: rebind anno-flag to avoid collision.
    id: "anno-flag",
    title: "Add flag",
    category: "Selection",
    keybinding: ["Cmd", "Shift", "F"],
    when: () => false,
    run: () => { /* TODO: add flag annotation (needs target from ctx) */ },
  },
  {
    // Rebound from ⌘P (collision with quickopen-file) → ⌘⇧P per decision 3.
    id: "anno-pin",
    title: "Pin to floating chat",
    category: "Selection",
    keybinding: ["Cmd", "Shift", "P"],
    when: () => false,
    run: () => { /* TODO: pin selection to FloatChat (needs selection target) */ },
  },

  // ── Go ────────────────────────────────────────────────────
  {
    id: "next-tab",
    title: "Next tab",
    category: "Go",
    // Pass 2: ["Ctrl","Tab"] collides with the primary modifier on Win/Linux now that Ctrl→Cmd in eventToKey; rebind to a non-Ctrl chord.
    keybinding: ["Ctrl", "Tab"],
    when: (ctx) => (ctx.openFiles?.length ?? 0) > 1,
    run: (ctx) => {
      if (!ctx.openFiles || ctx.openFiles.length <= 1) return;
      const i = ctx.openFiles.indexOf(ctx.activeFile);
      if (i < 0) return;
      ctx.setActiveFile?.(ctx.openFiles[(i + 1) % ctx.openFiles.length]);
    },
  },
  {
    id: "prev-tab",
    title: "Previous tab",
    category: "Go",
    // Pass 2: ["Ctrl","Shift","Tab"] collides with the primary modifier on Win/Linux now that Ctrl→Cmd in eventToKey; rebind to a non-Ctrl chord.
    keybinding: ["Ctrl", "Shift", "Tab"],
    when: (ctx) => (ctx.openFiles?.length ?? 0) > 1,
    run: (ctx) => {
      if (!ctx.openFiles || ctx.openFiles.length <= 1) return;
      const i = ctx.openFiles.indexOf(ctx.activeFile);
      if (i < 0) return;
      ctx.setActiveFile?.(ctx.openFiles[(i - 1 + ctx.openFiles.length) % ctx.openFiles.length]);
    },
  },
  {
    // LOT 2 — grep textuel workspace via ripgrep-as-library (Rust backend
    // fs_grep_workspace). Remplace l'ancien wiring vecSearch (semantic) —
    // celui-ci reste disponible en interne via lib/vector.ts mais quitte
    // la palette (Cmd+Shift+F a une sémantique "grep textuel" dans tous
    // les IDE modernes, l'ancienne UX confondait les utilisateurs).
    id: "search-in-files",
    title: "Search in files",
    category: "Go",
    keybinding: ["Cmd", "Shift", "F"],
    when: () => true,
    run: (ctx) => {
      // Si on n'est pas déjà sur /code, on bascule pour que les click-
      // through dans le panel ouvrent bien le fichier dans l'éditeur.
      if (ctx.currentView !== "code") ctx.navigateTo("code");
      ctx.setFindPanelOpen?.(true);
    },
  },

  // ── Image ─────────────────────────────────────────────────
  {
    id: "img-generate",
    title: "Generate image",
    category: "File",
    keybinding: ["Cmd", "Enter"],
    when: (ctx) => ctx.currentView === "image",
    run: () => { /* TODO: trigger image generation (context: Image view) */ },
  },
  {
    id: "img-variation",
    title: "Variations of current",
    category: "File",
    keybinding: ["Cmd", "Shift", "V"],
    when: (ctx) => ctx.currentView === "image",
    run: () => { /* TODO: trigger image variations (context: Image view) */ },
  },
  {
    // ⌘S is shared with save-file; guarded by view context (intentional — see mapping doc §2.1).
    id: "img-save",
    title: "Save to gallery",
    category: "File",
    keybinding: ["Cmd", "S"],
    when: (ctx) => ctx.currentView === "image",
    run: () => { /* TODO: save current generation to gallery */ },
  },

  // ── Terminal ──────────────────────────────────────────────
  {
    id: "toggle-terminal",
    title: "Toggle terminal",
    category: "Terminal",
    keybinding: ["Cmd", "`"],
    // pty backend not yet wired.
    when: () => false,
    run: (ctx) => { ctx.setDockState?.((s: any) => ({ ...s, terminalOpen: !s.terminalOpen })); },
  },

  // ── Conversation list (input-local) ───────────────────────
  {
    id: "list-pin",
    title: "Pin / unpin",
    category: "Workbench",
    keybinding: ["P"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
  {
    id: "list-rename",
    title: "Rename",
    category: "Workbench",
    keybinding: ["R"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
  {
    id: "list-unread",
    title: "Toggle unread",
    category: "Workbench",
    keybinding: ["U"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
  {
    id: "list-duplicate",
    title: "Duplicate",
    category: "Workbench",
    keybinding: ["F"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
  {
    id: "list-archive",
    title: "Archive",
    category: "Workbench",
    keybinding: ["A"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
  {
    id: "list-delete",
    title: "Delete",
    category: "Workbench",
    keybinding: ["Shift", "D"],
    scope: "input",
    run: () => { /* handled by conversation-list component */ },
  },
];

// ─── Helpers ──────────────────────────────────────────────────

export function getCommandById(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}

/**
 * Format a keybinding token array into a compact display string.
 * e.g. ["Cmd", "Shift", "K"] → "⌘⇧K"
 * Extracted from CommandPalette (RootLayout.tsx) in Pass 2 so MenuBar can share it.
 */
export function fmtKbd(tokens: string[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  const map: Record<string, string> = {
    Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↵", Tab: "⇥", Space: "␣",
  };
  return tokens.map((t) => map[t] ?? t).join("");
}

/**
 * Build a canonical string key from a keybinding token array.
 * Matches the recording order in settings-extras.tsx:
 *   Cmd → Ctrl → Alt → Shift → KEY
 * Example: ["Cmd", "Shift", "K"] → "Cmd+Shift+K"
 */
export function bindingToKey(tokens: string[]): string {
  return tokens.join("+");
}
