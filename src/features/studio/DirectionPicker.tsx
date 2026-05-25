// Shugu Forge — Design Studio · direction picker (Phase E).
//
// Shown only when no catalogue design system is active (a system IS the brand
// spec). Hybrid: 5 curated OKLch+font presets by default, plus a "Régénérer
// avec l'IA" button that asks the orchestrator for 5 brief-specific directions.
//
// The AI path reuses the existing agent infra (no new Rust): a one-shot
// orchestrator call WITHOUT designContext — so generation mode never triggers
// and the agent replies with JSON text, not files. Any failure (no
// orchestrator, timeout, unparseable reply) falls back to the curated set.

import { useState } from "react";
import { Icon } from "@/components/components";
import { resolveOrchestrator, getActiveConv } from "@/features/chat/chat-sync";
import { spawnAgent, awaitAgentComplete } from "@/lib/agents";
import type { Direction, DiscoveryAnswers } from "./generationContext";
import { CURATED_DIRECTIONS, DIRECTIONS_PROMPT, parseDirections } from "./directions";

export function DirectionPicker({
  brief,
  discovery,
  value,
  onChange,
  disabled = false,
}: {
  brief: string;
  discovery: DiscoveryAnswers;
  value: Direction | null;
  onChange: (d: Direction) => void;
  disabled?: boolean;
}) {
  // Derogation from "TanStack by default": agent calls use the app's
  // event-driven convention (spawnAgent + awaitAgentComplete over the
  // `agent://lifecycle` Tauri bus + manual state), NOT useMutation. This is a
  // one-shot generation feeding local UI state, not a server cache — and it
  // stays consistent with chat delegation (chat-sync) and StudioView.generate.
  const [directions, setDirections] = useState<Direction[]>(CURATED_DIRECTIONS);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const regenerate = async () => {
    if (loading || disabled) return;
    const orch = await resolveOrchestrator();
    if (orch.kind !== "ok") {
      setNote(
        orch.kind === "no-orchestrator"
          ? "Aucun orchestrator configuré (Settings → Connections → Routing) — directions curatées affichées."
          : `Provider « ${orch.providerId} » désactivé — directions curatées affichées.`,
      );
      return;
    }
    setLoading(true);
    setNote(null);
    try {
      const agentId = await spawnAgent({
        role: "orchestrator",
        task: DIRECTIONS_PROMPT(brief, discovery),
        model: orch.model,
        protocol: orch.protocol,
        baseUrl: orch.baseUrl,
        apiKey: orch.apiKey,
        conversationId: getActiveConv(),
        // NB: no designContext → no generation mode → text reply, no files.
      });
      const [wait] = awaitAgentComplete(agentId, { timeoutMs: 2 * 60 * 1000 });
      const { output } = await wait;
      const parsed = parseDirections(output);
      if (parsed.length >= 1) {
        setDirections(parsed);
        setNote(null);
      } else {
        setDirections(CURATED_DIRECTIONS);
        setNote("Réponse IA illisible — directions curatées affichées.");
      }
    } catch (err) {
      setDirections(CURATED_DIRECTIONS);
      setNote(`Échec de la génération IA (${String(err)}) — directions curatées affichées.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="studio-dirs">
      <div className="studio-dirs-head">
        <span className="studio-disco-label">Direction visuelle</span>
        <button
          type="button"
          className="lgb lgb-sm"
          onClick={regenerate}
          disabled={loading || disabled}
          title="Demander 5 directions à l'IA pour ce brief"
        >
          {loading ? <span className="studio-ring" /> : <Icon name="sparkle" size={12} />}{" "}
          {loading ? "Génération…" : "Régénérer avec l'IA"}
        </button>
      </div>

      <div className="studio-dirs-grid">
        {directions.map((d) => {
          const selected = value?.id === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className={`studio-dir-card${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(d)}
            >
              <div className="studio-dir-swatches">
                {d.colors.map((c) => (
                  <span
                    key={c.name}
                    className="studio-dir-swatch"
                    style={{ background: c.oklch }}
                    title={`${c.name}: ${c.oklch}`}
                  />
                ))}
              </div>
              <div className="studio-dir-name">{d.name}</div>
              <div className="studio-dir-fonts">
                {d.fonts.display} · {d.fonts.body}
              </div>
            </button>
          );
        })}
      </div>

      {note && <div className="studio-dirs-note">{note}</div>}
    </div>
  );
}
