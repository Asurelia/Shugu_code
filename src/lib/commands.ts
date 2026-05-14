// Shugu Forge — Unified command registry.
// Pure data module — no React imports. Safe to import from anywhere.
// Pass 1: flat COMMANDS array with default keybindings, categories, run/when predicates.

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
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;

  // Files
  openFiles: string[];
  activeFile: string | null;

  // Gallery / Agents
  generations: any[];
  agents: any[];

  // Annotations
  onAnnotate: (payload: { kind: string; payload: any; target: any }) => void;
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
    // Filesystem backend not yet wired; editor-context only.
    when: () => false,
    run: () => { /* TODO: save active file via Tauri fs command */ },
  },
  {
    id: "save-all",
    title: "Save all",
    category: "File",
    keybinding: ["Cmd", "Alt", "S"],
    when: () => false,
    run: () => { /* TODO: save all open files */ },
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
    id: "toggle-diff",
    title: "Toggle diff view",
    category: "View",
    keybinding: ["Cmd", "D"],
    when: () => false,
    run: () => { /* TODO: toggle diff view (requires git integration) */ },
  },

  // ── Models (palette-only, no keybinding) ──────────────────
  {
    id: "set-model",
    title: "Switch Model · shugu-sonnet-5",
    category: "Workbench",
    icon: "sparkle",
    description: "balanced · 200k ctx",
    run: () => { /* TODO: set active model to shugu-sonnet-5 */ },
  },
  {
    id: "set-model-h",
    title: "Switch Model · shugu-haiku-4-5",
    category: "Workbench",
    icon: "sparkle",
    description: "fast · default",
    run: () => { /* TODO: set active model to shugu-haiku-4-5 */ },
  },
  {
    id: "set-model-l",
    title: "Switch Model · local qwen-32b",
    category: "Workbench",
    icon: "sparkle",
    description: "ollama",
    run: () => { /* TODO: set active model to local qwen-32b */ },
  },

  // ── Edit ─────────────────────────────────────────────────
  {
    // Renamed from `find` per decision 9.
    id: "find-in-file",
    title: "Find in file",
    category: "Edit",
    keybinding: ["Cmd", "F"],
    // When inside CM6 editor, CM6 handles this natively via its own keymap.
    // When outside the editor this is a no-op (no EditorView ref in ctx yet).
    when: (ctx) => ctx.currentView === "code",
    run: () => {
      // CM6 handles ⌘F internally; dispatcher will not reach here from inside .cm-editor
      // (the cm-editor guard in useCommandKeybindings blocks it).
      // This run() fires only when ⌘F is pressed outside the editor while in code view.
    },
  },
  {
    // Renamed from `replace` per mapping doc.
    id: "replace-in-file",
    title: "Replace",
    category: "Edit",
    keybinding: ["Cmd", "Alt", "F"],
    when: (ctx) => ctx.currentView === "code",
    run: () => { /* Delegates to CM6 replace panel */ },
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
    when: () => false,
    run: () => { /* TODO: advance to next dock/editor tab */ },
  },
  {
    id: "prev-tab",
    title: "Previous tab",
    category: "Go",
    // Pass 2: ["Ctrl","Shift","Tab"] collides with the primary modifier on Win/Linux now that Ctrl→Cmd in eventToKey; rebind to a non-Ctrl chord.
    keybinding: ["Ctrl", "Shift", "Tab"],
    when: () => false,
    run: () => { /* TODO: advance to previous dock/editor tab */ },
  },
  {
    // New command per decision 9. Disabled: search backend does not exist yet.
    // NOTE: ⌘⇧F is also claimed by anno-flag (both disabled in Pass 1 — no conflict fires).
    id: "search-in-files",
    title: "Search in files",
    category: "Go",
    keybinding: ["Cmd", "Shift", "F"],
    when: () => false,
    run: () => { /* TODO: global text search across project files */ },
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
    run: () => { /* TODO: toggle dock terminal panel (setDockState) */ },
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
 * Build a canonical string key from a keybinding token array.
 * Matches the recording order in settings-extras.tsx:
 *   Cmd → Ctrl → Alt → Shift → KEY
 * Example: ["Cmd", "Shift", "K"] → "Cmd+Shift+K"
 */
export function bindingToKey(tokens: string[]): string {
  return tokens.join("+");
}
