// Shugu Forge — Connections page (Settings → Connections).
//
// Provider catalog (AI / dev tools / image / storage cards), wizard for
// adding custom providers, and per-card editor (api key field, baseUrl
// override, enabled toggle). All secrets/configs are written through the
// credentials backend (OS keychain in Tauri); discovery is invalidated on
// any save so the ModelPicker picks up the new key on the next read.

import { useState, useEffect } from "react";
import { Icon } from "@/components/components";
import { invoke } from "@/lib/tauri";
import {
  getProviderField,
  setProviderField,
  clearProviderConfig,
  setProviderEnabled,
} from "@/lib/credentials";
import { invalidateDiscovery, useDiscoveryStore } from "@/lib/modelDiscovery";
import { db } from "@/lib/db";

// Storage key for the persisted list of user-added custom providers. JSON-encoded
// array of ConnCardData rows (display metadata only — secrets/configs live in
// their respective backends keyed by `provider.<id>.*`).
const CUSTOM_PROVIDERS_KEY = "connections.customProviders.v1";

export function ConnectionsView() {
  const [tab, setTab] = useState("models");
  const [customModels, setCustomModels] = useState<ConnCardData[]>([]);
  const [adding, setAdding] = useState(false);

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
    { v: "tools",     l: "Dev tools" },
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
      { id: "anthropic", name: "Anthropic", meta: "Claude / Shugu models", logo: "A", color: "#d97757", fields: [
        { label: "API key", key: "apiKey", placeholder: "sk-ant-…", secret: true },
      ]},
      { id: "openai", name: "OpenAI", meta: "GPT-4o, o1, embeddings", logo: "O", color: "#10a37f", fields: [
        { label: "API key", key: "apiKey", placeholder: "sk-…", secret: true },
        { label: "Org ID",  key: "orgId",  placeholder: "org-…", secret: false },
      ]},
      { id: "ollama", name: "Ollama", meta: "Local model server", logo: "O", color: "#000", fields: [
        { label: "Endpoint", key: "baseUrl", placeholder: "http://localhost:11434", secret: false },
      ]},
      { id: "llamacpp", name: "llama.cpp", meta: "Local OpenAI-compatible server (gguf models)", logo: "L", color: "#7c3aed", fields: [
        { label: "Endpoint", key: "baseUrl", placeholder: "http://localhost:8080", secret: false },
        // HF repo:quant fed to `llama-server -hf …`. Ex: HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q5_K_P
        { label: "Modèle HuggingFace (repo:quant)", key: "hfModel", placeholder: "user/repo:Q5_K_P", secret: false },
        // Optional path to llama-server.exe. If empty we resolve from PATH
        // (winget install puts it there) then fall back to Docker Desktop's
        // bundled binary at ~/.docker/bin/inference/llama-server.exe.
        { label: "Binary (optionnel)", key: "binary", placeholder: "auto-détecté depuis le PATH", secret: false },
        { label: "API key (optional)", key: "apiKey", placeholder: "leave empty unless --api-key was set", secret: true },
      ]},
      { id: "mistral", name: "Mistral", meta: "European open-weights", logo: "M", color: "#ff7000", fields: [
        { label: "API key", key: "apiKey", placeholder: "…", secret: true },
      ]},
      { id: "groq", name: "Groq", meta: "Fast LPU inference", logo: "G", color: "#f55036", fields: [
        { label: "API key", key: "apiKey", placeholder: "gsk_…", secret: true },
      ]},
    ],
    tools: [
      { id: "github", name: "GitHub", meta: "Repos, PRs, issues", logo: "G", color: "#24292f", fields: [
        { label: "Personal token", key: "apiKey", placeholder: "ghp_…", secret: true },
      ]},
      { id: "gitlab", name: "GitLab", meta: "Repos & CI", logo: "G", color: "#fc6d26", fields: [
        { label: "Token", key: "apiKey", placeholder: "glpat-…", secret: true },
        { label: "Host",  key: "baseUrl", placeholder: "https://gitlab.com", secret: false },
      ]},
      { id: "linear", name: "Linear", meta: "Issues & projects", logo: "L", color: "#5e6ad2", fields: [
        { label: "API key", key: "apiKey", placeholder: "lin_api_…", secret: true },
      ]},
      { id: "vercel", name: "Vercel", meta: "Deploy from Forge", logo: "▲", color: "#000", fields: [
        { label: "Token", key: "apiKey", placeholder: "…", secret: true },
      ]},
      { id: "docker", name: "Docker", meta: "Local daemon", logo: "D", color: "#2496ed", fields: [
        { label: "Socket", key: "endpoint", placeholder: "/var/run/docker.sock", secret: false },
      ]},
    ],
    image: [
      { id: "replicate", name: "Replicate", meta: "flux.1, sdxl, hosted models", logo: "R", color: "#fff", fields: [
        { label: "API token", key: "apiKey", placeholder: "r8_…", secret: true },
      ]},
      { id: "stability", name: "Stability AI", meta: "SDXL turbo, SD3", logo: "S", color: "#9b51e0", fields: [
        { label: "Key", key: "apiKey", placeholder: "sk-…", secret: true },
      ]},
      { id: "modal", name: "Modal", meta: "Custom inference functions", logo: "M", color: "#7ee787", fields: [
        { label: "Token", key: "apiKey", placeholder: "…", secret: true },
      ]},
    ],
    storage: [
      { id: "drive",  name: "Google Drive",  meta: "Sync generations & projects", logo: "D", color: "#4285f4", fields: [] },
      { id: "s3", name: "S3-compatible", meta: "Self-hosted bucket", logo: "S", color: "#ff9900", fields: [
        { label: "Endpoint", key: "endpoint", placeholder: "s3.example.com", secret: false },
        { label: "Key ID",   key: "orgId",    placeholder: "AKIA…",         secret: false },
        { label: "Secret",   key: "apiKey",   placeholder: "…",              secret: true  },
      ]},
      { id: "icloud", name: "iCloud Drive", meta: "macOS only", logo: "i", color: "#007aff", fields: [] },
    ],
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Connections</h3>
          <p className="sub">Branche tes outils externes. Les clés API sont stockées dans le keychain natif de l'OS (Windows Credential Manager, macOS Keychain, Linux Secret Service). Les endpoints et IDs non-secrets vont dans la base SQLite locale.</p>
          <div className="conn-tabs">
            {tabs.map(t => (
              <button key={t.v} className={"conn-tab-btn" + (tab === t.v ? " on" : "")} onClick={() => setTab(t.v)}>{t.l}</button>
            ))}
          </div>
          <div className="connections-grid">
            {(cards[tab] || []).map((c: any) => <ConnCard key={c.id} c={c}/>)}
            {tab === "models" && customModels.map((c: any) => <ConnCard key={c.id} c={c}/>)}
            {tab === "models" && (
              <div className="conn-add-card" onClick={() => setAdding(true)}>
                <span className="plus"><Icon name="plus" size={18}/></span>
                <div className="t">Add custom provider</div>
                <div className="s">OpenAI-compatible endpoint, vLLM, LM Studio, Together AI, custom router…</div>
              </div>
            )}
          </div>
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
  // `kind` here doubles as the protocol the chat dispatcher will use. We keep
  // anthropic/openai/ollama/custom in lockstep with the Rust `chat_send` match
  // arms so a user-defined provider can immediately participate in chat.
  const [kind, setKind] = useState("openai");
  // For OpenAI-compat and Ollama, leaving the API key empty is fine (local
  // servers often don't require one). We only require name + endpoint.
  const ok = name && endpoint;
  const submit = async () => {
    if (!ok) return;
    const id = "custom-" + Date.now();
    // Persist credentials immediately so the ConnCard that's about to render
    // finds them on its initial load instead of starting empty.
    if (endpoint) await setProviderField(id, "baseUrl", endpoint, false);
    if (key)      await setProviderField(id, "apiKey",  key,      true);
    if (model)    await setProviderField(id, "defaultModel", model, false);
    await setProviderField(id, "protocol", kind, false);
    void invalidateDiscovery();
    const card: ConnCardData = {
      id,
      name,
      meta: kind + " · " + (model || "auto"),
      logo: name[0]?.toUpperCase() || "?",
      color: "#5063c5",
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
      <div className="palette" style={{width: "min(540px, 90%)", padding: 0}}>
        <div style={{padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)"}}>
          <div style={{fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15}}>Add custom provider</div>
          <div style={{fontSize: 12, color: "var(--on-surface-variant)", marginTop: 4}}>
            Any OpenAI-compatible endpoint works (LM Studio, vLLM, Together, Fireworks, OpenRouter…).
          </div>
        </div>
        <div style={{padding: 18, display: "flex", flexDirection: "column", gap: 12}}>
          <div className="conn-field">
            <label>Display name</label>
            <div className="input"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. OpenRouter, My LM Studio…" autoFocus/></div>
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
            <div className="input"><input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></div>
          </div>
          <div className="conn-field">
            <label>API key</label>
            <div className="input"><input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…"/></div>
          </div>
          <div className="conn-field">
            <label>Default model (optional)</label>
            <div className="input"><input value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini, llama-3.3-70b, claude-3-5-sonnet…"/></div>
          </div>
        </div>
        <div style={{padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 8}}>
          <button className="lgb" onClick={onClose}>Cancel</button>
          <span style={{flex:1}}></span>
          <button className="lgb"><Icon name="thumbs" size={11}/> Test connection</button>
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
  fields: ConnField[];
}

type ConnStatus = "loading" | "connected" | "disconnected";

export function ConnCard({ c }: { c: ConnCardData }) {
  // `vals` is the live edited state. `saved` mirrors what's actually persisted
  // and is used to drive the "dirty" indicator + decide whether the Save
  // button has work to do. Both are keyed by `field.key`, not by label.
  const [vals, setVals]   = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<ConnStatus>("loading");
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Subscribe to discovery errors so a 401 from "save invalid key" actually
  // appears ON the card, not just hidden inside the picker popover.
  const discoveryError = useDiscoveryStore((s) => s.errors[c.id] ?? null);
  const discoveredCount = useDiscoveryStore((s) => s.models.filter((m) => m.providerId === c.id).length);

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
      setStatus(Object.keys(initial).length > 0 ? "connected" : "disconnected");
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
      setStatus(anyValue ? "connected" : "disconnected");
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

  // The pill shows a more informative status when we have discovery data:
  //   "connected · 4 models" when the discovery returned models for this provider,
  //   "saved · ⚠ error"      when a config is saved but the discovery failed,
  //   "connected"            when saved but discovery hasn't run yet,
  //   "disconnected" / "loading…" otherwise.
  const statusLabel: string = status === "loading"
    ? "loading…"
    : status === "connected"
      ? (discoveryError
          ? "saved · check error"
          : discoveredCount > 0
            ? `connected · ${discoveredCount} model${discoveredCount > 1 ? "s" : ""}`
            : "saved")
      : "disconnected";

  return (
    <div className={"conn-card " + (status === "connected" ? "connected" : "")}>
      <div className="conn-head">
        <div className="conn-logo" style={{background: c.color, color: c.color === "#000" || c.color === "#24292f" ? "white" : "rgba(0,0,0,0.7)"}}>{c.logo}</div>
        <div className="conn-info">
          <div className="conn-name">{c.name}</div>
          <div className="conn-meta">{c.meta}</div>
        </div>
        <span className={"conn-status " + status}>{statusLabel}</span>
      </div>
      {c.fields.length > 0 && c.fields.map((f) => {
        // Has a real persisted value (different from the empty default)?
        const isSaved = (saved[f.key] ?? "") !== "";
        return (
          <div key={f.key} className="conn-field">
            <label>
              {f.label}
              {isSaved && (
                <span style={{
                  marginLeft: 8,
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--success, #4ade80)",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}>✓ saved</span>
              )}
            </label>
            <div className="input">
              <input
                type={f.secret && !reveal[f.key] ? "password" : "text"}
                value={vals[f.key] ?? ""}
                onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
                // When a secret is already persisted, the input still shows
                // dots (type=password) for the current value, but if the
                // user starts typing replacement they get a clear placeholder.
                // We keep the original placeholder for not-yet-saved fields.
                placeholder={isSaved && f.secret ? "•••••••• (stored — click Reveal to show)" : f.placeholder}
                spellCheck={false}
                autoComplete="off"
              />
              {f.secret && (
                <button onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))} title={reveal[f.key] ? "Hide" : "Show"}>
                  <Icon name={reveal[f.key] ? "x" : "search"} size={12}/>
                </button>
              )}
            </div>
          </div>
        );
      })}
      {discoveryError && status === "connected" && (
        // Surface the upstream error (most often 401 from a fake key, or
        // connection refused from a server that's down) right on the card,
        // not just hidden in the model picker.
        <div style={{
          margin: "6px 0",
          padding: "8px 10px",
          borderRadius: 6,
          background: "rgba(255, 107, 107, 0.08)",
          border: "1px solid rgba(255, 107, 107, 0.25)",
          fontSize: 11,
          color: "var(--error, #ff6b6b)",
          lineHeight: 1.4,
        }}>
          ⚠ Le provider est saved mais la liste des modèles a échoué&nbsp;: <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 4px", borderRadius: 3 }}>{discoveryError}</code>
        </div>
      )}
      {c.id === "llamacpp" && (
        <LlamaServerControls savedHfModel={saved.hfModel ?? ""} savedBinary={saved.binary ?? ""}/>
      )}
      <div className="conn-actions">
        <button
          className="lgb lgb-sm lgb-primary"
          onClick={onSave}
          disabled={!isDirty || savingState === "saving" || status === "loading"}
          title={isDirty ? "Save changes" : "Nothing to save"}
        >
          <Icon name="sparkle" size={11}/> {savingState === "saving" ? "Saving…" : savingState === "saved" ? "Saved ✓" : "Save"}
        </button>
        {status === "connected" && (
          <button className="lgb lgb-sm" onClick={onDisconnect} disabled={savingState === "saving"}>
            Disconnect
          </button>
        )}
        <span style={{flex:1}}></span>
        {savingState === "error" && (
          <span style={{fontSize:11, color:"var(--error, #ff6b6b)"}} title={errorMsg ?? ""}>error · hover for details</span>
        )}
      </div>
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

function LlamaServerControls({ savedHfModel, savedBinary }: { savedHfModel: string; savedBinary: string }) {
  const [status, setStatus] = useState<LlamaStatus>({ running: false, pid: null, binary: null });
  const [busy, setBusy] = useState<"idle" | "starting" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);

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
    if (!savedHfModel) {
      setError("Renseigne d'abord le champ 'Modèle HuggingFace' puis clique Save.");
      return;
    }
    setBusy("starting");
    setError(null);
    try {
      const s = await invoke<LlamaStatus>("llama_start", {
        binary: savedBinary || null,
        hfModel: savedHfModel,
      });
      setStatus(s);
      // Boot can take 15–60s (model download on first run, weight load on
      // subsequent runs). Poll the server's /v1/models until it returns 200
      // then invalidate discovery so every window (main + chibi) picks up
      // the new model instantly. Stays in "starting" UI state until the
      // server is actually serving — much closer to the real readiness
      // than the immediate `running:true` from the spawn return value.
      await waitForLlamaReady("http://127.0.0.1:8080");
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
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="lgb lgb-sm lgb-primary"
          onClick={start}
          disabled={busy !== "idle"}
          title={status.running ? "Restart with the currently-saved model" : "Start llama-server with the saved model"}
        >
          {busy === "starting" ? "Starting…" : status.running ? "Restart" : "Start server"}
        </button>
        {status.running && (
          <button className="lgb lgb-sm" onClick={stop} disabled={busy !== "idle"}>
            {busy === "stopping" ? "Stopping…" : "Stop"}
          </button>
        )}
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }}>
          flags: -hf … -c 32768 --host 127.0.0.1 --port 8080
        </span>
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

// ProfileView — moved to its own module. Re-exported for views-code.tsx.
