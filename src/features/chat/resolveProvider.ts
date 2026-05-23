// Shugu Forge — résolution du provider du chat actif (partagée).
//
// Extrait de `useAICommit` (LOT 2 git) pour être réutilisé par les features
// AI "one-shot" qui appellent `chat_send` HORS du flux chat principal
// (AI commit message, AI code review). Reproduit à l'identique le schéma de
// résolution de `sendChatMessage` : modelId UI → provider → protocol /
// baseUrl / apiKey effectifs, en tenant compte du protocole stocké pour les
// providers "custom".

import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";

export interface ResolvedChatProvider {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string | undefined;
  /** Identifiant de modèle réel à passer à `chat_send` (sans préfixe provider). */
  model: string;
}

/**
 * Résout le provider actif à partir d'un `modelId` UI (`"provider/model"` ou
 * nu — auquel cas on préfixe `anthropic/`).
 *
 * Retourne `null` si le provider résolu n'est PAS activé : l'appelant doit
 * alors signaler l'absence de provider (ex. "no LLM provider configured").
 */
export async function resolveActiveChatProvider(
  modelId: string | null | undefined,
): Promise<ResolvedChatProvider | null> {
  const fullId = modelId?.includes("/") ? modelId : `anthropic/${modelId ?? "claude-haiku-4-5"}`;
  const {
    providerId,
    protocol: defaultProtocol,
    baseUrl: defaultBaseUrl,
    model,
  } = resolveProvider(fullId);

  const enabled = await getProviderEnabled(providerId);
  if (enabled !== "true") return null;

  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defaultProtocol;
  if (defaultProtocol === "custom") {
    const stored = await getConfig(providerId, "protocol");
    if (stored === "anthropic" || stored === "openai" || stored === "ollama" || stored === "custom") {
      protocol = stored;
    }
  }
  const baseUrl: string = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defaultBaseUrl;
  const apiKey: string | undefined = cfg.apiKey && cfg.apiKey !== "" ? cfg.apiKey : undefined;

  return { protocol, baseUrl, apiKey, model };
}
