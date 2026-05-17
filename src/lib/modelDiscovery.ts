// Shugu Forge — runtime model discovery.
//
// For every provider that the user has CONFIGURED (api key, baseUrl override,
// or both — depending on the protocol), this module queries the provider's
// "list models" endpoint and returns a flat list of what is ACTUALLY
// available. No more hardcoded display lists pretending Claude/GPT/Mistral
// exist when the user has never set a key for them.
//
// Endpoints by protocol (all dispatched by the Rust-side `models_discover_external`):
//   anthropic  → GET /v1/models       (header `x-api-key`)
//   openai     → GET /v1/models       (header `Authorization: Bearer …`)
//   ollama     → GET /api/tags        (no key)
//   custom     → falls through to its stored protocol; if openai-compat,
//                same as above with whatever endpoint the user gave.
//
// Connection criteria (a provider is "connected" if):
//   - protocol ollama: has a baseUrl (defaults are fine for localhost)
//   - protocol anthropic/openai: has an apiKey
//   - protocol custom: has a baseUrl (key optional)
//
// CORS: discovery used to call `fetch(url)` directly from the webview, which
// IS subject to CORS even inside Tauri (the "Tauri webview ⇒ no CORS" claim
// in the legacy comment was wrong — Anthropic/OpenAI happened to ship
// `Access-Control-Allow-Origin: *` so it survived; OpenCode Go doesn't, which
// surfaced as `TypeError: Failed to fetch`). Now the probe runs through the
// Rust `models_discover_external` command (reqwest, no browser sandbox),
// which also gives us real HTTP status + body excerpts on failure.

import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { PROVIDER_REGISTRY, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { db } from "@/lib/db";
import { getInstalledIds as getBundleInstalledIds } from "@/lib/modelBundle";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

// ─── Cross-window cache (Zustand persist + Tauri event) ───────────────
//
// Each open WebviewWindow (main IDE, mascot/chibi, future popouts) used to
// run its own discovery cycle on mount — n parallel HTTP roundtrips for the
// same data. Now they share a single result via:
//
//   1. localStorage-backed Zustand store. Both windows read the same origin
//      so the cache survives a single-window reload AND is visible across
//      windows on app start.
//   2. A Tauri custom event `discovery://invalidated`. Carries either the
//      fresh result (so other windows adopt it without re-fetching) or an
//      `{invalidate:true}` signal (so other windows re-discover after a
//      key save / disconnect).
//
// TTL is short because the typical reason for re-fetch is a fresh model
// download in Ollama / llama.cpp; a stale-by-an-hour entry is more annoying
// than the cost of re-running discovery once a minute.

const DISCOVERY_EVENT  = "discovery://invalidated";
const DISCOVERY_TTL_MS = 60_000;

// Per-window-session flag. The persisted cache survives app close, so a
// quick relaunch within the TTL would otherwise leave a stale picture (e.g.
// llama-server killed between sessions but the picker still shows its
// models). This flag flips to true on the first useDiscoveredModels mount
// in this window and triggers a fresh discovery regardless of TTL. It's
// module-scope (not a Zustand field) so the value doesn't persist across
// page loads — every fresh window context starts with false.
let sessionDiscoveryDone = false;

// ─── TanStack-backed discovery state ──────────────────────────────────
//
// Refactor 2026-05-17 : Zustand store + persist middleware → état stocké
// dans le QueryClient (queryKey = DISCOVERY_KEY). La persistance se fait
// automatiquement via le PersistQueryClientProvider configuré dans main.tsx
// (localStorage backend). Plus de Zustand, plus de double-source-of-truth.

interface DiscoveryState {
  models: DiscoveredModel[];
  errors: Record<string, string>;
  unconfigured: string[];
  /** Unix-ms timestamp of the last successful discovery. 0 = never. */
  lastFetched: number;
  /** True while a discovery is in flight. */
  isLoading: boolean;
}

const DISCOVERY_KEY = ["discovery", "result"] as const;

const INITIAL_DISCOVERY: DiscoveryState = {
  models: [],
  errors: {},
  unconfigured: [],
  lastFetched: 0,
  isLoading: false,
};

function getDiscoveryState(): DiscoveryState {
  return queryClient.getQueryData<DiscoveryState>(DISCOVERY_KEY) ?? INITIAL_DISCOVERY;
}

function setDiscoveryState(updater: (s: DiscoveryState) => DiscoveryState): void {
  queryClient.setQueryData<DiscoveryState>(DISCOVERY_KEY, (prev) =>
    updater(prev ?? INITIAL_DISCOVERY),
  );
}

/** Apply a fresh discovery result + clear isLoading. */
function applyDiscoveryResult(r: DiscoveryResult): void {
  setDiscoveryState((s) => ({
    ...s,
    models: r.models,
    errors: r.errors,
    unconfigured: r.unconfigured,
    lastFetched: Date.now(),
    isLoading: false,
  }));
}

/** Mark a discovery as in-flight (or done). */
function setDiscoveryLoading(b: boolean): void {
  setDiscoveryState((s) => ({ ...s, isLoading: b }));
}

/**
 * Backwards-compatible facade for old call sites that used the Zustand
 * `useDiscoveryStore.getState()` API. Reads pass through to the TanStack
 * cache; writes go through the helpers above. Kept to avoid changing
 * Connections.tsx + every consumer in one go.
 */
export const useDiscoveryStore = {
  getState: () => ({
    ...getDiscoveryState(),
    applyResult: applyDiscoveryResult,
    setLoading: setDiscoveryLoading,
    invalidate: () => setDiscoveryState((s) => ({ ...s, lastFetched: 0 })),
  }),
} as const;

/**
 * Run a discovery NOW, write the result to the shared store, and broadcast
 * it to every other open WebviewWindow so they adopt the same result without
 * re-fetching themselves. Module-scope (not a hook) so it can be called from
 * anywhere — ConnCard save / disconnect handlers, AddProviderModal, future
 * deep-link flows.
 *
 * Reentry guard: if a discovery is already in flight in this window, we
 * skip. The in-flight one will publish its result and other observers
 * (including the caller's React tree) will see it.
 */
export async function refreshDiscovery(): Promise<void> {
  if (getDiscoveryState().isLoading) return;
  setDiscoveryLoading(true);
  let r: DiscoveryResult;
  try {
    r = await discoverAllModels();
  } catch (err) {
    r = { models: [], errors: { __global: String(err) }, unconfigured: [] };
  }
  // Apply to local TanStack cache first — observers in THIS window
  // re-render via useQuery subscription.
  applyDiscoveryResult(r);
  try {
    const mod = await import("@tauri-apps/api/event");
    // Broadcast the result so other windows adopt without re-fetching.
    await mod.emit(DISCOVERY_EVENT, { result: r });
  } catch (err) {
    console.warn("[modelDiscovery] emit result failed", err);
  }
}

/**
 * Backwards-compatible alias kept so existing call sites (ConnCard's onSave /
 * onDisconnect, AddProviderModal.submit) don't change. The previous
 * implementation only emitted an "invalidate" signal which other windows
 * acted on lazily; this implementation actually runs the discovery and
 * pushes the result, which is what callers always meant.
 */
export const invalidateDiscovery = refreshDiscovery;

export interface DiscoveredModel {
  /** Full id used by the chat layer — `<providerId>/<modelId>`. */
  id: string;
  providerId: string;
  /** Display name of the provider (e.g. "Anthropic", "llama.cpp"). */
  providerLabel: string;
  /** Model id as returned by the provider. */
  modelId: string;
  /** Optional human-friendly label. */
  label: string;
}

export interface DiscoveryResult {
  /** Successfully-discovered models from connected providers. */
  models: DiscoveredModel[];
  /** Per-provider error message, when the fetch failed (e.g. wrong key, server down). */
  errors: Record<string, string>;
  /** Providers that aren't configured yet — useful for an "add a provider" CTA. */
  unconfigured: string[];
}

// Display labels for the built-in providers. Kept in sync with the cards in
// ConnectionsView so the picker matches what the user sees in Settings.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai:    "OpenAI",
  ollama:    "Ollama",
  llamacpp:  "llama.cpp",
  mistral:   "Mistral",
  groq:      "Groq",
};

// ─── Per-protocol probe (delegated to Rust) ───────────────────────────
//
// One thin TS shim that hands off to the Rust `models_discover_external`
// command — Rust handles protocol routing, headers, the `/v1` smart
// bascule, JSON shape parsing, and surfaces real HTTP errors with body
// excerpts. We just translate the high-level "this provider, this
// protocol, this URL, this key" into one IPC call.

async function probeProviderModels(
  protocol: Protocol,
  baseUrl: string,
  apiKey: string | null,
): Promise<string[]> {
  // The Rust side mirrors chat.rs's dispatcher exactly — `anthropic`,
  // `openai`, `ollama`, `custom`. Pass the user-stored protocol through
  // verbatim so a `custom` openai-compat ends up on the right arm.
  return await invoke<string[]>("models_discover_external", {
    protocol,
    baseUrl,
    apiKey: apiKey ?? null,
  });
}

// ─── Provider config resolution ───────────────────────────────────────

interface ResolvedProviderConfig {
  providerId: string;
  providerLabel: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string | null;
  /** True if the user has configured *enough* to attempt a discovery call. */
  connected: boolean;
}

function isProtocol(s: string | null): s is Protocol {
  return s === "anthropic" || s === "openai" || s === "ollama" || s === "custom";
}

async function resolveProviderForDiscovery(providerId: string, customLabel?: string): Promise<ResolvedProviderConfig> {
  const cfg = await loadProviderConfig(providerId);
  const reg = PROVIDER_REGISTRY[providerId];

  let protocol: Protocol;
  let baseUrl: string;
  let label: string;
  if (reg) {
    protocol = reg.protocol;
    baseUrl = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : reg.baseUrl;
    label = PROVIDER_LABELS[providerId] ?? providerId;
  } else {
    const storedProto = await getConfig(providerId, "protocol");
    protocol = isProtocol(storedProto) ? storedProto : "custom";
    baseUrl = cfg.baseUrl ?? "";
    label = customLabel ?? providerId;
  }

  // What counts as "connected enough to discover" depends on the protocol.
  // For Ollama we only need a baseUrl (default localhost works). For
  // openai-compat with a localhost endpoint (llama.cpp, LM Studio, etc.)
  // a baseUrl also suffices — many local servers don't require a key.
  // For anthropic and remote openai endpoints, we need a key.
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$|\/)/i.test(baseUrl);
  let connected = false;
  if (protocol === "ollama") {
    connected = !!baseUrl;
  } else if (protocol === "anthropic") {
    connected = !!cfg.apiKey;
  } else {
    // openai or custom (openai-compat): key OR local endpoint
    connected = !!cfg.apiKey || isLocalEndpoint;
  }

  return { providerId, providerLabel: label, protocol, baseUrl, apiKey: cfg.apiKey, connected };
}

// ─── Top-level discovery ──────────────────────────────────────────────

export async function discoverAllModels(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { models: [], errors: {}, unconfigured: [] };

  // Built-in providers from the static registry…
  const builtInIds = Object.keys(PROVIDER_REGISTRY);

  // Zero-config affordance: if the user has the bundled Qwen GGUF
  // installed (Phase 2 onboarding), treat `llamacpp` as implicitly
  // enabled even when they've never clicked Save in Settings →
  // Connections. The local server is auto-started at boot by
  // `llama_autostart` in Rust, so requiring an explicit enable here
  // would be busywork that defeats the "zero-config" promise.
  //
  // IMPORTANT: this used to call `getStatus()` which hashes a 1+ GB
  // GGUF (~3-5 s of synchronous IO per call). Discovery fires on every
  // window mount + every save/disconnect, so the hash was stalling the
  // webview every boot and on every Connections action — surfacing as
  // the "Not Responding" Windows freeze. `getInstalledIds()` only stats
  // the file (microseconds) and returns the same answer the boolean
  // below needs.
  let bundleAutoEnable = false;
  try {
    const installedIds = await getBundleInstalledIds();
    bundleAutoEnable = installedIds.length > 0;
  } catch {
    // Tauri command unavailable (boot race) — fine.
  }

  // …plus any user-added custom providers persisted by AddProviderModal.
  const customsRaw = await db.settings.get("connections.customProviders.v1");
  let customs: Array<{ id: string; name: string }> = [];
  if (customsRaw) {
    try {
      const parsed = JSON.parse(customsRaw);
      if (Array.isArray(parsed)) customs = parsed as Array<{ id: string; name: string }>;
    } catch {
      // Malformed JSON — ignore. The Connections page will show no custom
      // providers either, signaling the corruption.
    }
  }

  const all: Array<{ id: string; customLabel?: string }> = [
    ...builtInIds.map((id) => ({ id })),
    ...customs.map((c) => ({ id: c.id, customLabel: c.name })),
  ];

  await Promise.all(all.map(async ({ id, customLabel }) => {
    // STRICT MODE — a provider must be EXPLICITLY enabled by the user to be
    // queried. Three states for `enabled`:
    //   - "true"  → user clicked Save in Settings → Connections (usable)
    //   - "false" → user clicked Disconnect (hidden)
    //   - null    → never interacted (unconfigured; shown as a "to configure"
    //              hint, not auto-probed). Previously we auto-probed local
    //              endpoints in this case, which led to the confusing
    //              "DISCONNECTED in Settings but model still in picker"
    //              state that surprised the user.
    const enabled = await getProviderEnabled(id);
    if (enabled === "false") {
      // Explicitly disabled — hide entirely.
      return;
    }
    // Auto-enable llamacpp when the bundle is on disk, EVEN if the user
    // never visited Connections. The local server is alive (auto-started
    // at boot), the chat picker should see it without ceremony.
    const autoEnabled = id === "llamacpp" && bundleAutoEnable;
    if (enabled !== "true" && !autoEnabled) {
      // Never touched — surface as unconfigured (drives the "Non configurés"
      // hint in the picker without firing any HTTP roundtrips).
      result.unconfigured.push(id);
      return;
    }

    let cfg: ResolvedProviderConfig;
    try {
      cfg = await resolveProviderForDiscovery(id, customLabel);
    } catch (err) {
      result.errors[id] = `resolve config: ${String(err)}`;
      return;
    }

    if (!cfg.connected) {
      result.unconfigured.push(id);
      return;
    }

    try {
      // Built-in Anthropic doesn't carry a baseUrl in its stored config (the
      // registry default lives in PROVIDER_REGISTRY) — fall back to the
      // canonical host the Rust side expects.
      const baseForProbe =
        cfg.protocol === "anthropic" && !cfg.baseUrl
          ? "https://api.anthropic.com"
          : cfg.baseUrl;
      if (cfg.protocol === "anthropic" && !cfg.apiKey) {
        result.unconfigured.push(id);
        return;
      }
      const ids = await probeProviderModels(cfg.protocol, baseForProbe, cfg.apiKey);

      for (const modelId of ids) {
        result.models.push({
          id:            `${id}/${modelId}`,
          providerId:    id,
          providerLabel: cfg.providerLabel,
          modelId,
          label:         modelId,
        });
      }
    } catch (err) {
      result.errors[id] = String(err);
    }
  }));

  return result;
}

// ─── React hook ───────────────────────────────────────────────────────

export interface UseDiscoveredModels {
  /** Flat list of `<providerId>/<modelId>` rows, grouped by providerId on the consumer side. */
  data: DiscoveredModel[];
  /** Per-provider error message — the picker can surface these inline. */
  errors: Record<string, string>;
  /** Providers known but not configured yet — useful for an empty-state CTA. */
  unconfigured: string[];
  /** True while the FIRST discovery is in flight; subsequent refreshes flip this back to true briefly. */
  isLoading: boolean;
  /** Manually re-run discovery (e.g. after the user saved a new API key). Returns a Promise that resolves when the round of HTTP calls is done — callers can ignore it. */
  refresh: () => Promise<void>;
}

export function useDiscoveredModels(): UseDiscoveredModels {
  // Subscribe to la query TanStack qui contient le DiscoveryState complet.
  // Une seule subscription → un seul re-render par change.
  const { data = INITIAL_DISCOVERY } = useQuery<DiscoveryState>({
    queryKey: DISCOVERY_KEY,
    queryFn: () => getDiscoveryState(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const { models, errors, unconfigured, lastFetched, isLoading } = data;
  const refresh = useCallback(refreshDiscovery, []);

  useEffect(() => {
    // 1) Listen for result broadcasts from OTHER windows + llama ready.
    let unlistenDiscovery: (() => void) | null = null;
    let unlistenLlamaReady: (() => void) | null = null;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlistenDiscovery = await mod.listen<{ result?: DiscoveryResult }>(DISCOVERY_EVENT, (e) => {
          const p = e.payload;
          if (p?.result) applyDiscoveryResult(p.result);
        });
        unlistenLlamaReady = await mod.listen("llama://ready", () => {
          void refreshDiscovery();
        });
      } catch (err) {
        console.warn("[modelDiscovery] listen failed", err);
      }
    })();

    // 2) Refresh trigger : first-session-mount OR stale TTL.
    const stale = Date.now() - lastFetched > DISCOVERY_TTL_MS;
    const isFirstSessionMount = !sessionDiscoveryDone;
    if ((isFirstSessionMount || stale) && !getDiscoveryState().isLoading) {
      sessionDiscoveryDone = true;
      void refreshDiscovery();
    }

    return () => {
      unlistenDiscovery?.();
      unlistenLlamaReady?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data: models, errors, unconfigured, isLoading, refresh };
}
