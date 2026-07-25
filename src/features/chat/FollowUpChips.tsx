// Shugu Forge — chips de la file d'attente des suivis (P6.1), au-dessus du
// composer. Chaque chip = une ligne `queued_followups` PENDING de la
// conversation : icône de mode (⏳ queue / 🧭 steer), contenu tronqué,
// ✕ pour retirer explicitement (agent_dequeue_followup), et « ▶ reprendre »
// quand AUCUN run n'est actif sur la conversation (ligne orpheline d'un run
// terminé/killé — le kill ne droppe jamais la file).
//
// Live : la query est invalidée par useAgentEvents sur les events
// followUpQueued / followUpInjected / followUpDropped (agent://lifecycle).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dequeueFollowup,
  listFollowups,
  type QueuedFollowupRow,
} from "@/lib/agents";
import { useActiveAgents } from "@/features/agents/queries";
import { followupKeys } from "@/features/agents/keys";
import { followUpModeIcon, followUpModeHint, followUpModeLabel } from "./followUpQueue";
import { driveQueuedFollowUp } from "./chat-sync";

function clip(text: string, max = 64): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

function FollowUpChip({
  row,
  runActive,
  onRemoved,
}: {
  row: QueuedFollowupRow;
  runActive: boolean;
  onRemoved: () => void;
}) {
  return (
    <span
      className="chip"
      title={`${followUpModeHint(row.mode)}\n\n${row.content}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        fontSize: 11,
      }}
    >
      <span aria-hidden>{followUpModeIcon(row.mode)}</span>
      <span style={{ opacity: 0.75, fontSize: 10 }}>{followUpModeLabel(row.mode)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {clip(row.content)}
      </span>
      {!runActive && (
        <button
          type="button"
          title="Le run est terminé : lancer ce message maintenant"
          onClick={() => void driveQueuedFollowUp(row.conversationId, row)}
          style={{
            appearance: "none",
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            padding: 0,
            fontSize: 11,
          }}
        >
          ▶
        </button>
      )}
      <button
        type="button"
        title="Retirer de la file"
        onClick={() =>
          void dequeueFollowup(row.id)
            .then(onRemoved)
            .catch((err) => console.warn("[FollowUpChips] dequeue failed:", err))
        }
        style={{
          appearance: "none",
          border: "none",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
          opacity: 0.7,
        }}
      >
        ✕
      </button>
    </span>
  );
}

export function FollowUpChips({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const { data: rows } = useQuery({
    queryKey: followupKeys.list(conversationId),
    queryFn: () => listFollowups(conversationId),
    staleTime: 0,
  });
  const { data: activeAgents } = useActiveAgents();
  const runActive = (activeAgents ?? []).some((a) => a.conversationId === conversationId);

  if (!rows || rows.length === 0) return null;

  const refresh = () => void qc.invalidateQueries({ queryKey: followupKeys.all });

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "4px 2px",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 10, opacity: 0.6 }}>
        {runActive ? "en attente du run en cours" : "suivis en attente"}
      </span>
      {rows.map((row) => (
        <FollowUpChip key={row.id} row={row} runActive={runActive} onRemoved={refresh} />
      ))}
    </div>
  );
}
