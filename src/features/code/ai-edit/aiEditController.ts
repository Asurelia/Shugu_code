// Shugu Forge — Lot 1 (Éditeur⇄AI) — contrôleur de session d'édition inline.
//
// Orchestre : snapshot de l'original → stream du code AI dans le doc → preview
// diff (unifiedMergeView) → Accept (1 seule entrée d'undo) / Reject (aucune
// trace). L'état de session vit dans le cache TanStack (AI_EDIT_KEY), jamais
// dans un useState (pattern useChatStream). Les méthodes reçoivent la `view`
// CodeMirror en argument (passée par le widget via editorViewRef).

import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  AI_EDIT_KEY,
  AI_EDIT_CONV_PREFIX,
  INITIAL_AI_EDIT_SESSION,
  type AiEditSession,
  type AiEditMode,
} from "./types";
import {
  enterStreaming,
  enterPreview,
  clearAiEdit,
  aiEditStreamAnnotation,
} from "./unifiedDiffExtension";
import { runAiEdit, abortAiEdit } from "./runAiEdit";

// ---------------------------------------------------------------------------
// État de session (cache TanStack)
// ---------------------------------------------------------------------------

function getSession(): AiEditSession {
  return queryClient.getQueryData<AiEditSession>(AI_EDIT_KEY) ?? INITIAL_AI_EDIT_SESSION;
}

function setSession(updater: (s: AiEditSession) => AiEditSession): void {
  queryClient.setQueryData<AiEditSession>(AI_EDIT_KEY, (prev) =>
    updater(prev ?? INITIAL_AI_EDIT_SESSION),
  );
}

function resetSession(): void {
  queryClient.setQueryData<AiEditSession>(AI_EDIT_KEY, INITIAL_AI_EDIT_SESSION);
}

/** Hook de lecture réactive de la session (pour le widget). */
export function useAiEditSession(): AiEditSession {
  const { data = INITIAL_AI_EDIT_SESSION } = useQuery<AiEditSession>({
    queryKey: AI_EDIT_KEY,
    queryFn: () => INITIAL_AI_EDIT_SESSION,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Restaure le range inséré à son contenu d'origine, SANS suppression d'onChange
 * (donc fileContents repart de l'original) et SANS entrée d'undo. Utilisé par
 * Reject / Abort / erreur. Retire aussi le diff + le verrou.
 */
function teardownRestore(view: EditorView, s: AiEditSession): void {
  clearAiEdit(view);
  view.dispatch({
    changes: { from: s.insertedFrom, to: s.insertedTo, insert: s.originalSelection },
    annotations: [Transaction.addToHistory.of(false)],
    selection: { anchor: s.insertedFrom },
  });
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Applique le texte ACCUMULÉ (déjà dé-fencé) dans la région insérée. */
function applyDelta(view: EditorView, acc: string): void {
  const s = getSession();
  if (s.status !== "streaming") return; // session annulée entre-temps
  view.dispatch({
    changes: { from: s.insertedFrom, to: s.insertedTo, insert: acc },
    annotations: [aiEditStreamAnnotation.of(true), Transaction.addToHistory.of(false)],
    scrollIntoView: true,
  });
  setSession((st) => ({ ...st, insertedTo: st.insertedFrom + acc.length, partial: acc }));
}

/** Remplace la région insérée par le texte final autoritaire (dé-fencé). */
function finalizeInserted(view: EditorView, finalText: string): void {
  const s = getSession();
  view.dispatch({
    changes: { from: s.insertedFrom, to: s.insertedTo, insert: finalText },
    annotations: [aiEditStreamAnnotation.of(true), Transaction.addToHistory.of(false)],
  });
  setSession((st) => ({ ...st, insertedTo: st.insertedFrom + finalText.length }));
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

export interface OpenPromptOpts {
  path: string | null;
  lang?: string;
  /** État dirty du fichier AVANT l'édit (restauré au Reject par le widget). */
  wasDirty?: boolean;
  /** Ancrage écran du widget (tête de sélection). */
  anchor?: { x: number; y: number } | null;
}

/**
 * Ouvre la phase "prompting" (Cmd+K) : capture la sélection + le doc, VERROUILLE
 * l'éditeur (pour figer la sélection pendant la saisie) et attend l'instruction.
 * Le widget affiche alors son champ de saisie.
 */
export function openPrompt(view: EditorView, opts: OpenPromptOpts): void {
  // Garde re-entrance : si une session est déjà en cours (prompting/streaming/
  // preview/error), ne PAS la clobber — sinon on re-snapshoterait `originalDoc`
  // depuis le doc déjà édité et le vrai original deviendrait irrécupérable.
  if (getSession().status !== "idle") return;
  const sel = view.state.selection.main;
  setSession(() => ({
    ...INITIAL_AI_EDIT_SESSION,
    status: "prompting",
    mode: "edit",
    path: opts.path,
    lang: opts.lang ?? "",
    originalDoc: view.state.doc.toString(),
    originalSelection: view.state.sliceDoc(sel.from, sel.to),
    insertedFrom: sel.from,
    insertedTo: sel.to,
    anchor: opts.anchor ?? null,
    wasDirty: opts.wasDirty ?? false,
  }));
  enterStreaming(view); // verrou read-only : la sélection/range reste stable
}

/** Soumet l'instruction (Cmd+K) : prompting → streaming → preview. */
export async function submitPrompt(view: EditorView, instruction: string): Promise<void> {
  const s = getSession();
  if (s.status !== "prompting") return;
  const convId = AI_EDIT_CONV_PREFIX + genId();
  setSession((st) => ({ ...st, status: "streaming", convId, partial: "" }));
  await streamAndPreview(view, {
    mode: "edit",
    instruction,
    selection: s.originalSelection,
    lang: s.lang,
    convId,
    originalDoc: s.originalDoc,
  });
}

/** Annule la phase prompting (Esc avant soumission) : déverrouille + reset. */
export function cancelPrompt(view: EditorView): void {
  if (getSession().status !== "prompting") return;
  clearAiEdit(view); // aucune modif de doc en prompting → simple déverrouillage
  resetSession();
}

// Options pour les modes immédiats (refactor / fix), sans phase de prompt.
export interface RunImmediateOpts {
  mode: Exclude<AiEditMode, "edit">;
  path: string | null;
  lang?: string;
  diagnostics?: string;
  wasDirty?: boolean;
  anchor?: { x: number; y: number } | null;
}

/** Lance immédiatement un refactor/fix sur la sélection (pas de prompt). */
export async function runImmediate(view: EditorView, opts: RunImmediateOpts): Promise<void> {
  // Garde re-entrance (cf. openPrompt) : pas de clobber d'une session active.
  if (getSession().status !== "idle") return;
  const sel = view.state.selection.main;
  const originalSelection = view.state.sliceDoc(sel.from, sel.to);
  if (!originalSelection.trim()) {
    setSession(() => ({
      ...INITIAL_AI_EDIT_SESSION,
      status: "error",
      mode: opts.mode,
      anchor: opts.anchor ?? null,
      error: `Sélectionne d'abord le code à ${opts.mode === "fix" ? "corriger" : "refactorer"}.`,
    }));
    return;
  }
  const originalDoc = view.state.doc.toString();
  const convId = AI_EDIT_CONV_PREFIX + genId();
  setSession(() => ({
    ...INITIAL_AI_EDIT_SESSION,
    status: "streaming",
    mode: opts.mode,
    path: opts.path,
    lang: opts.lang ?? "",
    originalDoc,
    originalSelection,
    insertedFrom: sel.from,
    insertedTo: sel.to,
    anchor: opts.anchor ?? null,
    convId,
    wasDirty: opts.wasDirty ?? false,
  }));
  enterStreaming(view);
  await streamAndPreview(view, {
    mode: opts.mode,
    instruction: "",
    selection: originalSelection,
    lang: opts.lang ?? "",
    diagnostics: opts.diagnostics,
    convId,
    originalDoc,
  });
}

interface StreamParams {
  mode: AiEditMode;
  instruction: string;
  selection: string;
  lang: string;
  diagnostics?: string;
  convId: string;
  originalDoc: string;
}

/** Boucle interne : appel runner → preview (succès) ou status erreur. */
async function streamAndPreview(view: EditorView, p: StreamParams): Promise<void> {
  const result = await runAiEdit({
    mode: p.mode,
    selection: p.selection,
    instruction: p.instruction,
    lang: p.lang,
    diagnostics: p.diagnostics,
    convId: p.convId,
    onDelta: (acc) => applyDelta(view, acc),
  });

  // Session annulée pendant le stream (abort → resetSession) : on n'écrase rien.
  const live = getSession();
  if (live.convId !== p.convId) return;

  if (!result.ok) {
    teardownRestore(view, live);
    setSession((s) => ({ ...s, status: "error", error: result.error }));
    return;
  }

  // Résultat vide (modèle "thinking" qui ne renvoie que du raisonnement, stream
  // vide, modèle qui ignore le prompt) : NE PAS le traiter comme un édit valide
  // — sinon finalizeInserted("") supprimerait la sélection silencieusement.
  const finalText = result.text ?? "";
  if (finalText.trim() === "") {
    teardownRestore(view, live);
    setSession((s) => ({
      ...s,
      status: "error",
      error: "Le modèle n'a renvoyé aucun code. Réessaie, reformule l'instruction, ou désactive le mode raisonnement.",
    }));
    return;
  }

  finalizeInserted(view, finalText);
  enterPreview(view, p.originalDoc);
  setSession((s) => ({ ...s, status: "preview", partial: finalText }));
}

/**
 * Accepte l'édit : retire le diff puis injecte UNE seule entrée d'undo
 * (original→final) via restore-then-reapply. La 2ᵉ transaction n'est PAS
 * annotée stream → onChange propage le texte final vers fileContents (dirty).
 */
export function acceptSession(view: EditorView): void {
  const s = getSession();
  if (s.status !== "preview") return;
  const finalText = view.state.sliceDoc(s.insertedFrom, s.insertedTo);

  clearAiEdit(view);
  // (i) restaure l'original — silencieux (onChange supprimé), hors historique.
  view.dispatch({
    changes: { from: s.insertedFrom, to: s.insertedTo, insert: s.originalSelection },
    annotations: [aiEditStreamAnnotation.of(true), Transaction.addToHistory.of(false)],
  });
  // (ii) ré-applique le final — historisé (1 undo) + onChange propage le texte.
  view.dispatch({
    changes: {
      from: s.insertedFrom,
      to: s.insertedFrom + s.originalSelection.length,
      insert: finalText,
    },
    annotations: [Transaction.addToHistory.of(true)],
    selection: { anchor: s.insertedFrom + finalText.length },
  });
  resetSession();
}

/** Rejette l'édit (phase preview) : restaure l'original. Retourne wasDirty. */
export function rejectSession(view: EditorView): boolean {
  const s = getSession();
  if (s.status !== "preview") return s.wasDirty;
  teardownRestore(view, s);
  const wasDirty = s.wasDirty;
  resetSession();
  return wasDirty;
}

/** Abort en cours de stream : stoppe le backend + restaure l'original. */
export function abortSession(view: EditorView): boolean {
  const s = getSession();
  if (s.convId) void abortAiEdit(s.convId);
  teardownRestore(view, s);
  const wasDirty = s.wasDirty;
  resetSession();
  return wasDirty;
}

/** Ferme l'état d'erreur — doc déjà restauré + verrou levé par teardownRestore
 *  dans streamAndPreview (chemin erreur). Retourne wasDirty. */
export function dismissSession(): boolean {
  const wasDirty = getSession().wasDirty;
  resetSession();
  return wasDirty;
}

/**
 * Abandonne la session SANS toucher à aucune EditorView : utilisé quand la view
 * d'origine a été démontée ou que l'utilisateur a changé de fichier en cours de
 * session (le widget détecte session.path !== activeFile). Stoppe le backend et
 * vide le cache ; ne dispatch RIEN (l'ancienne view est morte, la nouvelle est
 * propre). L'ancien fichier garde son contenu d'avant l'édit car le stream
 * n'avait jamais propagé via onChange (annotation aiEditStream).
 */
export function discardSession(): void {
  const s = getSession();
  if (s.convId) void abortAiEdit(s.convId);
  resetSession();
}
