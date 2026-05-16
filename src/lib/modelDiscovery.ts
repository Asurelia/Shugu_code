// Shugu Forge — runtime model discovery.
//
// For every provider that the user has CONFIGURED (api key, baseUrl override,
// or both — depending on the protocol), this module queries the provider's
// "list models" endpoint and returns a flat list of what is ACTUALLY
// available. No more hardcoded display lists pretending Claude/GPT/Mistral
// exist when the user has never set a key for them.
//
// Endpoints by protocol:
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
// We are inside a Tauri webview, so CORS restrictions that would block a
// browser do not apply. The apiKey is read fresh from the OS keychain each
// time discovery runs; it never leaves this process beyond the outbound
// HTTPS request to the upstream provider.

import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PROVIDER_REGISTRY, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { db } from "@/lib/db";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

interface DiscoveryState {
  models: DiscoveredModel[];
  errors: Record<string, string>;
  unconfigured: string[];
  /** Unix-ms timestamp of the last successful discovery. 0 = never. */
  lastFetched: number;
  /** True while a discovery is in flight. Volatile (not persisted). */
  isLoading: boolean;
}

interface DiscoveryActions {
  applyResult: (r: DiscoveryResult) => void;
  setLoading: (b: boolean) => void;
  invalidate: () => void;
}

export const useDiscoveryStore = create<DiscoveryState & DiscoveryActions>()(
  persist(
    (set) => ({
      models: [],
      errors: {},
      unconfigured: [],
      lastFetched: 0,
      isLoading: false,
      applyResult: (r) => set({ ...r, lastFetched: Date.now(), isLoading: false }),
      setLoading: (b) => set({ isLoading: b }),
      invalidate: () => set({ lastFetched: 0 }),
    }),
    {
      name: "shugu.modelDiscovery.v1",
      // Don't persist `isLoading` — it would deserialize as `true` and freeze
      // the UI on startup. Only the data + freshness timestamp survive.
      partialize: (state) => ({
        models: state.models,
        errors: state.errors,
        unconfigured: state.unconfigured,
        lastFetched: state.lastFetched,
      }),
    },
  ),
);

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
  const state = useDiscoveryStore.getState();
  if (state.isLoading) return;
  state.setLoading(true);
  let r: DiscoveryResult;
  try {
    r = await discoverAllModels();
  } catch (err) {
    r = { models: [], errors: { __global: String(err) }, unconfigured: [] };
  }
  // Apply to local store first — observers in THIS window re-render
  // synchronously; that's the bit ConnCard / FloatChat were missing before
  // (the event-based path arrived too late or not at all in some cases).
  useDiscoveryStore.getState().applyResult(r);
  if (!inTauri) return;
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

// ─── Per-protocol fetchers ────────────────────────────────────────────

async function fetchOpenAICompatModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const json = await r.json();
  const list: unknown = Array.isArray(json?.data) ? json.data : [];
  return (list as Array<{ id?: unknown }>).map((m) => String(m.id ?? "")).filter(Boolean);
}

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const r = await fetch(`${base}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const json = await r.json();
  const list: unknown = Array.isArray(json?.models) ? json.models : [];
  return (list as Array<{ name?: unknown }>).map((m) => String(m.name ?? "")).filter(Boolean);
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const json = await r.json();
  const list: unknown = Array.isArray(json?.data) ? json.data : [];
  return (list as Array<{ id?: unknown }>).map((m) => String(m.id ?? "")).filter(Boolean);
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
    if (enabled !== "true") {
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
      let ids: string[];
      if (cfg.protocol === "anthropic") {
        if (!cfg.apiKey) { result.unconfigured.push(id); return; }
        ids = await fetchAnthropicModels(cfg.apiKey);
      } else if (cfg.protocol === "ollama") {
        ids = await fetchOllamaModels(cfg.baseUrl);
      } else {
        // openai-compat (openai, mistral, groq, llamacpp, custom-openai)
        ids = await fetchOpenAICompatModels(cfg.baseUrl, cfg.apiKey);
      }

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
  // Subscribe to the shared store. Every WebviewWindow that calls this hook
  // sees the same data; persistence (localStorage) survives reloads.
  const models       = useDiscoveryStore((s) => s.models);
  const errors       = useDiscoveryStore((s) => s.errors);
  const unconfigured = useDiscoveryStore((s) => s.unconfigured);
  const lastFetched  = useDiscoveryStore((s) => s.lastFetched);
  const isLoading    = useDiscoveryStore((s) => s.isLoading);
  const applyResult  = useDiscoveryStore((s) => s.applyResult);

  // Delegate to the module-scope refreshDiscovery so we have a single source
  // of truth for "do the work + broadcast". Callers from event handlers
  // (e.g. ConnCard.onSave) can use the same function.
  const refresh = useCallback(refreshDiscovery, []);

  useEffect(() => {
    // 1) Listen for result broadcasts from OTHER windows so we adopt their
    //    discovery without re-fetching here.
    let unlisten: (() => void) | null = null;
    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          unlisten = await mod.listen<{ result?: DiscoveryResult }>(DISCOVERY_EVENT, (e) => {
            const p = e.payload;
            if (p?.result) applyResult(p.result);
          });
        } catch (err) {
          console.warn("[modelDiscovery] listen failed", err);
        }
      })();
    }

    // 2) Refresh trigger. Two paths:
    //    a) First mount in this WINDOW SESSION → force refresh regardless
    //       of TTL. Without this, a quick close-and-relaunch (< TTL) loads
    //       the persisted cache from the previous session and never re-
    //       probes — so e.g. llama-server going down between sessions
    //       leaves the picker showing its models like nothing changed.
    //       Module-scope flag resets per page load (each window has its
    //       own JS context), so it naturally fires once per app start per
    //       window.
    //    b) Subsequent mounts (route nav) → only refresh if stale.
    //    The result is broadcast via refreshDiscovery → other windows adopt.
    const stale = Date.now() - lastFetched > DISCOVERY_TTL_MS;
    const isFirstSessionMount = !sessionDiscoveryDone;
    if ((isFirstSessionMount || stale) && !useDiscoveryStore.getState().isLoading) {
      sessionDiscoveryDone = true;
      void refreshDiscovery();
    }

    return () => { unlisten?.(); };
    // We intentionally don't depend on `lastFetched` here — the store updates
    // it itself after applyResult, and re-running this effect on every
    // timestamp change would re-subscribe to the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data: models, errors, unconfigured, isLoading, refresh };
}
