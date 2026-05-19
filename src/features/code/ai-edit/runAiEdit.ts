// Shugu Forge — Lot 1 (Éditeur⇄AI) — runner d'édition AI inline.
//
// Appelle le MÊME backend que le chat (`chat_send`, streaming + abortable) mais
// SANS persister dans une conversation : on passe un conversationId synthétique
// `aiedit:<uuid>` et on n'appelle jamais appendMessage. Le chat reste propre, et
// useChatStreamListener ignore ces deltas (cf. garde dans useChatStream.ts).
//
// Le system prompt force "retourne UNIQUEMENT le code, sans fences" ; on strip
// quand même les fences défensivement (les modèles fuient un ```lang ~10% du
// temps), à la volée ET sur le résultat final.

import { invoke, listen } from "@/lib/tauri";
import { resolveChatTarget, getActiveModel } from "@/features/chat/chat-sync";
import type { AiEditMode } from "./types";

// ---------------------------------------------------------------------------
// Strip de fences markdown
// ---------------------------------------------------------------------------

/**
 * Retire une fence ```lang d'ouverture en tête et une fence ``` de fermeture
 * en fin. Sûr à appliquer sur du texte ACCUMULÉ en cours de stream : la regex
 * de fermeture ne matche que quand le ``` final est arrivé, donc tant que le
 * stream n'est pas terminé elle ne touche à rien.
 */
export function stripFences(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9+_#-]*\r?\n/, "")
    .replace(/\r?\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// Construction des prompts
// ---------------------------------------------------------------------------

const SYSTEM_EDIT_PROMPT =
  "You are a code-editing assistant embedded in an IDE. You receive a snippet " +
  "of code and an instruction. Return ONLY the code that should replace the " +
  "snippet — no explanations, no commentary, and NO markdown code fences. " +
  "Preserve the surrounding indentation style and language. If the instruction " +
  "asks to add or insert code, return the full snippet including the addition.";

function buildUserPrompt(
  mode: AiEditMode,
  selection: string,
  instruction: string,
  lang: string,
  diagnostics: string,
): string {
  const langLabel = lang || "code";
  if (mode === "refactor") {
    return (
      `Refactor the following ${langLabel} code for clarity and quality while ` +
      `preserving its exact behavior. Return only the refactored code.\n\n${selection}`
    );
  }
  if (mode === "fix") {
    const diag = diagnostics ? `\n\nReported diagnostics:\n${diagnostics}` : "";
    return (
      `Fix all bugs and errors in the following ${langLabel} code. ` +
      `Return only the corrected code.${diag}\n\n${selection}`
    );
  }
  // mode === "edit"
  if (!selection.trim()) {
    // Génération / insertion au curseur (pas de sélection).
    return `Instruction: ${instruction}\n\n(Generate ${langLabel} code to insert at the cursor. Return only the code.)`;
  }
  return `Instruction: ${instruction}\n\nCode (${langLabel}):\n${selection}`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// Garde-fou : si chat_send hang (endpoint qui accepte la connexion puis ne
// renvoie rien — modèle local qui charge, réseau coupé après le socket), le
// flag d'abort côté Rust n'est consulté qu'aux frontières de chunk et ne sert
// à rien tant qu'aucun octet n'arrive. Ce timeout JS garantit que la session
// ne reste pas coincée en "streaming" (éditeur verrouillé) indéfiniment.
const AI_EDIT_TIMEOUT_MS = 120_000;

export interface RunAiEditArgs {
  mode: AiEditMode;
  /** Code sélectionné (vide = génération/insertion au curseur). */
  selection: string;
  /** Instruction libre (mode "edit"). */
  instruction?: string;
  /** Identifiant de langage pour le prompt (ex. "typescript"). */
  lang?: string;
  /** Diagnostics LSP du range (mode "fix"), optionnel. */
  diagnostics?: string;
  /** conversationId synthétique `aiedit:<uuid>` (pour l'abort + l'isolation). */
  convId: string;
  /** Appelé à chaque chunk de contenu avec le texte ACCUMULÉ (déjà dé-fencé). */
  onDelta: (accumulated: string) => void;
}

// Forme plate (tsconfig strict:false → pas de narrowing d'union fiable).
export interface RunAiEditResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Lance une transformation AI one-shot et streame le résultat via `onDelta`.
 * Retourne le texte final (dé-fencé) ou une erreur. N'écrit JAMAIS dans le
 * chat (pas d'appendMessage).
 */
export async function runAiEdit(args: RunAiEditArgs): Promise<RunAiEditResult> {
  const { mode, selection, instruction = "", lang = "", diagnostics = "", convId, onDelta } = args;

  const resolved = await resolveChatTarget(getActiveModel());
  if (!resolved.ok) {
    const reason = resolved.reason === "disabled" ? "désactivé" : "non configuré";
    return {
      ok: false,
      error: `Provider "${resolved.providerId}" ${reason}. Configure-le dans Settings → Connections, ou choisis un autre modèle.`,
    };
  }
  const { protocol, baseUrl, apiKey, model } = resolved.target;

  const messages = [
    { role: "system", content: SYSTEM_EDIT_PROMPT },
    { role: "user", content: buildUserPrompt(mode, selection, instruction, lang, diagnostics) },
  ];

  // Listener dédié sur chat://delta, filtré sur NOTRE convId synthétique.
  // Attaché AVANT l'invoke pour ne pas rater les premiers chunks. Le done est
  // ignoré ici : on s'appuie sur la valeur de retour de chat_send comme texte
  // final autoritaire.
  let raw = "";
  let unlisten: (() => void) | null = null;
  try {
    // listen de @/lib/tauri passe le PAYLOAD directement au callback (pas un
    // event Tauri wrappé) — cf. useChatStream.ts qui fait `(delta) => …`.
    unlisten = await listen<{ conversationId?: string; chunk: string; kind?: string; done: boolean }>(
      "chat://delta",
      (p) => {
        if (!p || p.conversationId !== convId || p.done) return;
        if ((p.kind ?? "content") !== "content") return; // ignore reasoning
        raw += p.chunk;
        onDelta(stripFences(raw));
      },
    );
  } catch (err) {
    console.warn("[runAiEdit] listener attach failed:", err);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const TIMEOUT_SENTINEL = "__aiedit_timeout__";
  try {
    // Force thinking OFF : on veut du code direct, pas de préambule de raisonnement.
    // Race contre un timeout pour ne jamais laisser l'éditeur verrouillé à vie.
    const reply = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), AI_EDIT_TIMEOUT_MS);
      void invoke<string>("chat_send", {
        messages,
        model,
        protocol,
        baseUrl,
        apiKey,
        conversationId: convId,
        chatTemplateKwargs: { enable_thinking: false },
      }).then(resolve, reject);
    });
    return { ok: true, text: stripFences(reply) };
  } catch (err) {
    if (err instanceof Error && err.message === TIMEOUT_SENTINEL) {
      void abortAiEdit(convId); // tente de stopper le backend (best-effort)
      return {
        ok: false,
        error: `Délai dépassé (${AI_EDIT_TIMEOUT_MS / 1000}s) — le modèle n'a pas répondu. Réessaie ou change de modèle.`,
      };
    }
    return { ok: false, error: String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    unlisten?.();
  }
}

/** Demande au backend d'interrompre le stream inline en cours pour ce convId. */
export async function abortAiEdit(convId: string): Promise<void> {
  try {
    await invoke("chat_abort", { conversationId: convId });
  } catch (err) {
    console.warn("[runAiEdit] abort failed:", err);
  }
}
