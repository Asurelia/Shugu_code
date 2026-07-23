// Shugu Forge — Connections page (Settings → Connections).
//
// Provider catalog (AI / dev tools / image / storage cards), wizard for
// adding custom providers, and per-card editor (api key field, baseUrl
// override, enabled toggle). All secrets/configs are written through the
// credentials backend (OS keychain in Tauri); discovery is invalidated on
// any save so the ModelPicker picks up the new key on the next read.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { invoke } from "@/lib/tauri";
import {
  getProviderField,
  setProviderField,
  setConfig,
  getConfig,
  clearProviderConfig,
  setProviderEnabled,
  getProviderEnabled,
} from "@/lib/credentials";
import { invalidateDiscovery, useDiscoveredModels } from "@/lib/modelDiscovery";
import { useCodexAuth, invalidateCodex } from "./codexQueries";
import { CodexUsage } from "./CodexUsage";
import {
  codexLogin,
  codexLogout,
  codexGetDedicated,
  codexSetDedicated,
} from "@/lib/codex";
import { db } from "@/lib/db";
import { getInstalledIds, getModelPath } from "@/lib/modelBundle";
import { parseThinkingMode, serializeThinkingMode, type ThinkingMode } from "@/lib/thinkingHeuristic";
import { McpServersSection } from "@/features/mcp/McpServersSection";
import { useModalFocusTrap } from "@/lib/modalFocus";
import { ProviderMark } from "@/components/ProviderMark";
import "./connections-redesign.css";

// Storage key for the persisted list of user-added custom providers. JSON-encoded
// array of ConnCardData rows (display metadata only — secrets/configs live in
// their respective backends keyed by `provider.<id>.*`).
const CUSTOM_PROVIDERS_KEY = "connections.customProviders.v1";

export function ConnectionsView() {
  const [tab, setTab] = useState("models");
  const [customModels, setCustomModels] = useState<ConnCardData[]>([]);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpanded = (id: string) =>
    setExpandedId((current) => (current === id ? null : id));

  // Restore persisted custom providers on mount. The list is metadata only —
  // each provider's actual credentials are loaded by its ConnCard via the
  // provider.<id>.* convention, so there's no race between this load and
  // the card's own initial fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await db.settings.get(CUSTOM_PROVIDERS_KEY);
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setCustomModels(parsed as ConnCardData[]);
      } catch (err) {
        console.warn("[connections] failed to restore custom providers", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistCustom = async (next: ConnCardData[]): Promise<void> => {
    try { await db.settings.set(CUSTOM_PROVIDERS_KEY, JSON.stringify(next)); }
    catch (err) { console.warn("[connections] failed to persist custom providers", err); }
  };
  const tabs = [
    { v: "models",    l: "AI Providers" },
    { v: "search",    l: "Recherche web" },
    { v: "tools",     l: "Dev tools" },
    { v: "mcp",       l: "Serveurs MCP" },
    { v: "image",     l: "Image services" },
    { v: "storage",   l: "Storage" },
  ];

  // Field shape note: each field is { label (human), key (stable id used by the
  // credentials backend), placeholder, secret }. `key` MUST be stable across
  // releases — it's the account suffix in the OS keychain (`provider.<id>.<key>`)
  // and the column suffix in the SQLite `settings` table. The `label` is the
  // only thing that's free to change for i18n / wording.
  const cards: Record<string, ConnCardData[]> = {
    models: [
      { id: "anthropic", name: "Anthropic", meta: "Claude / Shugu models", logo: "A", color: "#d97757", probe: "models", fields: [
        { label: "API key", key: "apiKey", placeholder: "sk-ant-…", secret: true },
      ]},
      { id: "openai", name: "OpenAI", meta: "GPT-4o, o1, embeddings", logo: "O", color: "#10a37f", probe: "models", fields: [
        { label: "API key", key: "apiKey", placeholder: "sk-…", secret: true },
        { label: "Org ID",  key: "orgId",  placeholder: "org-…", secret: false },
      ]},
      { id: "ollama", name: "Ollama", meta: "Local model server", logo: "O", color: "#000", probe: "models", fields: [
        { label: "Endpoint", key: "baseUrl", placeholder: "http://localhost:11434", secret: false },
      ]},
      { id: "llamacpp", name: "llama.cpp", meta: "Local OpenAI-compatible server (gguf models)", logo: "L", color: "#7c3aed", probe: "models", fields: [
        { label: "Endpoint", key: "baseUrl", placeholder: "http://localhost:8090", secret: false },
        // HF repo:quant fed to `llama-server -hf …`. Ex: HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q5_K_P
        { label: "Modèle HuggingFace (repo:quant)", key: "hfModel", placeholder: "user/repo:Q5_K_P", secret: false },
        { label: "Contexte agent (tokens, optionnel)", key: "ctx", placeholder: "auto · 32768 pour Mistral", secret: false },
        { label: "Template llama.cpp (optionnel)", key: "chatTemplate", placeholder: "ex. mistral-v3", secret: false },
        // Optional path to llama-server.exe. If empty we resolve from PATH
        // (winget install puts it there) then fall back to Docker Desktop's
        // bundled binary at ~/.docker/bin/inference/llama-server.exe.
        { label: "Binary (optionnel)", key: "binary", placeholder: "auto-détecté depuis le PATH", secret: false },
        { label: "API key (optional)", key: "apiKey", placeholder: "leave empty unless --api-key was set", secret: true },
      ]},
      { id: "mistral", name: "Mistral", meta: "European open-weights", logo: "M", color: "#ff7000", probe: "models", fields: [
        { label: "API key", key: "apiKey", placeholder: "…", secret: true },
      ]},
      { id: "groq", name: "Groq", meta: "Fast LPU inference", logo: "G", color: "#f55036", probe: "models", fields: [
        { label: "API key", key: "apiKey", placeholder: "gsk_…", secret: true },
      ]},
      { id: "minimax", name: "MiniMax", meta: "OpenAI-compat · texte (vidéo/voix via MCP)", logo: "M", color: "#ff4d4f", probe: "models", fields: [
        { label: "API key", key: "apiKey", placeholder: "…", secret: true },
        { label: "Modèle par défaut", key: "defaultModel", placeholder: "MiniMax-M2.1 (requis si la liste auto échoue)", secret: false },
      ]},
      // Codex = the user's ChatGPT subscription via the local `codex` CLI
      // (shell-out, no API key). Rendered by a dedicated <CodexCard/> (status +
      // usage panel) instead of the generic key-field ConnCard.
      { id: "codex", name: "OpenAI Codex", meta: "Abonnement ChatGPT (CLI)", logo: "C", color: "#10a37f", fields: [] },
    ],
    search: [
      // Les clés vont dans le keychain sous `provider.brave.apiKey` /
      // `provider.tavily.apiKey` — exactement ce que `commands::search` lit côté
      // Rust pour la cascade web_search (Brave → Tavily → DuckDuckGo sans clé).
      { id: "brave", name: "Brave Search", meta: "Recherche web fiable · 2000 requêtes/mois gratuites", logo: "B", color: "#fb542b", fields: [
        { label: "API key", key: "apiKey", placeholder: "BSA…", secret: true },
      ]},
      { id: "tavily", name: "Tavily", meta: "Recherche optimisée pour l'IA (renvoie aussi le contenu)", logo: "T", color: "#3b82f6", fields: [
        { label: "API key", key: "apiKey", placeholder: "tvly-…", secret: true },
      ]},
    ],
    tools: [
      { id: "github", name: "GitHub", meta: "Repos, PRs, issues", logo: "G", color: "#24292f", available: false, unavailableReason: "Connecteur natif non implémenté — utilise un serveur MCP GitHub pour l’instant.", fields: [
        { label: "Personal token", key: "apiKey", placeholder: "ghp_…", secret: true },
      ]},
      { id: "gitlab", name: "GitLab", meta: "Repos & CI", logo: "G", color: "#fc6d26", available: false, unavailableReason: "Connecteur natif non implémenté — utilise un serveur MCP compatible.", fields: [
        { label: "Token", key: "apiKey", placeholder: "glpat-…", secret: true },
        { label: "Host",  key: "baseUrl", placeholder: "https://gitlab.com", secret: false },
      ]},
      { id: "linear", name: "Linear", meta: "Issues & projects", logo: "L", color: "#5e6ad2", available: false, unavailableReason: "Connecteur natif non implémenté — utilise le MCP Linear.", fields: [
        { label: "API key", key: "apiKey", placeholder: "lin_api_…", secret: true },
      ]},
      { id: "vercel", name: "Vercel", meta: "Deploy from Forge", logo: "▲", color: "#000", available: false, unavailableReason: "Déploiement Vercel non implémenté dans Shugu.", fields: [
        { label: "Token", key: "apiKey", placeholder: "…", secret: true },
      ]},
      { id: "docker", name: "Docker", meta: "Local daemon", logo: "D", color: "#2496ed", available: false, unavailableReason: "Connexion Docker dédiée non implémentée ; les agents peuvent utiliser le CLI selon leur profil.", fields: [
        { label: "Socket", key: "endpoint", placeholder: "/var/run/docker.sock", secret: false },
      ]},
    ],
    image: [
      { id: "comfyui", name: "ComfyUI Local", meta: "Workflow local text-to-image", logo: "C", color: "#7ee787", fields: [
        { label: "Endpoint", key: "baseUrl", placeholder: "http://127.0.0.1:8188", secret: false },
      ]},
      { id: "openai", name: "OpenAI Images", meta: "GPT Image generation & editing", logo: "O", color: "#10a37f", fields: [
        { label: "API key", key: "apiKey", placeholder: "sk-…", secret: true },
        { label: "Endpoint", key: "baseUrl", placeholder: "https://api.openai.com", secret: false },
      ]},
      { id: "minimax", name: "MiniMax Image", meta: "image-01 · references sujet", logo: "M", color: "#ff4d4f", fields: [
        { label: "API key", key: "apiKey", placeholder: "…", secret: true },
        { label: "Endpoint", key: "baseUrl", placeholder: "https://api.minimax.io", secret: false },
      ]},
      { id: "replicate", name: "Replicate", meta: "flux.1, sdxl, hosted models", logo: "R", color: "#fff", fields: [
        { label: "API token", key: "apiKey", placeholder: "r8_…", secret: true },
        { label: "Endpoint", key: "baseUrl", placeholder: "https://api.replicate.com", secret: false },
      ]},
      { id: "stability", name: "Stability AI", meta: "SDXL turbo, SD3", logo: "S", color: "#9b51e0", fields: [
        { label: "Key", key: "apiKey", placeholder: "sk-…", secret: true },
        { label: "Endpoint", key: "baseUrl", placeholder: "https://api.stability.ai", secret: false },
      ]},
      { id: "custom", name: "Custom Image Endpoint", meta: "OpenAI-compatible /v1/images", logo: "X", color: "#d8b4fe", fields: [
        { label: "API key", key: "apiKey", placeholder: "optional", secret: true },
        { label: "Endpoint", key: "baseUrl", placeholder: "https://host.example.com", secret: false },
      ]},
    ],
    storage: [
      { id: "drive",  name: "Google Drive",  meta: "Sync generations & projects", logo: "D", color: "#4285f4", available: false, unavailableReason: "Synchronisation Google Drive non implémentée.", fields: [] },
      { id: "s3", name: "S3-compatible", meta: "Self-hosted bucket", logo: "S", color: "#ff9900", available: false, unavailableReason: "Synchronisation S3 non implémentée.", fields: [
        { label: "Endpoint", key: "endpoint", placeholder: "s3.example.com", secret: false },
        { label: "Key ID",   key: "orgId",    placeholder: "AKIA…",         secret: false },
        { label: "Secret",   key: "apiKey",   placeholder: "…",              secret: true  },
      ]},
      { id: "icloud", name: "iCloud Drive", meta: "macOS only", logo: "i", color: "#007aff", available: false, unavailableReason: "Synchronisation iCloud non implémentée.", fields: [] },
    ],
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <div className="connections-hero">
            <div>
              <span className="connections-eyebrow">Infrastructure IA</span>
              <h3>Connexions</h3>
              <p className="sub">
                Branche tes modèles et services. Les secrets restent dans le coffre natif
                de ton système ; Shugu vérifie les providers en direct.
              </p>
            </div>
            <div className="connections-trust" aria-label="Garanties de connexion">
              <span><Icon name="lock" size={12} /> Clés protégées</span>
              <span><span className="connections-live-dot" /> Détection live</span>
              <span><Icon name="list" size={12} /> Réglages repliables</span>
            </div>
          </div>
          <div className="conn-tabs">
            {tabs.map(t => (
              <button
                key={t.v}
                className={"conn-tab-btn" + (tab === t.v ? " on" : "")}
                onClick={() => {
                  setTab(t.v);
                  setExpandedId(null);
                }}
              >
                {t.l}
              </button>
            ))}
          </div>
          <div className="connections-grid">
            {(cards[tab] || []).map((c: any) =>
              c.id === "codex"
                ? (
                  <CodexCard
                    key={c.id}
                    c={c}
                    expanded={expandedId === c.id}
                    onToggle={() => toggleExpanded(c.id)}
                  />
                )
                : (
                  <ConnCard
                    key={c.id}
                    c={c}
                    expanded={expandedId === c.id}
                    onToggle={() => toggleExpanded(c.id)}
                  />
                ),
            )}
            {tab === "models" && customModels.map((c: any) => (
              <ConnCard
                key={c.id}
                c={c}
                expanded={expandedId === c.id}
                onToggle={() => toggleExpanded(c.id)}
              />
            ))}
            {tab === "models" && (
              <button type="button" className="conn-add-card" onClick={() => setAdding(true)} aria-label="Add custom provider">
                <span className="plus" aria-hidden="true"><Icon name="plus" size={18}/></span>
                <div className="t">Ajouter un provider</div>
                <div className="s">Endpoint compatible OpenAI, vLLM, LM Studio, Together AI ou routeur personnalisé.</div>
              </button>
            )}
          </div>
          {tab === "models" && <RoutingSection />}
          {tab === "search" && (
            <p className="sub" style={{ marginTop: 14 }}>
              Sans clé, la recherche web de l'agent fonctionne quand même (DuckDuckGo, best-effort) — mais elle peut être bloquée ou vide. Ajoute une clé <b>Brave</b> ou <b>Tavily</b> pour des résultats fiables. Une seule suffit ; Brave est essayé en premier, puis Tavily, puis DuckDuckGo. Les modèles dotés de leur propre recherche (Claude, GPT…) l'utilisent directement.
            </p>
          )}
          {tab === "mcp" && <McpServersSection />}
        </div>
      </div>
      {adding && <AddProviderModal onClose={() => setAdding(false)} onAdd={async (c: ConnCardData) => {
        const next = [...customModels, c];
        setCustomModels(next);
        await persistCustom(next);
        setAdding(false);
      }}/>}
    </div>
  );
}

export function AddProviderModal({ onClose, onAdd }: { onClose: () => void; onAdd: (c: ConnCardData) => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("https://");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testDetails, setTestDetails] = useState<string | null>(null);
  // `kind` here doubles as the protocol the chat dispatcher will use. We keep
  // anthropic/openai/ollama/custom in lockstep with the Rust `chat_send` match
  // arms so a user-defined provider can immediately participate in chat.
  const [kind, setKind] = useState("openai");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useModalFocusTrap({ open: true, containerRef: dialogRef, initialFocusRef: nameRef, onEscape: onClose });
  // For OpenAI-compat and Ollama, leaving the API key empty is fine (local
  // servers often don't require one). We only require name + endpoint.
  const ok = name && endpoint;
  const testConnection = async () => {
    if (!endpoint) return;
    setTestState("testing");
    setTestMessage(null);
    setTestDetails(null);
    try {
      const models = await invoke<string[]>("models_discover_external", {
        protocol: kind,
        baseUrl: endpoint,
        apiKey: key || null,
      });
      setTestState("ok");
      setTestMessage(`Connexion vérifiée · ${models.length} modèle${models.length > 1 ? "s" : ""}`);
    } catch (err) {
      const details = String(err);
      setTestState("error");
      setTestMessage(friendlyConnectionIssue(details, "custom"));
      setTestDetails(details);
    }
  };
  const submit = async () => {
    if (!ok) return;
    const id = "custom-" + Date.now();
    // Persist credentials immediately so the ConnCard that's about to render
    // finds them on its initial load instead of starting empty.
    if (endpoint) await setProviderField(id, "baseUrl", endpoint, false);
    if (key)      await setProviderField(id, "apiKey",  key,      true);
    if (model)    await setProviderField(id, "defaultModel", model, false);
    await setProviderField(id, "protocol", kind, false);
    // STRICT-MODE discovery (modelDiscovery.ts:338) requires `enabled === "true"` —
    // a custom provider that was just added is implicitly "the user wants this on",
    // so we flip the flag here. Without this line the discovery short-circuits the
    // provider into `unconfigured` and never probes its /v1/models endpoint, which
    // surfaces as: no models in the picker AND no entry in the orchestrator dropdown.
    await setProviderEnabled(id, true);
    void invalidateDiscovery();
    const card: ConnCardData = {
      id,
      name,
      meta: kind + " · " + (model || "auto"),
      logo: name[0]?.toUpperCase() || "?",
      color: "#5063c5",
      probe: "models",
      fields: [
        { label: "Endpoint",      key: "baseUrl",      placeholder: endpoint,      secret: false },
        { label: "API key",       key: "apiKey",       placeholder: "•••",         secret: true  },
        { label: "Default model", key: "defaultModel", placeholder: model || "auto", secret: false },
      ],
    };
    await onAdd(card);
  };
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Add custom provider"
        tabIndex={-1}
        style={{width: "min(540px, 90%)", padding: 0}}
      >
        <div style={{padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)"}}>
          <div style={{fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15}}>Add custom provider</div>
          <div style={{fontSize: 12, color: "var(--on-surface-variant)", marginTop: 4}}>
            Any OpenAI-compatible endpoint works (LM Studio, vLLM, Together, Fireworks, OpenRouter…).
          </div>
        </div>
        <div style={{padding: 18, display: "flex", flexDirection: "column", gap: 12}}>
          <div className="conn-field">
            <label>Display name</label>
            <div className="input"><input ref={nameRef} name="provider-name" autoComplete="off" aria-label="Display name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. OpenRouter, My LM Studio…"/></div>
          </div>
          <div className="conn-field">
            <label>Protocol</label>
            <div style={{display:"flex", gap:6}}>
              {[
                { v: "openai", l: "OpenAI compatible" },
                { v: "anthropic", l: "Anthropic" },
                { v: "ollama", l: "Ollama" },
                { v: "custom", l: "Custom" },
              ].map(k => (
                <button key={k.v} className={"conn-tab-btn" + (kind === k.v ? " on" : "")} onClick={() => setKind(k.v)}>{k.l}</button>
              ))}
            </div>
          </div>
          <div className="conn-field">
            <label>Endpoint URL</label>
            <div className="input"><input type="url" inputMode="url" name="provider-endpoint" autoComplete="url" aria-label="Endpoint URL" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></div>
          </div>
          <div className="conn-field">
            <label>API key</label>
            <div className="input"><input type="password" name="provider-api-key" autoComplete="new-password" spellCheck={false} aria-label="API key" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…"/></div>
          </div>
          <div className="conn-field">
            <label>Default model (optional)</label>
            <div className="input"><input name="provider-model" autoComplete="off" spellCheck={false} aria-label="Default model" value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini, llama-3.3-70b, claude-3-5-sonnet…"/></div>
          </div>
          {testMessage && (
            <div
              role={testState === "error" ? "alert" : "status"}
              style={{
                fontSize: 11,
                color: testState === "error" ? "var(--error, #ff6b6b)" : "var(--success, #4ade80)",
                overflowWrap: "anywhere",
              }}
            >
              {testState === "error" ? "Échec du test · " : "✓ "}{testMessage}
              {testDetails && (
                <details style={{ marginTop: 6, color: "var(--on-surface-muted)" }}>
                  <summary>Détails techniques</summary>
                  <code>{testDetails}</code>
                </details>
              )}
            </div>
          )}
        </div>
        <div style={{padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 8}}>
          <button className="lgb" onClick={onClose}>Cancel</button>
          <span style={{flex:1}}></span>
          <button
            className="lgb"
            onClick={() => void testConnection()}
            disabled={!endpoint || testState === "testing"}
          >
            <Icon name="thumbs" size={11}/> {testState === "testing" ? "Testing…" : "Test connection"}
          </button>
          <button className="lgb lgb-primary" disabled={!ok} onClick={submit}>
            <Icon name="plus" size={12}/> Add provider
          </button>
        </div>
      </div>
    </div>
  );
}

// Shape of a single editable field inside a connection card. `key` is the
// stable identifier the credentials backend uses (NOT `label`, which is
// allowed to drift for i18n). `secret: true` routes the value through the
// OS keychain; `secret: false` routes it through the SQLite settings table.
export interface ConnField {
  label: string;
  key: string;
  placeholder: string;
  secret: boolean;
}

export interface ConnCardData {
  id: string;
  name: string;
  meta: string;
  logo: string;
  color: string;
  /** Which real health probe can justify a “connected” state. */
  probe?: "models";
  /** False for catalog entries whose backend does not exist yet. */
  available?: boolean;
  unavailableReason?: string;
  fields: ConnField[];
}

type ConnStatus = "loading" | "configured" | "disconnected";

/** Dedicated card for the Codex CLI provider: no API key (subscription auth via
 *  `codex login`), so we show connection status + an enable toggle + the usage
 *  panel instead of the generic key fields. */
export function CodexCard({
  c,
  expanded,
  onToggle,
}: {
  c: ConnCardData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: auth, refetch, isFetching } = useCodexAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dedicated, setDedicated] = useState<boolean | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  // Structured login prompt from the app-server (browser authUrl, or device
  // userCode + verificationUrl), plus a status/error line.
  const [loginPrompt, setLoginPrompt] = useState<{
    kind: "browser" | "device";
    authUrl?: string;
    userCode?: string;
    verificationUrl?: string;
  } | null>(null);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [en, ded] = await Promise.all([getProviderEnabled("codex"), codexGetDedicated()]);
      if (cancelled) return;
      setEnabled(en === "true");
      setDedicated(ded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live login progress from the app-server `codex://login` events. The Rust
  // `codex_login` emits a `{phase:"prompt", kind, authUrl|userCode|verificationUrl}`
  // when the user must act, then a `{phase:"completed", success, error}` at the end.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlisten = await mod.listen<{
          phase?: string;
          kind?: "browser" | "device";
          authUrl?: string | null;
          userCode?: string | null;
          verificationUrl?: string | null;
          success?: boolean;
          error?: string | null;
        }>("codex://login", (e) => {
          const p = e.payload;
          if (p?.phase === "prompt") {
            setLoginPrompt({
              kind: p.kind ?? "browser",
              authUrl: p.authUrl ?? undefined,
              userCode: p.userCode ?? undefined,
              verificationUrl: p.verificationUrl ?? undefined,
            });
          } else if (p?.phase === "completed") {
            setLoginPrompt(null);
            setLoginMsg(p.success ? "✓ Connecté." : "✗ " + (p.error ?? "échec de connexion"));
          }
        });
      } catch {
        /* not in Tauri (web dev) — login button is a no-op there anyway */
      }
    })();
    return () => unlisten?.();
  }, []);

  const ready = !!auth?.loggedIn && !!auth?.binaryFound;

  const onLogin = async () => {
    setLoggingIn(true);
    setLoginPrompt(null);
    setLoginMsg(null);
    try {
      // Browser OAuth (smoothest). The app-server returns an authUrl (emitted as
      // a prompt the card shows); codex_login resolves when login completes.
      await codexLogin(false);
      setLoginMsg("✓ Connecté.");
      invalidateCodex();
      await refetch();
      void invalidateDiscovery();
    } catch (err) {
      setLoginMsg("✗ " + String(err));
    } finally {
      setLoggingIn(false);
      setLoginPrompt(null);
    }
  };

  const onLogout = async () => {
    try {
      await codexLogout();
      setLoginMsg(null);
      invalidateCodex();
      await refetch();
      void invalidateDiscovery();
    } catch (err) {
      setLoginMsg("✗ " + String(err));
    }
  };

  const toggleDedicated = async (on: boolean) => {
    setDedicated(on);
    await codexSetDedicated(on);
    // Switching home changes which auth.json counts — re-check status + picker.
    invalidateCodex();
    await refetch();
    void invalidateDiscovery();
  };
  const statusLabel = !auth
    ? "loading…"
    : ready
      ? "connecté"
      : !auth.binaryFound
        ? "binaire manquant"
        : "login requis";
  const statusClass = ready ? "connected" : "disconnected";

  const toggleEnabled = async (on: boolean) => {
    setEnabled(on);
    await setProviderEnabled("codex", on);
    void invalidateDiscovery();
  };

  const recheck = async () => {
    invalidateCodex();
    await refetch();
    void invalidateDiscovery();
  };

  return (
    <div
      className={`conn-card conn-card-v2${ready ? " connected" : ""}${expanded ? " is-expanded" : ""}`}
      data-provider-id={c.id}
    >
      <button
        type="button"
        className="conn-card-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ProviderMark id={c.id} name={c.name} fallback={c.logo} color={c.color} />
        <div className="conn-info">
          <div className="conn-name">{c.name}</div>
          <div className="conn-meta">{c.meta}</div>
        </div>
        <span className={`conn-status-v2 ${statusClass}`}>
          <span className="conn-status-dot" />
          {statusLabel}
        </span>
        <Icon name="down" size={13} className="conn-card-chevron" />
      </button>

      {expanded && (
        <div className="conn-card-body">
      {/* Status detail + remediation */}
      <div className="conn-detail-copy">
        {!auth ? (
          "Vérification…"
        ) : ready ? (
          <>
            ✓ Connecté via ton abonnement ChatGPT (aucune clé API, aucun token facturé en plus).
            <br />
            <span style={{ opacity: 0.7 }}>Binaire : <code>{auth.binary}</code></span>
          </>
        ) : !auth.binaryFound ? (
          <>
            ✗ Binaire <code>codex</code> introuvable. Installe-le dans un terminal :
            <br />
            <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 3 }}>
              pnpm add -g @openai/codex
            </code>
          </>
        ) : (
          <>
            ✗ Pas connecté à ton compte ChatGPT. Clique « Se connecter » ci-dessous — Codex
            ouvre la page de connexion OpenAI dans ton navigateur.
          </>
        )}
      </div>

      {/* Dedicated-vs-shared account toggle (always available; it changes WHERE
          the login is stored). Shared = the terminal-global ~/.codex login.
          Dedicated = a Shugu-only account isolated via CODEX_HOME. */}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          fontSize: 11,
          color: "var(--on-surface)",
          margin: "6px 0",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={dedicated ?? false}
          onChange={(e) => void toggleDedicated(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          Compte Codex dédié à Shugu
          <span style={{ display: "block", color: "var(--on-surface-muted)", fontSize: 10 }}>
            {dedicated
              ? "Connexion isolée du terminal (CODEX_HOME propre à Shugu)."
              : "Partagé avec ton terminal (login ~/.codex global)."}
          </span>
        </span>
      </label>

      {/* Enable-in-picker toggle (only meaningful once ready) */}
      {ready && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--on-surface)",
            margin: "4px 0",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={enabled ?? true}
            onChange={(e) => void toggleEnabled(e.target.checked)}
          />
          Proposer Codex dans le sélecteur de modèles du chat
        </label>
      )}

      {/* Login prompt (browser link or device code) + status, during/after login */}
      {(loggingIn || loginPrompt || loginMsg) && (
        <div
          style={{
            margin: "6px 0",
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)",
            fontSize: 11,
            color: "var(--on-surface-muted)",
            lineHeight: 1.5,
          }}
        >
          {loggingIn && !loginPrompt && !loginMsg && "Démarrage de la connexion…"}

          {loginPrompt?.kind === "browser" && loginPrompt.authUrl && (
            <div>
              Ouvre cette page pour te connecter à ChatGPT :
              <br />
              <a
                href={loginPrompt.authUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--primary, #7c3aed)", wordBreak: "break-all" }}
              >
                {loginPrompt.authUrl}
              </a>
              <div style={{ marginTop: 4, opacity: 0.7 }}>
                Puis approuve — cette fenêtre se mettra à jour automatiquement.
              </div>
            </div>
          )}

          {loginPrompt?.kind === "device" && (
            <div>
              Va sur{" "}
              <a
                href={loginPrompt.verificationUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--primary, #7c3aed)" }}
              >
                {loginPrompt.verificationUrl}
              </a>{" "}
              et saisis le code :
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "var(--font-mono)",
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: 2,
                  color: "var(--on-surface)",
                }}
              >
                {loginPrompt.userCode}
              </div>
            </div>
          )}

          {loginMsg && (
            <div style={{ color: loginMsg.startsWith("✗") ? "var(--error, #ff6b6b)" : "#10a37f" }}>
              {loginMsg}
            </div>
          )}
        </div>
      )}

      {/* Usage panel (real per-run tokens + local rolling-window estimate) */}
      {ready && <CodexUsage />}

      <div className="conn-actions">
        {auth?.binaryFound && (
          ready ? (
            <button className="lgb lgb-sm" onClick={() => void onLogout()}>
              <Icon name="x" size={11} /> Se déconnecter
            </button>
          ) : (
            <button
              className="lgb lgb-sm lgb-primary"
              onClick={() => void onLogin()}
              disabled={loggingIn}
            >
              <Icon name="sparkle" size={11} /> {loggingIn ? "Connexion…" : "Se connecter à Codex"}
            </button>
          )
        )}
        <button className="lgb lgb-sm" onClick={() => void recheck()} disabled={isFetching}>
          <Icon name="check" size={11} /> {isFetching ? "Vérification…" : "Vérifier"}
        </button>
      </div>
        </div>
      )}
    </div>
  );
}

export function ConnCard({
  c,
  expanded,
  onToggle,
}: {
  c: ConnCardData;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (c.available === false) {
    return (
      <div className="conn-card conn-card-v2 is-unavailable" aria-disabled="true">
        <div className="conn-card-toggle">
          <ProviderMark id={c.id} name={c.name} fallback={c.logo} color={c.color} />
          <div className="conn-info">
            <div className="conn-name">{c.name}</div>
            <div className="conn-meta" title={c.unavailableReason}>{c.meta}</div>
          </div>
          <span className="conn-status-v2 disconnected">
            <span className="conn-status-dot" />
            Indisponible
          </span>
        </div>
      </div>
    );
  }
  return <ActiveConnCard c={c} expanded={expanded} onToggle={onToggle} />;
}

function friendlyConnectionIssue(message: string, providerId: string): string {
  const normalized = message.toLowerCase();
  if (
    providerId === "llamacpp" ||
    normalized.includes("localhost") ||
    normalized.includes("loopback") ||
    normalized.includes("connection refused")
  ) {
    return "Le serveur local n’est pas joignable. Démarre-le ou vérifie son endpoint.";
  }
  if (normalized.includes("401") || normalized.includes("403") || normalized.includes("auth")) {
    return "La clé est enregistrée, mais le provider refuse l’authentification.";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "Le provider ne répond pas dans le délai attendu.";
  }
  return "La configuration est enregistrée, mais la vérification a échoué.";
}

function ActiveConnCard({
  c,
  expanded,
  onToggle,
}: {
  c: ConnCardData;
  expanded: boolean;
  onToggle: () => void;
}) {
  // `vals` is the live edited state. `saved` mirrors what's actually persisted
  // and is used to drive the "dirty" indicator + decide whether the Save
  // button has work to do. Both are keyed by `field.key`, not by label.
  const [vals, setVals]   = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<ConnStatus>("loading");
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Subscribe to discovery via TanStack (replaces ancien pattern selector
  // Zustand). useDiscoveredModels retourne le state complet ; on lit
  // errors et models filter en local sans selector dédié.
  const { data: discoveredModels, errors: discoveryErrors } = useDiscoveredModels();
  const discoveryError = discoveryErrors[c.id] ?? null;
  const discoveredCount = discoveredModels.filter((m) => m.providerId === c.id).length;

  // ── Initial load: pull every known field for this provider from the
  // appropriate backend (keychain for secrets, SQLite for the rest). A
  // provider counts as "connected" if at least one field has a stored
  // value — sufficient for v1 because every meaningful provider has at
  // least one required field. Cards with `fields.length === 0` (e.g.
  // Google Drive placeholder) stay "disconnected" until we wire OAuth.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial: Record<string, string> = {};
      await Promise.all(
        c.fields.map(async (f) => {
          const v = await getProviderField(c.id, f.key, f.secret);
          if (v != null && v !== "") initial[f.key] = v;
        }),
      );
      if (cancelled) return;
      setVals(initial);
      setSaved(initial);
      setStatus(Object.keys(initial).length > 0 ? "configured" : "disconnected");
    })();
    return () => { cancelled = true; };
    // Intentionally NOT including c.fields — it's a fresh array reference on
    // every parent render (the `cards` object is rebuilt inside ConnectionsView's
    // function body) which would re-fire this load effect on any parent state
    // change (e.g. opening the Add Provider modal) and wipe the user's
    // in-progress typing. The field schema is stable for the lifetime of a card
    // identified by c.id, so c.id alone is the correct trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  // ── Dirty check: any field whose current value differs from what we
  // last fetched / wrote. Empty-vs-undefined is normalized so a never-set
  // field with "" in the input doesn't flag as dirty against an absent row.
  const isDirty = c.fields.some((f) => (vals[f.key] ?? "") !== (saved[f.key] ?? ""));

  const onSave = async () => {
    setSavingState("saving");
    setErrorMsg(null);
    try {
      // Write only the dirty fields — saves a couple of keychain round-trips
      // and avoids re-encrypting unchanged secrets.
      const dirtyFields = c.fields.filter((f) => (vals[f.key] ?? "") !== (saved[f.key] ?? ""));
      await Promise.all(
        dirtyFields.map((f) => setProviderField(c.id, f.key, vals[f.key] ?? "", f.secret)),
      );
      // Mark the provider as explicitly enabled so the discovery layer treats
      // it as user-confirmed (not just auto-probed). Symmetric to the "false"
      // flag flipped by clearProviderConfig in onDisconnect.
      await setProviderEnabled(c.id, true);
      setSaved({ ...vals });
      const anyValue = c.fields.some((f) => (vals[f.key] ?? "") !== "");
      setStatus(anyValue ? "configured" : "disconnected");
      setSavingState("saved");
      // Tell every window that the set of usable providers may have changed
      // so the ModelPicker / chibi mood / etc. pick up the new key on next
      // render. Fire-and-forget — the user doesn't wait on this.
      void invalidateDiscovery();
      // Reset the "saved" pill after a short delay so the next edit feels
      // responsive without lingering UI noise.
      setTimeout(() => setSavingState((s) => (s === "saved" ? "idle" : s)), 1200);
    } catch (err) {
      setSavingState("error");
      setErrorMsg(String(err));
    }
  };

  const onDisconnect = async () => {
    setSavingState("saving");
    setErrorMsg(null);
    try {
      await clearProviderConfig(c.id);
      const empty: Record<string, string> = {};
      setVals(empty);
      setSaved(empty);
      setStatus("disconnected");
      setSavingState("idle");
      void invalidateDiscovery();
    } catch (err) {
      setSavingState("error");
      setErrorMsg(String(err));
    }
  };

  const probePassed = c.probe === "models" && !discoveryError && discoveredCount > 0;
  const visualStatus: "loading" | "connected" | "configured" | "disconnected" =
    status === "loading" ? "loading" : probePassed ? "connected" : status;
  const hasDiscoveryError = !!discoveryError && status === "configured";
  const statusTone = hasDiscoveryError ? "error" : visualStatus;
  const statusLabel: string = visualStatus === "loading"
    ? "Vérification…"
    : visualStatus === "connected"
      ? `${discoveredCount} modèle${discoveredCount > 1 ? "s" : ""} prêt${discoveredCount > 1 ? "s" : ""}`
      : visualStatus === "configured"
        ? (discoveryError ? "À vérifier" : "Configuré")
        : "À configurer";

  return (
    <div
      className={`conn-card conn-card-v2${visualStatus === "connected" ? " connected" : ""}${hasDiscoveryError ? " has-error" : ""}${expanded ? " is-expanded" : ""}`}
      data-provider-id={c.id}
    >
      <button
        type="button"
        className="conn-card-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ProviderMark id={c.id} name={c.name} fallback={c.logo} color={c.color} />
        <div className="conn-info">
          <div className="conn-name">{c.name}</div>
          <div className="conn-meta" title={hasDiscoveryError ? friendlyConnectionIssue(discoveryError, c.id) : c.meta}>
            {hasDiscoveryError ? friendlyConnectionIssue(discoveryError, c.id) : c.meta}
          </div>
        </div>
        <span className={`conn-status-v2 ${statusTone}`}>
          <span className="conn-status-dot" />
          {statusLabel}
        </span>
        <Icon name="down" size={13} className="conn-card-chevron" />
      </button>

      {expanded && (
        <div className="conn-card-body">
          {c.fields.length > 0 && (
            <div className="conn-fields-grid">
              {c.fields.map((field) => {
                const isSaved = (saved[field.key] ?? "") !== "";
                return (
                  <div key={field.key} className="conn-field">
                    <label>
                      {field.label}
                      {isSaved && <span className="conn-field-saved">Enregistré</span>}
                    </label>
                    <div className="input">
                      <input
                        type={field.secret && !reveal[field.key] ? "password" : "text"}
                        value={vals[field.key] ?? ""}
                        onChange={(event) =>
                          setVals((current) => ({
                            ...current,
                            [field.key]: event.currentTarget.value,
                          }))
                        }
                        placeholder={
                          isSaved && field.secret
                            ? "•••••••• (stockée dans le coffre système)"
                            : field.placeholder
                        }
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {field.secret && (
                        <button
                          type="button"
                          onClick={() =>
                            setReveal((current) => ({
                              ...current,
                              [field.key]: !current[field.key],
                            }))
                          }
                          title={reveal[field.key] ? "Masquer" : "Afficher"}
                        >
                          <Icon name={reveal[field.key] ? "x" : "search"} size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {discoveryError && status === "configured" && (
            <details className="conn-issue">
              <summary>{friendlyConnectionIssue(discoveryError, c.id)}</summary>
              <code>{discoveryError}</code>
            </details>
          )}

          {c.id === "llamacpp" && (
            <div className="conn-local-runtime">
              <div className="conn-subhead">
                <span>Serveur local</span>
                <small>Contrôles avancés llama.cpp</small>
              </div>
              <LlamaServerControls
                savedHfModel={saved.hfModel ?? ""}
                savedBinary={saved.binary ?? ""}
                savedCtx={saved.ctx ?? ""}
                savedChatTemplate={saved.chatTemplate ?? ""}
              />
            </div>
          )}

          <div className="conn-actions">
            <button
              className="lgb lgb-sm lgb-primary"
              onClick={onSave}
              disabled={!isDirty || savingState === "saving" || status === "loading"}
              title={isDirty ? "Enregistrer les changements" : "Aucun changement"}
            >
              <Icon name="sparkle" size={11} />
              {savingState === "saving"
                ? "Enregistrement…"
                : savingState === "saved"
                  ? "Enregistré ✓"
                  : "Enregistrer"}
            </button>
            {status === "configured" && (
              <button
                className="lgb lgb-sm"
                onClick={onDisconnect}
                disabled={savingState === "saving"}
              >
                Déconnecter
              </button>
            )}
            <span className="conn-actions-spacer" />
            {savingState === "error" && (
              <span className="conn-save-error" title={errorMsg ?? ""}>
                Échec de l’enregistrement
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── llama-server lifecycle controls (rendered inside the llama.cpp ConnCard) ──
//
// Reads the SAVED hfModel + binary fields (not the live edited drafts) so the
// Start button does what the user actually committed in Settings. Polls the
// Rust llama_status command every 2s to keep its "running / stopped" pill in
// sync with reality — that way if llama-server crashes externally or the user
// killed it from a terminal, the UI catches up within a couple of seconds.
//
// Restart is implicit in Start: the Rust command always kills any previous
// child before spawning a new one, so the user just changes hfModel in the
// inputs, hits Save, then hits Start and the new model is what's running.

interface LlamaStatus {
  running: boolean;
  pid: number | null;
  binary: string | null;
}

// Poll a local llama-server's /v1/models endpoint until it responds 200 (or
// until we run out of patience). llama-server's HTTP listener comes up
// before the model is actually loaded — and chat requests against a
// not-yet-loaded server hang — so /v1/models is the better readiness
// probe than mere TCP connectivity.
async function waitForLlamaReady(baseUrl: string, timeoutMs = 90_000, intervalMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl.replace(/\/+$/, "") + "/v1/models");
      if (r.ok) return;
    } catch {
      // Network unreachable / connection refused → server still booting.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error(`llama-server didn't become ready within ${Math.round(timeoutMs / 1000)}s`);
}

interface BackendInfo {
  vulkanAvailable: boolean;
  autoPick: "cpu" | "vulkan";
}

type BackendChoice = "auto" | "cpu" | "vulkan";
const BACKEND_SETTING_KEY = "backend"; // stored under provider.llamacpp.backend
const THINKING_SETTING_KEY = "enableThinking"; // stored under provider.llamacpp.enableThinking

function isBackendChoice(s: string | null): s is BackendChoice {
  return s === "auto" || s === "cpu" || s === "vulkan";
}

function LlamaServerControls({
  savedHfModel,
  savedBinary,
  savedCtx,
  savedChatTemplate,
}: {
  savedHfModel: string;
  savedBinary: string;
  savedCtx: string;
  savedChatTemplate: string;
}) {
  const [status, setStatus] = useState<LlamaStatus>({ running: false, pid: null, binary: null });
  const [busy, setBusy] = useState<"idle" | "starting" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);
  const [backendInfo, setBackendInfo] = useState<BackendInfo | null>(null);
  // User's preferred backend. "auto" honours the auto-detect result; the
  // explicit "cpu"/"vulkan" choices force the matching sidecar even on a
  // mismatched machine (e.g. force CPU on a Vulkan-capable box to A/B test
  // the perf delta — the whole point of the dual bundle).
  const [backendChoice, setBackendChoice] = useState<BackendChoice>("auto");
  // Thinking-mode router for the model's `<think>` prefix (Qwen 3.5,
  // DeepSeek-R1, …). Three values:
  //   "auto" = heuristic per-message (default — casual chat skips think,
  //            reasoning-flavoured prompts get it). See thinkingHeuristic.ts.
  //   "on"   = force thinking every time (model's untouched default).
  //   "off"  = never think, direct answers only.
  // Persisted under provider.llamacpp.enableThinking. Legacy "true"/"false"
  // values are parsed back as "on"/"off" by parseThinkingMode.
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("auto");

  // One-shot backend probe at mount: lets us show "Vulkan ✓" or "CPU only"
  // in the card so the user understands which backend will be used. The
  // result never changes for the lifetime of the process (Vulkan loader
  // presence is a system-level fact), so no polling.
  useEffect(() => {
    let cancelled = false;
    void invoke<BackendInfo>("llama_backend_info")
      .then((info) => { if (!cancelled) setBackendInfo(info); })
      .catch((err) => console.warn("[llama] backend_info failed", err));
    // Restore the user's previously-saved backend choice (if any). Stored
    // alongside the rest of the llamacpp config under `provider.llamacpp.backend`.
    void getConfig("llamacpp", BACKEND_SETTING_KEY).then((v) => {
      if (cancelled) return;
      if (isBackendChoice(v)) setBackendChoice(v);
    });
    // Restore the thinking-mode router choice. Stored values: "auto" /
    // "on" / "off" (modern) or legacy "true" / "false" (compat — both
    // forms parsed by parseThinkingMode). Null/missing → "auto".
    void getConfig("llamacpp", THINKING_SETTING_KEY).then((v) => {
      if (cancelled) return;
      setThinkingMode(parseThinkingMode(v));
    });
    return () => { cancelled = true; };
  }, []);

  const updateBackend = async (next: BackendChoice) => {
    setBackendChoice(next);
    try { await setConfig("llamacpp", BACKEND_SETTING_KEY, next); }
    catch (err) { console.warn("[llama] persist backend choice failed", err); }
  };

  const updateThinking = async (next: ThinkingMode) => {
    setThinkingMode(next);
    try { await setConfig("llamacpp", THINKING_SETTING_KEY, serializeThinkingMode(next)); }
    catch (err) { console.warn("[llama] persist thinking mode failed", err); }
  };

  // Initial fetch + 2s polling so the pill reflects reality even if
  // llama-server crashed or was killed externally.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await invoke<LlamaStatus>("llama_status");
        if (!cancelled) setStatus(s);
      } catch (err) {
        if (!cancelled) console.warn("[llama] status failed", err);
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const start = async () => {
    // Resolve which model to load:
    //   1) saved hfModel (`-hf user/repo:quant`)  — wins if non-empty
    //   2) bundled GGUF on disk (`-m <path>`)     — fallback so the boot-
    //      autostarted Qwen can be restarted from this card with a
    //      different backend, without forcing the user to first type an
    //      hfModel into the form
    const invokeArgs: Record<string, unknown> = {
      binary: savedBinary || null,
      backend: backendChoice,
    };
    const modelName = savedHfModel.toLowerCase();
    const parsedCtx = savedCtx.trim()
      ? Number.parseInt(savedCtx.trim(), 10)
      : modelName.includes("mistral")
        ? 32_768
        : 16_384;
    if (!Number.isFinite(parsedCtx) || parsedCtx < 2_048 || parsedCtx > 2_000_000) {
      setError("Contexte invalide : utilise un entier entre 2048 et 2000000 tokens.");
      return;
    }
    invokeArgs.ctx = parsedCtx;
    invokeArgs.chatTemplate = savedChatTemplate.trim() || null;
    if (savedHfModel) {
      invokeArgs.hfModel = savedHfModel;
    } else {
      // Look for any installed bundle model. If none, surface the same
      // helpful error as before — we genuinely have nothing to load.
      const installed = await getInstalledIds().catch(() => [] as string[]);
      if (installed.length === 0) {
        setError("Aucun modèle à charger : renseigne 'Modèle HuggingFace' puis Save, ou installe un bundle via l'onboarding.");
        return;
      }
      try {
        invokeArgs.modelPath = await getModelPath(installed[0]);
      } catch (err) {
        setError(`Impossible de résoudre le chemin du modèle bundlé: ${err}`);
        return;
      }
    }

    setBusy("starting");
    setError(null);
    try {
      const s = await invoke<LlamaStatus>("llama_start", invokeArgs);
      setStatus(s);
      // Boot can take 15–60s (model download on first run, weight load on
      // subsequent runs). Poll the server's /v1/models until it returns 200
      // then invalidate discovery so every window (main + chibi) picks up
      // the new model instantly. Stays in "starting" UI state until the
      // server is actually serving — much closer to the real readiness
      // than the immediate `running:true` from the spawn return value.
      await waitForLlamaReady("http://127.0.0.1:8090");
      await invalidateDiscovery();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("idle");
    }
  };

  const stop = async () => {
    setBusy("stopping");
    setError(null);
    try {
      const s = await invoke<LlamaStatus>("llama_stop");
      setStatus(s);
      // Trigger a discovery refresh so the picker drops the now-unreachable
      // llama.cpp models. Without this, the picker would keep showing them
      // until the next 60s TTL roll.
      await invalidateDiscovery();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("idle");
    }
  };

  // Used when llama_status reports running with pid==null — there's a
  // server we don't own (orphan from a previous session, another tool…).
  // The Rust side runs `taskkill /F /IM llama-server.exe` (Windows) /
  // `pkill -f llama-server` (Unix) which is blunt by design: we trade
  // collateral risk for a one-button cleanup.
  const forceStopExternal = async () => {
    setBusy("stopping");
    setError(null);
    try {
      const s = await invoke<LlamaStatus>("llama_force_stop_external");
      setStatus(s);
      await invalidateDiscovery();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("idle");
    }
  };

  // running + no pid = HTTP probe found a server we didn't spawn (terminal,
  // leftover from previous session, other tool). We can't kill it, and
  // Restart would conflict on port 8090 — guard the UI accordingly.
  const isDetached = status.running && status.pid == null;

  return (
    <div style={{
      margin: "8px 0",
      padding: 10,
      borderRadius: 8,
      background: "rgba(124, 58, 237, 0.06)",
      border: "1px solid rgba(124, 58, 237, 0.22)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          padding: "2px 8px",
          borderRadius: 99,
          background: status.running ? "rgba(74, 222, 128, 0.18)" : "rgba(150, 150, 150, 0.18)",
          color: status.running ? "var(--success, #4ade80)" : "var(--on-surface-muted, #999)",
        }}>
          {status.running ? "● Server running" : "○ Server stopped"}
        </span>
        {status.running && status.pid != null && (
          <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }}>pid {status.pid}</span>
        )}
        {isDetached && (
          <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }} title="Detected via HTTP probe — not spawned by Shugu">
            external
          </span>
        )}
      </div>
      {/* Backend selector — Auto (=auto-detected at boot), CPU, or Vulkan.
          The choice is persisted under provider.llamacpp.backend so a restart
          honours it. Switching here does NOT auto-restart the server — the
          user clicks Start/Restart below to apply the change. This is
          deliberate: comparing CPU vs Vulkan perf is the whole point of
          having the selector, and a hidden auto-restart on every click
          would tear down a running benchmark mid-token. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: "var(--on-surface-muted)" }}>Backend:</span>
        {([
          { v: "auto",   label: backendInfo ? `Auto (${backendInfo.autoPick})` : "Auto",
            title: "Use the auto-detected backend (Vulkan if a Vulkan loader is present, else CPU)." },
          { v: "cpu",    label: "CPU",
            title: "Force the CPU-only sidecar. Useful to A/B benchmark against Vulkan, or to debug GPU-driver flakiness." },
          { v: "vulkan", label: "Vulkan",
            title: backendInfo?.vulkanAvailable
              ? "Force the Vulkan sidecar. 5-10× faster on any GPU/iGPU made since 2017."
              : "Vulkan loader (vulkan-1.dll) not found on this machine — this option will fall back to CPU at spawn." },
        ] as const).map((opt) => (
          <button
            key={opt.v}
            onClick={() => void updateBackend(opt.v)}
            title={opt.title}
            disabled={opt.v === "vulkan" && backendInfo != null && !backendInfo.vulkanAvailable}
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              border: backendChoice === opt.v ? "1px solid var(--primary, #7c3aed)" : "1px solid rgba(150,150,150,0.25)",
              background: backendChoice === opt.v ? "rgba(124, 58, 237, 0.18)" : "transparent",
              color: backendChoice === opt.v ? "var(--primary, #7c3aed)" : "var(--on-surface-muted)",
              fontSize: 11,
              cursor: "pointer",
              fontWeight: backendChoice === opt.v ? 600 : 400,
            }}
          >
            {opt.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }} title="Click Start/Restart below to apply backend change">
          {status.running && backendChoice !== "auto" ? "↻ click Restart to apply" : ""}
        </span>
      </div>
      {/* Thinking-mode router. Auto runs a per-message heuristic
          (thinkingHeuristic.ts): casual prompts skip <think>, reasoning-
          flavoured ones get it. On / Off bypass the heuristic for explicit
          control — useful when you know you want fast answers (e.g. quick
          factual chat) or full reasoning (e.g. debugging). Applied per-
          request via chat_template_kwargs.enable_thinking; no server
          restart needed. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: "var(--on-surface-muted)" }}>Thinking:</span>
        {([
          { v: "auto", label: "Auto",
            title: "Heuristique par message : « merci » répond direct, « explique-moi X » active le raisonnement. Recommandé." },
          { v: "on",   label: "Always on",
            title: "Force le bloc <think> sur chaque message. Plus lent, qualité maximale (Qwen 3.5 default)." },
          { v: "off",  label: "Always off",
            title: "Désactive le raisonnement systématiquement. Réponses directes, plus rapides, qualité dégradée sur tâches complexes." },
        ] as const).map((opt) => (
          <button
            key={opt.v}
            onClick={() => void updateThinking(opt.v)}
            title={opt.title}
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              border: thinkingMode === opt.v ? "1px solid var(--primary, #7c3aed)" : "1px solid rgba(150,150,150,0.25)",
              background: thinkingMode === opt.v ? "rgba(124, 58, 237, 0.18)" : "transparent",
              color: thinkingMode === opt.v ? "var(--primary, #7c3aed)" : "var(--on-surface-muted)",
              fontSize: 11,
              cursor: "pointer",
              fontWeight: thinkingMode === opt.v ? 600 : 400,
            }}
          >
            {opt.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }}>
          {thinkingMode === "auto" ? "router per-message"
            : thinkingMode === "on" ? "force reasoning"
            : "force direct"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="lgb lgb-sm lgb-primary"
          onClick={start}
          disabled={busy !== "idle" || isDetached}
          title={
            isDetached
              ? "Another llama-server is already on port 8090 — stop it from where you started it before restarting from here"
              : (status.running ? "Restart with the currently-saved model" : "Start llama-server with the saved model")
          }
        >
          {busy === "starting" ? "Starting…" : status.running ? "Restart" : "Start server"}
        </button>
        {status.running && status.pid != null && (
          <button className="lgb lgb-sm" onClick={stop} disabled={busy !== "idle"}>
            {busy === "stopping" ? "Stopping…" : "Stop"}
          </button>
        )}
        {isDetached && (
          <button
            className="lgb lgb-sm"
            onClick={forceStopExternal}
            disabled={busy !== "idle"}
            title="Force-kills every llama-server.exe on the system (taskkill /F /IM). Use this to clear an orphan from a previous Shugu session whose cleanup hook didn't fire."
          >
            {busy === "stopping" ? "Stopping…" : "Force stop external"}
          </button>
        )}
        <span style={{ flex: 1 }}/>
        {backendInfo && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 99,
              background: backendInfo.autoPick === "vulkan"
                ? "rgba(74, 222, 128, 0.18)"
                : "rgba(150, 150, 150, 0.18)",
              color: backendInfo.autoPick === "vulkan"
                ? "var(--success, #4ade80)"
                : "var(--on-surface-muted, #999)",
            }}
            title={backendInfo.vulkanAvailable
              ? "Vulkan loader detected — GPU-accelerated build will be used (-ngl 99)"
              : "No Vulkan loader on this machine — CPU build will be used"}
          >
            {backendInfo.autoPick === "vulkan" ? "GPU · Vulkan" : "CPU only"}
          </span>
        )}
        {(() => {
          // Resolve the effective backend that the NEXT Start/Restart will use.
          // `auto` → whatever vulkan_available() returned at probe time.
          // `cpu`/`vulkan` → the explicit user choice.
          const effective = backendChoice === "auto"
            ? backendInfo?.autoPick
            : backendChoice;
          const ngl = effective === "vulkan" ? "99" : "0";
          return (
            <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }}>
              flags: -c 4096 -ngl {ngl} -fit off --parallel 1 --cache-ram 0 --mlock
            </span>
          );
        })()}
      </div>
      {error && (
        <div style={{
          marginTop: 8,
          padding: "6px 8px",
          borderRadius: 6,
          background: "rgba(255, 107, 107, 0.08)",
          border: "1px solid rgba(255, 107, 107, 0.25)",
          fontSize: 11,
          color: "var(--error, #ff6b6b)",
        }}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// RoutingSection — Phase 1 routing configuration
// ────────────────────────────────────────────────────────────────────
//
// Three persisted settings (all in db.settings, not the OS keychain
// since these are not secrets):
//
//   - routing.chatModel          : the mascot's voice (default empty →
//                                  the existing chat path uses the
//                                  per-conversation activeModel anyway,
//                                  so this is informational for now;
//                                  Phase 2 will tie it to a per-conv
//                                  fallback)
//   - routing.orchestratorModel  : the delegated executor. When empty,
//                                  the heuristic still classifies but
//                                  handleDelegate fails over to a CTA.
//   - routing.delegateOverride   : "always-delegate" / "never-delegate"
//                                  / "" (auto). Overrides the regex
//                                  heuristic in routingHeuristic.ts.
//
// Llamacpp models are filtered OUT of the orchestrator picker — see Q1
// of the Phase 1 blueprint: llama-server is single-model and the binary
// is the one the user launched, so configuring a different llamacpp
// model as the orchestrator is meaningless. Future Phase 2 will support
// spawning a second llama-server on a different port for multi-model.

function RoutingSection() {
  const { data: models } = useDiscoveredModels();
  const [expanded, setExpanded] = useState(false);
  const [chatModel, setChatModel] = useState<string>("");
  const [orchModel, setOrchModel] = useState<string>("");
  const [advisorModel, setAdvisorModel] = useState<string>("");
  const [override, setOverride] = useState<string>("");
  // Revue automatique du LIVRABLE (S1 → leçons). Défaut ON : l'utilisateur l'a
  // demandé, et le gate complexité empêche de tirer sur le trivial. (S2 — revue
  // de plan post-hoc — retiré 2026-06-14 : l'outil `advisor` in-loop la couvre.)
  const [supervise, setSupervise] = useState<boolean>(true);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [c, o, adv, ov, sv] = await Promise.all([
        db.settings.get("routing.chatModel"),
        db.settings.get("routing.orchestratorModel"),
        db.settings.get("routing.advisorModel"),
        db.settings.get("routing.delegateOverride"),
        db.settings.get("routing.superviseComplex"),
      ]);
      if (cancelled) return;
      setChatModel(c ?? "");
      setOrchModel(o ?? "");
      setAdvisorModel(adv ?? "");
      setOverride(ov ?? "");
      setSupervise(sv == null ? true : sv === "true");
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSavingState("saving");
    try {
      await db.settings.set("routing.chatModel", chatModel);
      await db.settings.set("routing.orchestratorModel", orchModel);
      await db.settings.set("routing.advisorModel", advisorModel);
      await db.settings.set("routing.delegateOverride", override);
      await db.settings.set("routing.superviseComplex", supervise ? "true" : "false");
      setSavingState("saved");
      window.setTimeout(() => setSavingState("idle"), 1500);
    } catch (err) {
      console.warn("[routing] save failed", err);
      setSavingState("idle");
    }
  };

  // The orchestrator picker excludes llamacpp models. The chat picker
  // accepts everything (llamacpp included — that's the mascot's natural
  // home: a local fast small model).
  const orchModels = models.filter((m) => m.providerId !== "llamacpp");

  return (
    <section className={`routing-panel${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="routing-panel-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="routing-panel-icon"><Icon name="branch" size={15} /></span>
        <span>
          <strong>Routage avancé</strong>
          <small>Chat, orchestrateur et reviewer</small>
        </span>
        <span className="routing-panel-summary">
          {orchModel ? "Personnalisé" : "Automatique"}
        </span>
        <Icon name="down" size={13} className="routing-panel-chevron" />
      </button>
      {expanded && (
      <div className="routing-panel-body">
      <h3>Routage</h3>
      <p className="sub">
        Sépare le modèle qui parle de celui qui exécute. Les messages courts /
        casuels passent par le <b>chat model</b> (rapide, local). Les tâches
        de dev / file ops / recherche sont déléguées à l'<b>orchestrator</b>
        (plus capable, distant) et sa réponse est relayée verbatim dans le chat.
        <br />
        Le routing se base sur une heuristique regex (0 token) — tu peux la
        forcer via l'override ci-dessous.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14, maxWidth: 640 }}>
        <div className="conn-field">
          <label>Chat model (mascotte)</label>
          <div className="input">
            <select
              value={chatModel}
              onChange={(e) => setChatModel(e.currentTarget.value)}
              style={{ width: "100%", background: "transparent", border: "none", color: "inherit", fontFamily: "inherit", fontSize: "inherit" }}
            >
              <option value="">Auto (laisse le ModelPicker du chat décider)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.providerLabel} · {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="conn-field">
          <label>Orchestrator model (tâches dev / recherche)</label>
          <div className="input">
            <select
              value={orchModel}
              onChange={(e) => setOrchModel(e.currentTarget.value)}
              style={{ width: "100%", background: "transparent", border: "none", color: "inherit", fontFamily: "inherit", fontSize: "inherit" }}
            >
              <option value="">— Choisir un modèle —</option>
              {orchModels.length === 0 && (
                <option value="" disabled>
                  (aucun provider non-llamacpp configuré — ajoute Anthropic, OpenCode, ou un Custom)
                </option>
              )}
              {orchModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.providerLabel} · {m.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--on-surface-muted)", marginTop: 4 }}>
            Suggestions : Claude Sonnet (Anthropic), OpenCode local ({" "}
            <code>http://localhost:PORT/zen/v1</code> ), OpenAI Codex (CLI shell-out — Phase 2).
            Les modèles llamacpp sont exclus — le serveur local ne charge qu'un
            modèle à la fois.
          </div>
        </div>

        <div className="conn-field">
          <label>Modèle de l'advisor (reviewer/skills)</label>
          <div className="input">
            <select
              value={advisorModel}
              onChange={(e) => setAdvisorModel(e.currentTarget.value)}
              style={{ width: "100%", background: "transparent", border: "none", color: "inherit", fontFamily: "inherit", fontSize: "inherit" }}
            >
              <option value="">— Choisir un modèle —</option>
              {orchModels.length === 0 && (
                <option value="" disabled>
                  (aucun provider non-llamacpp configuré — ajoute Anthropic, OpenCode, ou un Custom)
                </option>
              )}
              {orchModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.providerLabel} · {m.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--on-surface-muted)", marginTop: 4 }}>
            Le modèle FORT qui critique et distille les skills. Prends ton meilleur.
            Prend la priorité sur le modèle épinglé dans le fichier <code>reviewer-gpt.md</code>.
            Laisse vide pour utiliser le modèle du reviewer par défaut.
          </div>
        </div>

        <div className="conn-field">
          <label>Override</label>
          <div className="input">
            <select
              value={override}
              onChange={(e) => setOverride(e.currentTarget.value)}
              style={{ width: "100%", background: "transparent", border: "none", color: "inherit", fontFamily: "inherit", fontSize: "inherit" }}
            >
              <option value="">Auto (heuristique regex)</option>
              <option value="always-delegate">Always delegate (orchestrator pour chaque message)</option>
              <option value="never-delegate">Never delegate (chat model seul)</option>
            </select>
          </div>
        </div>

        <div className="conn-field">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={supervise}
              onChange={(e) => setSupervise(e.currentTarget.checked)}
            />
            Reviewer automatique sur les tâches complexes
          </label>
          <div style={{ fontSize: 11, color: "var(--on-surface-muted)", marginTop: 4 }}>
            Un agent reviewer relit le <b>plan</b> (avant exécution) et le <b>livrable</b>{" "}
            (après) des tâches jugées complexes — seuil adapté au modèle (plus bas pour un
            petit modèle, qui en a le plus besoin). La revue est stockée en local.{" "}
            ⚠ Coût : jusqu'à 3 appels LLM supplémentaires par tâche complexe (plan, revue
            du plan, revue du livrable), facturés via la clé du reviewer
            {" "}(par défaut <code>reviewer-gpt</code> → OpenAI). Max 2 supervisions en parallèle.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="lgb lgb-sm lgb-primary" onClick={() => void save()} disabled={savingState === "saving"}>
            <Icon name="sparkle" size={11} /> {savingState === "saving" ? "Saving…" : savingState === "saved" ? "Saved ✓" : "Save routing"}
          </button>
        </div>
      </div>
      </div>
      )}
    </section>
  );
}

// ProfileView — moved to its own module. Re-exported for views-code.tsx.
