// Image-provider registry and resolver.
// Data-only — no React. Used by ImageView to build the full IPC payload.
// Parallel structure to providers.ts (chat providers) — kept separate by design.

export type ImageProtocol = "comfyui" | "replicate" | "stability" | "openai" | "custom";

export interface ImageProviderDescriptor {
  protocol: ImageProtocol;
  baseUrl: string;
}

export const IMAGE_PROVIDER_REGISTRY: Record<string, ImageProviderDescriptor> = {
  // Local / keyless
  comfyui:           { protocol: "comfyui",   baseUrl: "http://127.0.0.1:8188" },
  // Named local models — resolve to the local ComfyUI daemon
  "flux.1-veil":     { protocol: "comfyui",   baseUrl: "http://127.0.0.1:8188" },
  "sdxl-celestial":  { protocol: "comfyui",   baseUrl: "http://127.0.0.1:8188" },
  "shugu-lcm-fast":  { protocol: "comfyui",   baseUrl: "http://127.0.0.1:8188" },
  // Remote / keyed
  replicate:         { protocol: "replicate", baseUrl: "https://api.replicate.com" },
  stability:         { protocol: "stability", baseUrl: "https://api.stability.ai" },
  openai:            { protocol: "openai",    baseUrl: "https://api.openai.com" },
};

const _warnedPrefixes = new Set<string>();

/**
 * Resolves a model id like "replicate/flux-1.1-pro" or a bare name like
 * "flux.1-veil" into the { protocol, baseUrl, model } triple needed by
 * the `image_generate` Tauri command.
 *
 * Resolution order:
 *   1. If the id contains "/" — split into prefix + model, look up prefix.
 *   2. Otherwise look up the bare name (catches named local models).
 *   3. Fallback: comfyui local daemon, model id passed through unchanged.
 */
export function resolveImageProvider(modelId: string): {
  protocol: ImageProtocol;
  baseUrl: string;
  model: string;
} {
  const slash = modelId.indexOf("/");

  if (slash !== -1) {
    const prefix = modelId.slice(0, slash);
    const model  = modelId.slice(slash + 1);
    const entry  = IMAGE_PROVIDER_REGISTRY[prefix];
    if (entry) {
      return { protocol: entry.protocol, baseUrl: entry.baseUrl, model };
    }
    if (!_warnedPrefixes.has(prefix)) {
      console.warn(`[imageProviders] unknown prefix "${prefix}" — falling back to comfyui.`);
      _warnedPrefixes.add(prefix);
    }
    return { protocol: "comfyui", baseUrl: "http://127.0.0.1:8188", model };
  }

  const entry = IMAGE_PROVIDER_REGISTRY[modelId];
  if (entry) {
    return { protocol: entry.protocol, baseUrl: entry.baseUrl, model: modelId };
  }

  if (!_warnedPrefixes.has(modelId)) {
    console.warn(`[imageProviders] unknown model id "${modelId}" — falling back to comfyui.`);
    _warnedPrefixes.add(modelId);
  }
  return { protocol: "comfyui", baseUrl: "http://127.0.0.1:8188", model: modelId };
}
