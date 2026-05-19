/**
 * format.ts — Format document orchestrator for Shugu Forge (LOT 2b).
 *
 * ## LSP vs CLI paths
 *
 * Format-on-save (called from saveFile in RootLayout) uses CLI only.
 * Reason: formatDocument from @codemirror/lsp-client is a CodeMirror Command
 * that returns boolean synchronously — the actual edits arrive later when
 * the LSP responds via view.dispatch. Awaiting the Command return does NOT
 * wait for the edits, so reading view.state.doc.toString() immediately after
 * would return pre-format content, making save write unformatted bytes.
 *
 * The interactive keymap (Shift+Alt+F) uses LSP-first because the editor
 * will update reactively when the LSP edits land — no synchronous read needed.
 *
 * ## TanStack derogation
 *
 * format_code is invoked from event handlers (saveFile, command run), not
 * from a React render tree. useMutation would add ceremony (queryClient,
 * hook call site, mutation state) with no benefit — there is no loading state
 * to display, no cache to invalidate, and no retry needed (errors are logged
 * and save succeeds anyway). Direct invoke is the correct pattern here.
 * Deviation documented per project policy (feedback_tanstack_mandatory.md).
 */

import type { EditorView } from "@codemirror/view";
import { formatDocument } from "@codemirror/lsp-client";
import { invoke } from "@/lib/tauri";
import { diag } from "@/lib/diag";
import { isLspSupported } from "./lsp/client";
import { computeMinimalChanges } from "./format-diff";

/**
 * Module-level cache of language IDs for which CLI formatting failed
 * (binary not found). Avoids redundant subprocess spawn attempts.
 * Persists across React re-renders for the lifetime of the app session.
 */
const noCliFormatter = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Formats the current document using the CLI formatter for `langId`.
 * Applies changes via computeMinimalChanges (per-line LCS) to preserve
 * cursor position.
 *
 * Never throws — returns false if formatting fails (save should proceed
 * with original content in that case).
 *
 * @param view     The CodeMirror EditorView to format and update.
 * @param langId   Language ID (e.g. "typescript", "rust").
 * @param filePath Absolute path of the file (used for formatter config
 *                 discovery and prettier --stdin-filepath).
 * @returns true if formatting succeeded and the view was updated.
 */
export async function formatCurrentDocumentCli(
  view: EditorView,
  langId: string,
  filePath: string | null,
): Promise<boolean> {
  if (noCliFormatter.has(langId)) {
    diag("format", `${langId} in noCliFormatter cache — skip`);
    return false;
  }

  const code = view.state.doc.toString();

  let formatted: string;
  try {
    formatted = await invoke<string>("format_code", {
      lang: langId,
      code,
      filePath: filePath ?? null,
    });
  } catch (err) {
    const msg = typeof err === "string" ? err : String(err);
    if (
      msg.startsWith("no formatter for lang:") ||
      msg.startsWith("formatter not found:")
    ) {
      noCliFormatter.add(langId);
      diag("format", `no cli formatter for ${langId} — cached`);
    } else {
      diag("format", `format error (${langId}): ${msg}`);
    }
    return false;
  }

  const changes = computeMinimalChanges(view.state.doc, formatted);
  if (changes.length === 0) {
    diag("format", `${langId}: no changes`);
    return true; // Already formatted — success with no-op
  }

  view.dispatch({ changes });
  diag("format", `${langId}: applied ${changes.length} change(s)`);
  return true;
}

/**
 * Formats the source string directly via the CLI formatter, without a
 * CodeMirror view. Used by saveFile for non-active (background) files
 * where the view belongs to the active file and must not be touched.
 *
 * Respects the same `noCliFormatter` cache as formatCurrentDocumentCli.
 * Returns the formatted string on success, or null if formatting is
 * unavailable or fails (caller should save with original content).
 *
 * @param langId   Language ID.
 * @param code     Source code string to format.
 * @param filePath Absolute path (for config discovery + prettier --stdin-filepath).
 */
export async function formatCodeDirect(
  langId: string,
  code: string,
  filePath: string | null,
): Promise<string | null> {
  if (noCliFormatter.has(langId)) {
    diag("format", `${langId} in noCliFormatter cache — skip (direct)`);
    return null;
  }
  try {
    const formatted = await invoke<string>("format_code", {
      lang: langId,
      code,
      filePath: filePath ?? null,
    });
    return formatted;
  } catch (err) {
    const msg = typeof err === "string" ? err : String(err);
    if (
      msg.startsWith("no formatter for lang:") ||
      msg.startsWith("formatter not found:")
    ) {
      noCliFormatter.add(langId);
      diag("format", `no cli formatter for ${langId} — cached (direct)`);
    } else {
      diag("format", `format error direct (${langId}): ${msg}`);
    }
    return null;
  }
}

/**
 * Formats the current document.
 *
 * - From the interactive keymap (Shift+Alt+F): tries LSP first if supported,
 *   falls back to CLI.
 * - From format-on-save: always CLI (see module header for why).
 *
 * @param view      The CodeMirror EditorView.
 * @param langId    Language ID.
 * @param filePath  Absolute path of the file (may be null for unsaved files).
 * @param allowLsp  If false, skip LSP path (use for format-on-save).
 * @returns true if formatting succeeded.
 */
export async function formatCurrentDocument(
  view: EditorView,
  langId: string,
  filePath: string | null,
  allowLsp = true,
): Promise<boolean> {
  // LSP path: interactive format (Shift+Alt+F) only
  if (allowLsp && isLspSupported(langId)) {
    // formatDocument is a synchronous Command — returns true if LSP accepted it.
    // The actual edits land later via view.dispatch (LSP response).
    const handled = formatDocument(view);
    if (handled) {
      diag("format", `${langId}: dispatched to LSP`);
      return true;
    }
    diag("format", `${langId}: LSP returned false — falling back to CLI`);
  }

  // CLI path
  return formatCurrentDocumentCli(view, langId, filePath);
}
