// Shugu Forge — Lot 1 (Éditeur⇄AI) — types partagés du module ai-edit.
//
// Pure data module — aucun import React/CodeMirror. Sert de contrat entre le
// contrôleur (aiEditController), le runner (runAiEdit), l'extension diff
// (unifiedDiffExtension) et l'UI (InlineEditWidget).

/**
 * Modes d'édition AI. NB : "explain" n'est PAS ici — expliquer une sélection
 * est read-only et part dans le chat (cf. commands.ts::ai-explain), pas dans
 * le flux diff inline.
 *   - "edit"     : instruction libre de l'utilisateur (Cmd+K).
 *   - "refactor" : "refactore pour la clarté/qualité, comportement préservé".
 *   - "fix"      : "corrige bugs/erreurs" (peut être seedé de diagnostics LSP).
 */
export type AiEditMode = "edit" | "refactor" | "fix";

/**
 * Phase de la session d'édition inline.
 *   - "idle"      : aucune session.
 *   - "prompting" : le widget Cmd+K attend l'instruction (avant tout appel AI).
 *   - "streaming" : l'AI streame le code dans le doc (éditeur read-only).
 *   - "preview"   : stream terminé, diff inline affiché, attente Accept/Reject.
 *   - "error"     : l'appel a échoué ; `error` porte le message.
 */
export type AiEditStatus = "idle" | "prompting" | "streaming" | "preview" | "error";

/**
 * État d'une session d'édition AI, vit dans le cache TanStack (queryKey
 * AI_EDIT_KEY) — jamais dans un useState (pattern useChatStream). Sérialisable
 * volontairement : aucune référence EditorView ici (les méthodes du contrôleur
 * reçoivent la `view` en argument depuis le widget).
 */
export interface AiEditSession {
  status: AiEditStatus;
  mode: AiEditMode;
  /** Chemin workspace-relatif du fichier édité (pour l'état applicatif: dirty). */
  path: string | null;
  /** Identifiant de langage (pour le prompt AI). */
  lang: string;
  /** Texte complet du document AVANT l'édit — snapshot pour le diff + l'undo. */
  originalDoc: string;
  /** Texte de la sélection d'origine dans le range (pour le ré-apply 1-undo). */
  originalSelection: string;
  /** Région d'insertion [insertedFrom, insertedTo) qui porte le texte streamé/final. */
  insertedFrom: number;
  insertedTo: number;
  /** Partiel accumulé en live (affichage optionnel dans le widget). */
  partial: string;
  /** Position d'ancrage du widget (tête de sélection), en coords écran. */
  anchor: { x: number; y: number } | null;
  /** Conversation id synthétique `aiedit:<uuid>` utilisé pour l'abort chat_send. */
  convId: string | null;
  /** État dirty du fichier AVANT l'édit (restauré au Reject). */
  wasDirty: boolean;
  error?: string;
}

export const AI_EDIT_KEY = ["ai-edit", "session"] as const;

export const INITIAL_AI_EDIT_SESSION: AiEditSession = {
  status: "idle",
  mode: "edit",
  path: null,
  lang: "",
  originalDoc: "",
  originalSelection: "",
  insertedFrom: 0,
  insertedTo: 0,
  partial: "",
  anchor: null,
  convId: null,
  wasDirty: false,
};

/** Préfixe des conversationId synthétiques pour isoler le stream inline du chat. */
export const AI_EDIT_CONV_PREFIX = "aiedit:";
