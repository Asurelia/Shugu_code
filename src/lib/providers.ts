// Provider registry and resolver.
// Data-only — no React. Used by ChatView to build the full IPC payload.

export type Protocol = "anthropic" | "openai" | "ollama" | "custom";

export interface ProviderDescriptor {
  protocol: Protocol;
  baseUrl: string;
}

export const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  openai:    { protocol: "openai",    baseUrl: "https://api.openai.com" },
  ollama:    { protocol: "ollama",    baseUrl: "http://localhost:11434" },
  mistral:   { protocol: "openai",    baseUrl: "https://api.mistral.ai" },
  groq:      { protocol: "openai",    baseUrl: "https://api.groq.com/openai" },
};

const _warnedPrefixes = new Set<string>();

export function resolveProvider(modelId: string): {
  protocol: Protocol;
  baseUrl: string;
  model: string;
} {
  const slash = modelId.indexOf("/");

  if (slash === -1) {
    if (!_warnedPrefixes.has(modelId)) {
      console.warn(`[providers] unknown model id "${modelId}" — no "/" separator. Treating as custom.`);
      _warnedPrefixes.add(modelId);
    }
    return { protocol: "custom", baseUrl: "", model: modelId };
  }

  const prefix = modelId.slice(0, slash);
  const model  = modelId.slice(slash + 1);
  const entry  = PROVIDER_REGISTRY[prefix];

  if (!entry) {
    if (!_warnedPrefixes.has(prefix)) {
      console.warn(`[providers] unknown prefix "${prefix}" in model id "${modelId}". Treating as custom.`);
      _warnedPrefixes.add(prefix);
    }
    return { protocol: "custom", baseUrl: "", model };
  }

  return { protocol: entry.protocol, baseUrl: entry.baseUrl, model };
}
