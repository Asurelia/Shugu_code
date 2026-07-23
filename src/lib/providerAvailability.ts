import type { Protocol } from "@/lib/providers";

export interface ProviderAvailability {
  ready: boolean;
  reason?: string;
}

export function isLocalProviderEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(
    baseUrl.trim(),
  );
}

/**
 * Validate the minimum credentials needed before starting a long agent run.
 * This is deliberately stricter than a saved `enabled=true` flag: a provider
 * can remain enabled after its key was removed from the OS keychain.
 */
export function providerAvailability(
  protocol: Protocol,
  baseUrl: string,
  apiKey?: string | null,
): ProviderAvailability {
  if (protocol === "codex") return { ready: true };
  if (protocol === "ollama") {
    return baseUrl.trim()
      ? { ready: true }
      : { ready: false, reason: "endpoint manquant" };
  }
  if (protocol === "custom") {
    return baseUrl.trim()
      ? { ready: true }
      : { ready: false, reason: "endpoint manquant" };
  }
  if (protocol === "openai" && isLocalProviderEndpoint(baseUrl)) {
    return { ready: true };
  }
  if (apiKey?.trim()) return { ready: true };
  return { ready: false, reason: "clé API absente du coffre système" };
}
