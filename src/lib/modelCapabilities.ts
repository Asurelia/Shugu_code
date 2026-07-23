// Shugu Forge — accès UI aux capacités modèle.
//
// SOURCE DE VÉRITÉ = Rust (`commands::model_capabilities`). Ce module n'est
// qu'un MIROIR D'AFFICHAGE : il appelle la commande Tauri `model_capabilities`
// et met le résultat en cache. AUCUNE heuristique dupliquée ici — l'enforcement
// (gating outils / contexte) vit côté Rust, où le modèle est toujours présent.
// Le front ne s'en sert que pour les badges du sélecteur de modèle.

import { useEffect, useState } from "react";
import { invoke } from "@/lib/tauri";
import { resolveProvider } from "@/lib/providers";

/** Miroir exact de `ModelCapabilities` (serde camelCase). */
export interface ModelCapabilities {
  tier: "strong" | "small";
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsMcp: boolean;
  supportsEffort: boolean;
  agentLoop: "native" | "compatible" | "chatOnly";
  contextWindow: number;
  recommendedToolset: "full" | "reduced";
}

// Le résultat est déterministe pour un (protocol, model) donné → cache mémoire
// process-wide, jamais invalidé.
const cache = new Map<string, ModelCapabilities>();

/** Capacités d'un (protocol, model). Résout via la commande Rust + cache. */
export async function modelCapabilities(
  protocol: string,
  model: string,
): Promise<ModelCapabilities> {
  const key = `${protocol}::${model}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const caps = await invoke<ModelCapabilities>("model_capabilities", { protocol, model });
  cache.set(key, caps);
  return caps;
}

/**
 * Hook : capacités d'un id de modèle complet (`"provider/model"`). Décompose via
 * `resolveProvider` pour obtenir le protocole attendu par la commande Rust.
 * Retourne `null` tant que non résolu (ou si l'invoke échoue, ex. mock web/dev).
 */
export function useModelCapabilities(modelId: string | null): ModelCapabilities | null {
  const initial = (() => {
    if (!modelId) return null;
    const { protocol, model } = resolveProvider(modelId);
    return cache.get(`${protocol}::${model}`) ?? null;
  })();
  const [caps, setCaps] = useState<ModelCapabilities | null>(initial);

  useEffect(() => {
    if (!modelId) {
      setCaps(null);
      return;
    }
    const { protocol, model } = resolveProvider(modelId);
    let cancelled = false;
    void modelCapabilities(protocol, model)
      .then((c) => {
        if (!cancelled) setCaps(c);
      })
      .catch(() => {
        // Tauri indisponible (mock web/dev) ou erreur — pas de badge, silencieux.
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  return caps;
}
