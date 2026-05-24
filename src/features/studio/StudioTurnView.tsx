// Shugu Forge — one Studio conversation turn (Phase F).
//
// Renders a user instruction + the agent's CURATED activity, derived live from
// useAgentTranscript(agentId) (the agents query cache, fed by useAgentEvents in
// RootLayout). We deliberately never render the `message role:"system"` event —
// that's the raw generation prompt, and hiding it is the whole point of the
// "clean cards" requirement. A generation writes only a few files, so file
// chips are cheap; the freeze risk was delta bursts (tokens), not toolCalls.

import { Icon } from "@/components/components";
import { useAgentTranscript } from "@/features/agents/queries";
import type { AgentEvent } from "@/lib/agents";
import type { StudioTurn } from "./studioChat";

const PREVIEW_PREFIX = ".shugu-forge/preview/";

function relPath(p: string): string {
  return p.startsWith(PREVIEW_PREFIX) ? p.slice(PREVIEW_PREFIX.length) : p;
}

function toolPath(e: Extract<AgentEvent, { kind: "toolCall" }>): string | null {
  const a = e.args as { path?: unknown } | null;
  return a && typeof a.path === "string" ? a.path : null;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

export function StudioTurnView({
  turn,
  onOpenFile,
}: {
  turn: StudioTurn;
  onOpenFile?: (rel: string) => void;
}) {
  const { data } = useAgentTranscript(turn.agentId);
  const events: AgentEvent[] = data?.events ?? [];
  const status = data?.agent.status ?? "pending";
  const isActive = status === "running" || status === "pending";

  // Curated activity: unique files written + count of reads + latest plan.
  const writeSet = new Set<string>();
  let reads = 0;
  let todos: { text: string; status?: string }[] = [];
  for (const e of events) {
    if (e.kind !== "toolCall") continue;
    if (e.tool === "fs_write_file") {
      const p = toolPath(e);
      if (p) writeSet.add(relPath(p));
    } else if (e.tool === "fs_read_file" || e.tool === "fs_list_dir") {
      reads++;
    } else if (e.tool === "todo_write") {
      // The latest todo_write call wins (the agent re-sends the full list).
      const t = (e.args as { todos?: unknown } | null)?.todos;
      if (Array.isArray(t)) {
        todos = t
          .filter((x): x is { text: string; status?: string } =>
            !!x && typeof (x as { text?: unknown }).text === "string")
          .map((x) => ({ text: x.text, status: (x as { status?: string }).status }));
      }
    }
  }
  const writes = [...writeSet];

  const completeEv = events.find((e) => e.kind === "complete");
  const errorEv = events.find((e) => e.kind === "error");
  const reply = completeEv && completeEv.kind === "complete" ? completeEv.output.trim() : "";
  const reasoning = completeEv && completeEv.kind === "complete" ? (completeEv.reasoning ?? "").trim() : "";
  const ms = completeEv && completeEv.kind === "complete" ? completeEv.ms : 0;
  const errMsg = errorEv && errorEv.kind === "error" ? errorEv.error : "";

  return (
    <div className="studio-turn">
      <div className="studio-turn-user">
        <div className="studio-turn-bubble">{turn.userText}</div>
        {turn.context && <div className="studio-turn-ctx">{turn.context}</div>}
      </div>

      <div className="studio-turn-agent">
        {todos.length > 0 && (
          <div className="studio-turn-todos">
            {todos.map((t, i) => (
              <div key={i} className={"studio-todo is-" + (t.status ?? "pending")}>
                <span className="studio-todo-mark">
                  {t.status === "completed" ? <Icon name="check" size={10} /> : null}
                </span>
                <span className="studio-todo-text">{t.text}</span>
              </div>
            ))}
          </div>
        )}
        {(isActive || writes.length > 0) && (
          <div className="studio-turn-work">
            <div className="studio-turn-work-head">
              {isActive ? <span className="studio-ring" /> : <Icon name="check" size={13} />}
              <span>{isActive ? "L'agent compose le projet…" : "Projet mis à jour"}</span>
              {reads > 0 && (
                <span className="studio-turn-reads">· {reads} lecture{reads > 1 ? "s" : ""}</span>
              )}
              {!isActive && ms > 0 && (
                <span className="studio-turn-reads">· {fmtDuration(ms)}</span>
              )}
            </div>
            {writes.length > 0 && (
              <div className="studio-turn-files">
                {writes.map((p) => (
                  <button
                    key={p}
                    className="studio-file-chip"
                    title={`Ouvrir ${p} dans l'éditeur`}
                    onClick={() => onOpenFile?.(p)}
                  >
                    <Icon name="file" size={11} /> {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {reasoning && (
          <details className="studio-turn-reasoning">
            <summary>Raisonnement</summary>
            <div className="studio-turn-reasoning-body">{reasoning}</div>
          </details>
        )}

        {reply && <div className="studio-turn-reply">{reply}</div>}
        {errMsg && (
          <div className="studio-turn-err">
            <Icon name="x" size={12} /> {errMsg}
          </div>
        )}
      </div>
    </div>
  );
}
