// Image-provider registry and resolver.
// Data-only — no React. Used by ImageView to build the full IPC payload.
// Parallel structure to providers.ts (chat providers) — kept separate by design.

export type ImageProtocol = "comfyui" | "replicate" | "stability" | "openai" | "minimax" | "custom";

export interface ImageProviderDescriptor {
  protocol: ImageProtocol;
  baseUrl: string;
}

export interface ImageModelPreset {
  id: string;
  label: string;
  meta: string;
  provider: string;
}

export const IMAGE_PROVIDER_REGISTRY: Record<string, ImageProviderDescriptor> = {
  // Local / keyless
  comfyui:           { protocol: "comfyui",   baseUrl: "http://127.0.0.1:8188" },
  // Named local models — resolve to the local ComfyUI daemon
  "v1-5-pruned-emaonly.safetensors": { protocol: "comfyui", baseUrl: "http://127.0.0.1:8188" },
  // Remote / keyed
  replicate:         { protocol: "replicate", baseUrl: "https://api.replicate.com" },
  stability:         { protocol: "stability", baseUrl: "https://api.stability.ai" },
  openai:            { protocol: "openai",    baseUrl: "https://api.openai.com" },
  minimax:           { protocol: "minimax",   baseUrl: "https://api.minimax.io" },
  custom:            { protocol: "custom",    baseUrl: "" },
};

export const IMAGE_MODEL_PRESETS: ImageModelPreset[] = [
  {
    id: "comfyui/v1-5-pruned-emaonly.safetensors",
    label: "ComfyUI local",
    meta: "Workflow local · seed/steps/cfg",
    provider: "Local",
  },
  {
    id: "openai/gpt-image-2",
    label: "GPT Image 2",
    meta: "Haute fidelite · generation/edition",
    provider: "OpenAI",
  },
  {
    id: "openai/gpt-image-1.5",
    label: "GPT Image 1.5",
    meta: "Qualite stable · cout maitrise",
    provider: "OpenAI",
  },
  {
    id: "minimax/image-01",
    label: "MiniMax Image-01",
    meta: "T2I/I2I · references sujet",
    provider: "MiniMax",
  },
  {
    id: "stability/stable-diffusion-xl-1024-v1-0",
    label: "SDXL",
    meta: "Stability · base64 local",
    provider: "Stability",
  },
];

const COMFYUI_DEFAULT_BASE_URL = "http://127.0.0.1:8188";
const _warnedPrefixes = new Set<string>();

export interface ResolvedImageProvider {
  providerId: string;
  protocol: ImageProtocol;
  baseUrl: string;
  model: string;
}

/**
 * Resolves a model id like "replicate/flux-1.1-pro" or a bare name like
 * "v1-5-pruned-emaonly.safetensors" into the routed payload needed by the
 * `image_generate` Tauri command.
 *
 * Resolution order:
 *   1. If the id contains "/" — split into prefix + model, look up prefix.
 *   2. Unknown prefixes become custom providers, resolved from Connections.
 *   3. Otherwise look up the bare name (catches named local models).
 *   4. Bare-name fallback: comfyui local daemon, model id passed through unchanged.
 */
export function resolveImageProvider(modelId: string): ResolvedImageProvider {
  const slash = modelId.indexOf("/");

  if (slash !== -1) {
    const prefix = modelId.slice(0, slash);
    const model  = modelId.slice(slash + 1);
    const entry  = IMAGE_PROVIDER_REGISTRY[prefix];
    if (entry) {
      return { providerId: prefix, protocol: entry.protocol, baseUrl: entry.baseUrl, model };
    }
    if (!_warnedPrefixes.has(prefix)) {
      console.warn(`[imageProviders] unknown prefix "${prefix}" — treating as custom image provider.`);
      _warnedPrefixes.add(prefix);
    }
    return { providerId: prefix, protocol: "custom", baseUrl: "", model };
  }

  const entry = IMAGE_PROVIDER_REGISTRY[modelId];
  if (entry) {
    return { providerId: entry.protocol, protocol: entry.protocol, baseUrl: entry.baseUrl, model: modelId };
  }

  if (!_warnedPrefixes.has(modelId)) {
    console.warn(`[imageProviders] unknown model id "${modelId}" — falling back to comfyui.`);
    _warnedPrefixes.add(modelId);
  }
  return { providerId: "comfyui", protocol: "comfyui", baseUrl: COMFYUI_DEFAULT_BASE_URL, model: modelId };
}
