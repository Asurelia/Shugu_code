// Shugu Forge — ModelPicker popover.
//
// Used by both:
//   - the mascot's FloatChat footer (className="float-foot-model")
//   - the main IDE composer in ChatView   (className="composer-model")
// Pass `className` so the trigger button inherits the right look-and-feel
// from each context's stylesheet. Default keeps the original FloatChat skin.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { useDiscoveredModels } from "@/lib/modelDiscovery";

// Mirrors the labels used in ConnectionsView's card catalog. Local copy here
// so ModelPicker can label provider groups even when discovery reports only
// an error (no model row available to read the label from).
const PROVIDER_LABELS_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai:    "OpenAI",
  ollama:    "Ollama",
  llamacpp:  "llama.cpp",
  mistral:   "Mistral",
  groq:      "Groq",
};

export interface ModelPickerProps {
  model: string;
  onChange: (m: string) => void;
  className?: string;
}

export function ModelPicker({ model, onChange, className = "float-foot-model" }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  // Real, live model discovery. No more hardcoded fake lists. Models appear
  // ONLY for providers the user has actually configured AND that respond to
  // their list-models endpoint. Errors per provider surface as a small line
  // under the group header so the user can debug (wrong key, server down, etc.).
  const { data: discovered, errors, unconfigured, isLoading, refresh } = useDiscoveredModels();

  // Re-discovery is handled by the shared store: the 60s TTL kicks in on
  // next consume, and ConnCard / AddProviderModal explicitly invalidate
  // after a save. The picker only needs to react to clicks outside.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // The composer button shows the active model id by default. BUT a value
  // saved in localStorage from a previous session (e.g. "llamacpp/foo") can
  // outlive its provider being disconnected — the picker would correctly
  // show "Aucun provider configuré", but the button would still display the
  // stale id, contradicting the truth one popover above. We detect that
  // mismatch and display a neutral "Choisir un modèle" until either the
  // user picks something new or re-saves the provider in Settings.
  const isActiveModelAvailable = isLoading || discovered.some((m) => m.id === model);
  const displayName: string = isActiveModelAvailable
    ? (model || "Choisir un modèle")
    : (isLoading ? "…" : "Choisir un modèle");

  // Group discovered models by providerId for display. We preserve the order
  // in which providers appeared in the discovery result (which respects the
  // PROVIDER_REGISTRY key order then custom providers).
  const groups = (() => {
    const byProvider = new Map<string, { label: string; items: typeof discovered }>();
    for (const m of discovered) {
      const g = byProvider.get(m.providerId);
      if (g) g.items.push(m);
      else byProvider.set(m.providerId, { label: m.providerLabel, items: [m] });
    }
    return Array.from(byProvider.entries()).map(([providerId, { label, items }]) => ({ providerId, label, items }));
  })();

  return (
    <span ref={ref} style={{position:"relative", minWidth:0}}>
      <button className={className} title="Switch model" onClick={() => setOpen(o => !o)}>
        <span className="live"></span>
        <span className="name">{displayName}</span>
        <Icon name="down" size={10}/>
      </button>
      {open && (
        <div className="model-pop">
          {isLoading && (
            <div className="model-pop-group" style={{ opacity: 0.6 }}>Découverte des modèles…</div>
          )}
          {!isLoading && groups.length === 0 && (
            <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--on-surface-variant)" }}>
              Aucun provider configuré. Va dans <b>Settings → Connections</b> pour brancher Anthropic, OpenAI, Ollama, llama.cpp, etc.
            </div>
          )}
          {groups.map(g => (
            <div key={g.providerId}>
              <div className="model-pop-group">{g.label}</div>
              {g.items.map(m => (
                <button key={m.id} className={"model-pop-item" + (m.id === model ? " on" : "")} onClick={() => { onChange(m.id); setOpen(false); }}>
                  <span className="name">{m.label}</span>
                  <span className="meta">{m.providerId}</span>
                  {m.id === model && <span className="check">✓</span>}
                </button>
              ))}
              {errors[g.providerId] && (
                <div style={{ padding: "2px 14px 6px", fontSize: 10, color: "var(--error, #ff6b6b)" }} title={errors[g.providerId]}>
                  ⚠ {errors[g.providerId]}
                </div>
              )}
            </div>
          ))}
          {Object.entries(errors).filter(([k]) => !groups.find(g => g.providerId === k)).map(([providerId, msg]) => (
            <div key={providerId}>
              <div className="model-pop-group" style={{ opacity: 0.5 }}>{PROVIDER_LABELS_DISPLAY[providerId] ?? providerId}</div>
              <div style={{ padding: "2px 14px 6px", fontSize: 10, color: "var(--error, #ff6b6b)" }} title={msg}>
                ⚠ {msg}
              </div>
            </div>
          ))}
          {!isLoading && unconfigured.length > 0 && (
            <div style={{ padding: "6px 14px 8px", fontSize: 10, color: "var(--on-surface-muted)" }}>
              Non configurés : {unconfigured.map(id => PROVIDER_LABELS_DISPLAY[id] ?? id).join(", ")}
            </div>
          )}
          <div className="model-pop-foot">
            <button className="lgb lgb-sm" onClick={refresh} title="Re-fetch the model lists">
              <Icon name="sparkle" size={11}/> Refresh
            </button>
            <span style={{flex:1}}></span>
            <button className="lgb lgb-sm" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </span>
  );
}
