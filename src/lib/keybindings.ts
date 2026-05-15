// Shugu Forge — Global keybinding dispatcher.
// A single window keydown listener that routes events to COMMANDS.
// CM6-owned keys are explicitly guarded; input-local commands are handled
// via scope:"input" in commands.ts (excluded from buildKeymap there).

import { useEffect, useCallback } from "react";
import { COMMANDS, bindingToKey, type CommandContext } from "./commands";

// ─── Constants ────────────────────────────────────────────────

const LS_SHORTCUTS = "shugu.shortcuts.v1";

/**
 * True on macOS/iOS. On Windows/Linux, the physical Ctrl key is the primary
 * modifier and maps to the "Cmd" token that COMMANDS use throughout.
 */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// ─── Shortcut resolution ──────────────────────────────────────

/**
 * Build a canonical key string from a KeyboardEvent using the same token
 * vocabulary as the settings-extras.tsx recording logic.
 * Order: Cmd → Ctrl → Alt → Shift → KEY
 *
 * Platform-normalization: "Cmd" is the PRIMARY modifier token used by all
 * COMMANDS entries. On macOS metaKey is the primary; on Windows/Linux ctrlKey
 * is the primary. The branches are exclusive — ctrlKey on Win/Linux emits
 * "Cmd" only (not "Ctrl"), so pressing Ctrl+K yields "Cmd+K" on all platforms.
 */
function eventToKey(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (IS_MAC) {
    if (e.metaKey) mods.push("Cmd");
    if (e.ctrlKey) mods.push("Ctrl"); // genuine secondary modifier on macOS
  } else {
    // Windows / Linux: Ctrl is the primary modifier → maps to "Cmd" token.
    // metaKey on Windows = the Windows/Super key; OS typically steals it; no
    // COMMANDS entry uses it, so we ignore it here.
    if (e.ctrlKey) mods.push("Cmd");
  }
  if (e.altKey)   mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  let key = e.key;
  // Bare modifier keypress: no actionable key yet.
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();

  return [...mods, key].join("+");
}

/**
 * On Windows/Linux, a shortcut recorded with the physical Ctrl key may have
 * been stored with the "Ctrl" token. Normalize it to "Cmd" so it matches
 * the primary-modifier token used by COMMANDS and produced by eventToKey().
 * On macOS, "Ctrl" is a genuine secondary modifier — leave it unchanged.
 */
function normalizePrimaryToken(keys: string[]): string[] {
  if (IS_MAC) return keys;
  return keys.map((t) => (t === "Ctrl" ? "Cmd" : t));
}

/**
 * Read user overrides from localStorage and return a Map<id, string[]>.
 * localStorage stores the full [{group, items:[{id, label, keys}]}] shape
 * that ShortcutsSettings saves (derived from DEFAULT_SHORTCUTS).
 */
function loadUserOverrides(): Map<string, string[]> {
  const overrides = new Map<string, string[]>();
  try {
    const raw = localStorage.getItem(LS_SHORTCUTS);
    if (!raw) return overrides;
    const groups: Array<{ group: string; items: Array<{ id: string; keys: string[] }> }> =
      JSON.parse(raw);
    for (const g of groups) {
      for (const it of g.items) {
        if (it.id && Array.isArray(it.keys) && it.keys.length > 0) {
          overrides.set(it.id, normalizePrimaryToken(it.keys));
        }
      }
    }
  } catch {
    // Malformed storage — ignore.
  }
  return overrides;
}

/**
 * Build the active keymap: for each global-scope command, resolve its
 * effective binding (user override wins over COMMANDS default).
 * Returns Map<canonicalKeyString, commandId>.
 */
function buildKeymap(overrides: Map<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const cmd of COMMANDS) {
    // Skip input-local commands — they are never globally dispatched.
    if (cmd.scope === "input") continue;

    const effectiveTokens = overrides.get(cmd.id) ?? cmd.keybinding;
    if (!effectiveTokens || effectiveTokens.length === 0) continue;

    const key = bindingToKey(effectiveTokens);
    if (key) map.set(key, cmd.id);
  }
  return map;
}

// ─── Guard helpers ────────────────────────────────────────────

/**
 * Returns true when the event should be handed off to the element's own
 * handler rather than the global dispatcher.
 *
 * NOTE: bare-key commands that belong inside text fields (send-message,
 * new-line, list-pin, etc.) are declared with scope:"input" in commands.ts
 * and are already excluded from buildKeymap() above — that is the canonical
 * safety mechanism, not an input-type check here.  Modifier-bearing global
 * commands (Cmd+K, Cmd+S, Cmd+Shift+O, …) must fire regardless of focus
 * target — including when focus is inside the CodeMirror editor.
 * CM6's own chords (Cmd+Z, Cmd+A, Tab, …) are not registered in COMMANDS,
 * so they naturally fall through (no match → no preventDefault → CM6 handles
 * them normally).
 *
 * FUTURE NOTE: when @codemirror/search is added later, Cmd+F (find-in-file)
 * will become a real conflict to resolve at the keymap level — not here.
 */
function shouldSkip(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!target || typeof (target as any).closest !== "function") return false;

  return false;
}

// ─── Hook ─────────────────────────────────────────────────────

/**
 * useCommandKeybindings — attach a single global keydown listener.
 * Must be called once, at the RootLayout level.
 */
export function useCommandKeybindings(ctx: CommandContext): void {
  const dispatch = useCallback((e: KeyboardEvent) => {
    if (shouldSkip(e)) return;

    const pressedKey = eventToKey(e);
    if (!pressedKey) return;

    // Rebuild keymap on each event so that user overrides are always fresh.
    // Performance note: this is O(N) over COMMANDS (~43 entries) — negligible.
    const overrides = loadUserOverrides();
    const keymap = buildKeymap(overrides);

    const cmdId = keymap.get(pressedKey);
    if (!cmdId) return;

    const cmd = COMMANDS.find((c) => c.id === cmdId);
    if (!cmd) return;

    // Check the when predicate.
    if (cmd.when && !cmd.when(ctx)) return;

    // Command matched — consume the event and run.
    e.preventDefault();
    void cmd.run(ctx);
  }, [ctx]);

  useEffect(() => {
    window.addEventListener("keydown", dispatch);
    return () => window.removeEventListener("keydown", dispatch);
  }, [dispatch]);
}
