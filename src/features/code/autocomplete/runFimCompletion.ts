// Shugu Forge — Lot 5 / Phase 7 #1 — requête de complétion FIM (frontend).
//
// Deux chemins vers le backend :
//   - `runFimCompletion`        : non-streaming (`fim_complete`, POST unique).
//     Conservé comme FALLBACK prouvé / chemin simple.
//   - `startFimCompletionStream`: streaming (`fim_complete_stream` + events
//     `fim://delta`). C'est ce que le déclencheur live utilise : la suggestion
//     s'affiche au fil des tokens (latence perçue ≈ premier token), et une
//     frappe annule le flux en vol via `chat_abort`.
//
// Construction du prompt SELON LE PROTOCOLE (le backend ne re-template pas) :
//   - openai/custom (`/v1/completions`) : prompt sentinel-encodé (buildFimPrompt),
//     le champ `suffix` est ignoré côté serveur.
//   - ollama (`/api/generate`) : prefix BRUT + `suffix` BRUT — ollama applique
//     le template FIM du modèle côté serveur (double-encoder serait faux).

import { invoke, listen } from "@/lib/tauri";
import { resolveChatTarget, getActiveModel } from "@/features/chat/chat-sync";
import { buildFimRequest } from "./fimPrompt";
import { sanitizeCompletion } from "./autocompleteState";

export interface FimResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Cible FIM résolue + validée, ou une erreur explicable à l'utilisateur.
 *  Discriminant `kind` (string) — distinct du `ok` de FimResult pour un
 *  narrowing sans ambiguïté. */
type FimTarget =
  | { kind: "ready"; protocol: string; baseUrl: string; apiKey?: string; model: string }
  | { kind: "error"; error: string };

/** Résout le provider actif et vérifie qu'il sait faire du FIM (openai/custom
 *  via `/v1/completions`, ollama via `/api/generate`). */
async function resolveFimTarget(): Promise<FimTarget> {
  const resolved = await resolveChatTarget(getActiveModel());
  if (!resolved.ok) {
    return { kind: "error", error: "Provider non configuré pour l'autocomplete." };
  }
  const { protocol, baseUrl, apiKey, model } = resolved.target;
  if (protocol !== "openai" && protocol !== "custom" && protocol !== "ollama") {
    return {
      kind: "error",
      error: `FIM nécessite un endpoint openai-compatible ou ollama (protocole actuel : ${protocol}).`,
    };
  }
  return { kind: "ready", protocol, baseUrl, apiKey, model };
}

/**
 * Complétion FIM NON-STREAMING (un seul POST). Fallback / chemin simple.
 */
export async function runFimCompletion(doc: string, cursor: number): Promise<FimResult> {
  const t = await resolveFimTarget();
  if (t.kind === "error") return { ok: false, error: t.error };
  const { prompt, suffix } = buildFimRequest(doc, cursor, t.protocol, t.model);

  try {
    const raw = await invoke<string>("fim_complete", {
      prompt,
      model: t.model,
      protocol: t.protocol,
      baseUrl: t.baseUrl,
      apiKey: t.apiKey,
      maxTokens: 128,
      // Stop tôt : une suggestion inline ne doit pas dévaler le fichier.
      stop: ["\n\n"],
      suffix,
    });
    return { ok: true, text: sanitizeCompletion(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Un flux FIM en cours : l'id PRÉFIXÉ (à passer à `chat_abort`) + la promise
 *  résolue à la fin (terminal `done`) ou à l'échec, avec le texte complet. */
export interface FimStream {
  /** `"fim:<rawId>"` — le backend impose ce préfixe ; à repasser tel quel à
   *  `chat_abort` (param `conversationId`, la clé du registry partagé). */
  requestId: string;
  done: Promise<FimResult>;
}

/**
 * Démarre un flux FIM. `onText` reçoit le texte ACCUMULÉ+nettoyé à chaque chunk
 * (pas le delta brut), pour un affichage incrémental du ghost text. `rawId` doit
 * être unique par requête ; le backend le préfixe par `fim:` et les events
 * `fim://delta` portent cet id préfixé (champ `requestId`, camelCase).
 *
 * Le listener est attaché AVANT l'invoke (sinon on raterait des tokens) et
 * détaché sur toute sortie (succès/abort/erreur).
 */
export function startFimCompletionStream(
  doc: string,
  cursor: number,
  rawId: string,
  onText: (text: string) => void,
  shouldProceed?: () => boolean,
): FimStream {
  const requestId = `fim:${rawId}`;
  const done = (async (): Promise<FimResult> => {
    const t = await resolveFimTarget();
    if (t.kind === "error") return { ok: false, error: t.error };
    const { prompt, suffix } = buildFimRequest(doc, cursor, t.protocol, t.model);

    let acc = "";
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{
        requestId?: string;
        chunk: string;
        kind: string;
        done: boolean;
      }>("fim://delta", (p) => {
        // Filtre STRICT par id : le registry FIM est partagé, un event d'un
        // autre flux (ou le terminal d'un flux annulé) ne doit pas s'afficher.
        if (p.requestId !== requestId) return;
        if (p.kind === "content" && p.chunk) {
          acc += p.chunk;
          onText(sanitizeCompletion(acc));
        }
        // `done:true` (chunk vide) → fin : géré par la résolution de l'invoke.
      });

      // Garde anti-fenêtre : `chat_abort` est inerte tant que le backend n'a pas
      // enregistré le flag (ce qui n'arrive que DANS `fim_complete_stream`). Si
      // une frappe a déjà supplanté cette requête pendant la résolution provider
      // + l'attache du listener, on NE lance PAS le backend (zéro token gâché).
      if (shouldProceed && !shouldProceed()) {
        return { ok: false, error: "superseded" };
      }

      const full = await invoke<string>("fim_complete_stream", {
        requestId: rawId,
        prompt,
        model: t.model,
        protocol: t.protocol,
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        maxTokens: 128,
        stop: ["\n\n"],
        suffix,
      });
      return { ok: true, text: sanitizeCompletion(full) };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      unlisten?.();
    }
  })();

  return { requestId, done };
}
