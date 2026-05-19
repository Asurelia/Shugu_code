// Shugu Forge — Word wrap Compartment singleton.
//
// LOT 1 — module-level singleton so the Compartment identifier is stable
// across all editor instances (important for future split-editor support).
// Each EditorState holds its own value at this slot, so sharing the
// Compartment reference is safe and idiomatic.
//
// Pattern note: per-instance compartments (e.g. lspCompartment) use
// `useMemo(() => new Compartment(), [])` to get one unique identifier
// per component instance. Module-level singletons like this one are the
// correct pattern when you want ONE global slot shared by all instances.

import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Stable singleton Compartment for word-wrap configuration. */
export const wordWrapCompartment = new Compartment();

/** Initial extension value for the Compartment (used in EditorState.create). */
export function wordWrapInitial(on: boolean) {
  return on ? EditorView.lineWrapping : [];
}

/**
 * Reconfigure word wrap on a live EditorView without re-mounting.
 * Dispatches a single Compartment.reconfigure effect — cursor and scroll
 * are preserved because the doc is not touched.
 */
export function setWordWrap(view: EditorView, on: boolean): void {
  view.dispatch({
    effects: wordWrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
  });
}
