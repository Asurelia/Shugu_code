// Provider registry and resolver.
// Data-only — no React. Used by ChatView to build the full IPC payload.
//
// Adding a new provider here is sufficient to let it appear in the model
// picker AND be routed by the Rust `chat_send` dispatcher, as long as the
// `protocol` matches one of the four arms it handles
// (anthropic / openai / ollama / custom). For user-defined "custom-*" ids
// the prefix is not in this registry and the chat layer falls back to
// values stored under `provider.<id>.protocol` / `.baseUrl` in the
// SQLite settings table.

export type Protocol = "anthropic" | "openai" | "ollama" | "custom";

export interface ProviderDescriptor {
  protocol: Protocol;
  baseUrl: string;
}

export const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  openai:    { protocol: "openai",    baseUrl: "https://api.openai.com" },
  ollama:    { protocol: "ollama",    baseUrl: "http://localhost:11434" },
  // llama.cpp's `llama-server` exposes an OpenAI-compatible /v1/chat/completions
  // endpoint, so we reuse the openai protocol here and only differ on the
  // baseUrl default. The user is expected to start the server with a flag
  // like `--host 127.0.0.1 --port 8080` (or whatever port they prefer; the
  // override goes through the Settings → Connections card).
  llamacpp:  { protocol: "openai",    baseUrl: "http://localhost:8080" },
  mistral:   { protocol: "openai",    baseUrl: "https://api.mistral.ai" },
  groq:      { protocol: "openai",    baseUrl: "https://api.groq.com/openai" },
};

const _warnedPrefixes = new Set<string>();

/**
 * Decompose a model id like `"anthropic/claude-haiku-4-5"` into the bits
 * the chat dispatcher needs:
 *   - providerId : the prefix BEFORE the slash (stable across renames of
 *                  the display label) — also the namespace under which the
 *                  credentials backend stores the apiKey + baseUrl override.
 *   - protocol   : how to talk to the endpoint (anthropic SSE, OpenAI SSE,
 *                  Ollama NDJSON, or "custom" for user-defined).
 *   - baseUrl    : the registry default. Caller may override at runtime
 *                  from the persisted provider config.
 *   - model      : the bit AFTER the slash, passed verbatim to the API.
 *
 * Unknown prefixes are treated as `custom` with empty baseUrl; the chat
 * layer is expected to fill in the gaps from per-provider stored config.
 */
export function resolveProvider(modelId: string): {
  providerId: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
} {
  const slash = modelId.indexOf("/");

  if (slash === -1) {
    if (!_warnedPrefixes.has(modelId)) {
      console.warn("[providers] unknown model id, no '/' separator", { modelId });
      _warnedPrefixes.add(modelId);
    }
    return { providerId: modelId, protocol: "custom", baseUrl: "", model: modelId };
  }

  const prefix = modelId.slice(0, slash);
  const model  = modelId.slice(slash + 1);
  const entry  = PROVIDER_REGISTRY[prefix];

  if (!entry) {
    if (!_warnedPrefixes.has(prefix)) {
      console.warn("[providers] unknown prefix in model id", { prefix, modelId });
      _warnedPrefixes.add(prefix);
    }
    return { providerId: prefix, protocol: "custom", baseUrl: "", model };
  }

  return { providerId: prefix, protocol: entry.protocol, baseUrl: entry.baseUrl, model };
}

// ─── Model catalog ─────────────────────────────────────────────
// Single source of truth for the list of LLM models the UI can offer.
//
// Used by:
//   - lib/tauri.ts (web/dev mock of the `models_list` Tauri command)
//   - any future ModelPicker that wants to render grouped dropdowns
//
// Kept in sync MANUALLY with src-tauri/src/commands/models.rs (Rust returns
// a subset that powers the in-Tauri `models_list` invoke). When adding a
// model here, also add it to models.rs if it should be reachable from the
// real Tauri command — otherwise the model only shows in the web/dev mock.
// (TS ↔ Rust sharing without a JSON build step is not worth the friction
// while the list is < 20 entries.)

export type ModelGroup = "Anthropic" | "OpenAI" | "Local" | "Other";

export interface ModelDescriptor {
  /** "{provider-prefix}/{model-name}" — prefix MUST match PROVIDER_REGISTRY. */
  id: string;
  /** Short label for dropdowns. */
  label: string;
  group: ModelGroup;
  /** Free-form tag shown next to the label ("fast · default", "local · 32B", …). */
  meta: string;
}

export const MODEL_CATALOG: ModelDescriptor[] = [
  // Anthropic
  { id: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5", group: "Anthropic", meta: "fast · default" },
  { id: "anthropic/claude-sonnet-5",  label: "claude-sonnet-5",  group: "Anthropic", meta: "balanced · 200k" },
  // OpenAI
  { id: "openai/gpt-4o-mini",         label: "gpt-4o-mini",      group: "OpenAI",    meta: "cheap" },
  // Local (Ollama; llamacpp models discovered dynamically via the running server)
  { id: "ollama/qwen2.5:32b",         label: "qwen2.5:32b",      group: "Local",     meta: "local · 32B" },
];

/** Models grouped for display in dropdowns. Empty groups are dropped. */
export function groupedModels(): { group: ModelGroup; items: ModelDescriptor[] }[] {
  const order: ModelGroup[] = ["Anthropic", "OpenAI", "Local", "Other"];
  return order
    .map((group) => ({ group, items: MODEL_CATALOG.filter((m) => m.group === group) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Returns the catalog shaped for the web/dev mock of the `models_list`
 * Tauri command. Protocol is derived from PROVIDER_REGISTRY — the `!`
 * assertion will throw at mock-time if a catalog entry references a prefix
 * not declared in the registry, which is the invariant we want.
 */
export function mockModelsList(): { id: string; label: string; protocol: Protocol }[] {
  return MODEL_CATALOG.map((m) => {
    const prefix = m.id.slice(0, m.id.indexOf("/"));
    return { id: m.id, label: m.label, protocol: PROVIDER_REGISTRY[prefix]!.protocol };
  });
}
