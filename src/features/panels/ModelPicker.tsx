// Shugu Forge — compact provider-aware model selector.
//
// The picker is shared by the main composer, the mascot and product settings.
// It deliberately exposes product language (provider, friendly model name,
// capabilities) rather than storage ids or backend diagnostics.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/components";
import { ProviderMark } from "@/components/ProviderMark";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { useActiveCodexEffort } from "@/features/chat/chat-sync";
import { codexModels, type CodexModel } from "@/lib/codex";
import { useModelCapabilities } from "@/lib/modelCapabilities";
import "./model-picker.css";

const PROVIDER_LABELS_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  mistral: "Mistral",
  groq: "Groq",
  minimax: "MiniMax",
  codex: "OpenAI Codex",
  kimi: "Kimi",
};

export interface ModelPickerProps {
  model: string;
  onChange: (m: string) => void;
  className?: string;
}

function friendlyModelName(value: string): string {
  const raw = value.split("/").pop()?.trim() || value.trim();
  if (!raw) return "Choisir un modèle";
  if (raw.toLowerCase() === "k3") return "K3";
  return raw
    .replace(/^kimi-for-coding[-_]?/i, "Kimi Coding ")
    .replace(/[-_]+/g, " ")
    .replace(/\b(highspeed|turbo)\b/gi, (match) => `· ${match}`)
    .replace(/\s+/g, " ")
    .trim();
}

function friendlyProviderName(providerId: string, discoveredLabel?: string): string {
  if (discoveredLabel && !discoveredLabel.startsWith("custom-")) return discoveredLabel;
  return PROVIDER_LABELS_DISPLAY[providerId] ?? "Provider personnalisé";
}

function diagnosticLabel(message: string): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("private") ||
    normalized.includes("loopback") ||
    normalized.includes("localhost") ||
    normalized.includes("connection refused") ||
    normalized.includes("connect")
  ) {
    return "Serveur local indisponible ou non autorisé";
  }
  if (normalized.includes("401") || normalized.includes("403") || normalized.includes("auth")) {
    return "Authentification à vérifier";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "Le provider met trop de temps à répondre";
  }
  return "Connexion à vérifier";
}

function CapBadge({ modelId }: { modelId: string }) {
  const caps = useModelCapabilities(modelId);
  if (!caps) return null;
  if (caps.agentLoop === "chatOnly") {
    return (
      <span className="model-cap model-cap-chat" title="Ce modèle ne pilote pas les outils Shugu">
        Chat
      </span>
    );
  }
  if (caps.tier === "small") {
    return (
      <span
        className="model-cap model-cap-small"
        title={caps.supportsTools ? "Petit modèle, outils réduits" : "Petit modèle sans outils"}
      >
        Léger
      </span>
    );
  }
  return <span className="model-cap model-cap-agent">Agent</span>;
}

export function ModelPicker({
  model,
  onChange,
  className = "float-foot-model",
}: ModelPickerProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLSpanElement | null>(null);
  const { data: discovered, errors, isLoading, refresh } = useDiscoveredModels();

  const isCodex = model.startsWith("codex/");
  const [effort, setEffort] = useActiveCodexEffort();
  const [codexList, setCodexList] = useState<CodexModel[]>([]);
  useEffect(() => {
    if (!open || !isCodex) return;
    let cancelled = false;
    void codexModels()
      .then((models) => {
        if (!cancelled) setCodexList(models);
      })
      .catch(() => {
        // The picker remains usable with its conservative fallback efforts.
      });
    return () => {
      cancelled = true;
    };
  }, [open, isCodex]);

  const activeCodexModel = isCodex ? model.slice("codex/".length) : "";
  const supportedEfforts =
    codexList.find((entry) => entry.model === activeCodexModel)?.supportedEfforts ??
    ["low", "medium", "high", "xhigh"];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const active = discovered.find((entry) => entry.id === model);
  const activeProviderId = active?.providerId ?? model.split("/")[0] ?? "";
  const activeProvider = friendlyProviderName(activeProviderId, active?.providerLabel);
  const activeModel = active ? friendlyModelName(active.label) : "Choisir un modèle";
  const isActiveModelAvailable = isLoading || Boolean(active);

  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const byProvider = new Map<
      string,
      { label: string; items: typeof discovered }
    >();
    for (const entry of discovered) {
      const haystack = `${entry.providerLabel} ${entry.label}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      const current = byProvider.get(entry.providerId);
      if (current) current.items.push(entry);
      else {
        byProvider.set(entry.providerId, {
          label: friendlyProviderName(entry.providerId, entry.providerLabel),
          items: [entry],
        });
      }
    }
    return Array.from(byProvider.entries()).map(([providerId, group]) => ({
      providerId,
      ...group,
    }));
  }, [discovered, search]);

  const diagnostics = Object.entries(errors);
  const readyProviderCount = new Set(discovered.map((item) => item.providerId)).size;

  const openConnections = () => {
    setOpen(false);
    void navigate({ to: "/connections" });
  };

  return (
    <span ref={ref} className="model-picker-anchor">
      <button
        type="button"
        className={`${className} model-picker-trigger`}
        title="Changer de provider ou de modèle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ProviderMark
          id={isActiveModelAvailable ? activeProviderId : ""}
          name={isActiveModelAvailable ? activeProvider : "Modèles"}
          fallback="M"
          size="sm"
        />
        <span className="model-picker-trigger-copy">
          <span className="model-picker-provider">
            {isActiveModelAvailable ? activeProvider : "Modèle"}
          </span>
          <span className="model-picker-model">
            {isLoading && !active ? "Découverte…" : activeModel}
          </span>
        </span>
        <Icon name="down" size={11} />
      </button>

      {open && (
        <div className="model-picker-pop" role="dialog" aria-label="Choisir un modèle">
          <div className="model-picker-head">
            <div>
              <strong>Modèles disponibles</strong>
              <span>{discovered.length} détecté{discovered.length > 1 ? "s" : ""}</span>
            </div>
            <button
              type="button"
              className="model-picker-icon-btn"
              onClick={() => void refresh()}
              aria-label="Actualiser les modèles"
              title="Actualiser les modèles"
            >
              <Icon name="history" size={13} />
            </button>
          </div>

          {discovered.length > 5 && (
            <label className="model-picker-search">
              <Icon name="search" size={13} />
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Rechercher un modèle…"
                aria-label="Rechercher un modèle"
              />
            </label>
          )}

          <div className="model-picker-scroll">
            {isLoading && (
              <div className="model-picker-empty">Interrogation des providers…</div>
            )}

            {!isLoading && groups.length === 0 && (
              <div className="model-picker-empty">
                <strong>{search ? "Aucun résultat" : "Aucun modèle prêt"}</strong>
                <span>
                  {search
                    ? "Essaie un autre nom."
                    : "Configure ou reconnecte un provider pour commencer."}
                </span>
                {!search && (
                  <button type="button" className="lgb lgb-sm" onClick={openConnections}>
                    Ouvrir Connexions
                  </button>
                )}
              </div>
            )}

            {groups.map((group) => (
              <section className="model-picker-group" key={group.providerId}>
                <header>
                  <ProviderMark
                    id={group.providerId}
                    name={group.label}
                    fallback={group.label.charAt(0)}
                    size="sm"
                  />
                  <span>{group.label}</span>
                  <span className="model-picker-count">{group.items.length}</span>
                  <span className="model-picker-online">Prêt</span>
                </header>
                {group.items.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`model-pop-item model-picker-item${entry.id === model ? " on" : ""}`}
                    onClick={() => {
                      onChange(entry.id);
                      setOpen(false);
                    }}
                    aria-pressed={entry.id === model}
                  >
                    <span className="model-picker-item-copy">
                      <span className="name">{friendlyModelName(entry.label)}</span>
                      <span className="model-picker-item-desc">
                        {entry.id === model ? "Sélectionné pour cette conversation" : "Utiliser ce modèle"}
                      </span>
                    </span>
                    <CapBadge modelId={entry.id} />
                    {entry.id === model && <span className="check">✓</span>}
                  </button>
                ))}
              </section>
            ))}

            {isCodex && (
              <section className="model-picker-group model-picker-effort">
                <header>
                  <span>Effort de raisonnement</span>
                </header>
                <div>
                  {supportedEfforts.map((entry) => (
                    <button
                      type="button"
                      key={entry}
                      className={entry === effort ? "on" : ""}
                      onClick={() => setEffort(entry)}
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {diagnostics.length > 0 && (
              <details className="model-picker-diagnostics">
                <summary>
                  {diagnostics.length} provider{diagnostics.length > 1 ? "s" : ""} à vérifier
                </summary>
                {diagnostics.map(([providerId, message]) => (
                  <div key={providerId}>
                    <span>
                      {friendlyProviderName(
                        providerId,
                        discovered.find((entry) => entry.providerId === providerId)?.providerLabel,
                      )}
                    </span>
                    <small>{diagnosticLabel(message)}</small>
                  </div>
                ))}
              </details>
            )}
          </div>

          <div className="model-picker-foot">
            <span>
              {discovered.length} modèle{discovered.length > 1 ? "s" : ""} ·{" "}
              {readyProviderCount} provider{readyProviderCount > 1 ? "s" : ""} prêt
              {readyProviderCount > 1 ? "s" : ""}
            </span>
            <button type="button" onClick={openConnections}>
              Gérer les providers <Icon name="chevron-right" size={11} />
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
