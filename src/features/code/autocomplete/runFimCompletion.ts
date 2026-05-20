// Shugu Forge — Lot 5 (scaffold) — requête de complétion FIM (frontend).
//
// Assemble le prompt FIM depuis le doc + curseur et appelle la commande Rust
// `fim_complete` (POST /v1/completions non-streaming). Retourne la complétion
// nettoyée, prête à afficher en ghost text.
//
// ⚠ ACTIVATION RUNTIME : ce module est le tuyau. Le DÉCLENCHEMENT live (un hook
// qui debounce sur la frappe → appelle runFimCompletion → showGhost) n'est PAS
// monté par défaut dans l'éditeur, pour ne pas spammer un endpoint non
// configuré. Pour activer : câbler un updateListener (debounce ~300ms,
// shouldRequestCompletion, RequestSequencer) dans CodeMirrorEditor + brancher
// ghostTextExtension(), avec un modèle FIM openai-compatible configuré. La
// QUALITÉ/LATENCE se règle alors en runtime (modèle, fenêtre, max_tokens).

import { invoke } from "@/lib/tauri";
import { resolveChatTarget, getActiveModel } from "@/features/chat/chat-sync";
import { detectFimFamily, buildFimPrompt, fimWindow } from "./fimPrompt";
import { sanitizeCompletion } from "./autocompleteState";

export interface FimResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Demande une complétion FIM pour le curseur `cursor` dans `doc`. Résout le
 * provider actif, vérifie qu'il est openai-compatible (seul protocole FIM
 * supporté), construit le prompt selon la famille du modèle, appelle
 * `fim_complete`, et nettoie le résultat.
 */
export async function runFimCompletion(doc: string, cursor: number): Promise<FimResult> {
  const resolved = await resolveChatTarget(getActiveModel());
  if (!resolved.ok) {
    return { ok: false, error: "Provider non configuré pour l'autocomplete." };
  }
  const { protocol, baseUrl, apiKey, model } = resolved.target;
  if (protocol !== "openai" && protocol !== "custom") {
    return {
      ok: false,
      error: `FIM nécessite un endpoint openai-compatible (protocole actuel : ${protocol}).`,
    };
  }

  const parts = fimWindow(doc, cursor);
  const prompt = buildFimPrompt(parts, detectFimFamily(model));

  try {
    const raw = await invoke<string>("fim_complete", {
      prompt,
      model,
      protocol,
      baseUrl,
      apiKey,
      maxTokens: 128,
      // Stop tôt : une suggestion inline ne doit pas dévaler le fichier.
      stop: ["\n\n"],
    });
    return { ok: true, text: sanitizeCompletion(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
