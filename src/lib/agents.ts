// Shugu Forge — agent system frontend bindings.
//
// Mirrors the Rust types and commands defined in
// `src-tauri/src/commands/agents.rs`. This module is intentionally tiny:
// types + thin `invoke` wrappers, no React, no state. The Zustand store
// (`agentsStore.ts`) and the React hook (`useAgents.ts`) build on these.
//
// Serialization contract (kept in sync with the Rust serde annotations):
//   - All structs serialize as camelCase fields.
//   - `AgentEvent` is a tagged union with `kind` as the discriminator.
//   - Missing optional fields arrive as `undefined` (Rust `Option::None` +
//     `skip_serializing_if = "Option::is_none"`); non-optional Rust
//     `Option<T>` arrive as `null`. Frontend handles both with `?? ...`
//     or the optional-chaining operator.

import { invoke } from "@/lib/tauri";
import { diag } from "@/lib/diag";

// ────────────────────────────────────────────────────────────────────
// String unions (closed sets enforced by Rust, mirrored here for IDE help)
// ────────────────────────────────────────────────────────────────────

export type AgentStatus = "pending" | "running" | "complete" | "error" | "killed";
export type AgentRole = "mascot" | "orchestrator" | "coder" | "researcher" | "tester";
export type AgentEventKind =
  | "spawn"
  | "message"
  | "toolCall"
  | "toolResult"
  | "delta"
  | "complete"
  | "error"
  | "harnessEvolved";

// ────────────────────────────────────────────────────────────────────
// DB row shapes (mirror Rust AgentRow / AgentEventRow)
// ────────────────────────────────────────────────────────────────────

export interface AgentRow {
  id: string;
  role: string;
  status: AgentStatus;
  parentId: string | null;
  model: string;
  task: string;
  conversationId: string | null;
  createdAt: number;
  finishedAt: number | null;
  output: string | null;
  error: string | null;
}

export interface AgentEventRow {
  id: number;
  agentId: string;
  ts: number;
  kind: AgentEventKind;
  /** Raw JSON string — parse to AgentEvent for typed access via
   * `JSON.parse(row.payload) as AgentEvent`. The Rust side already
   * serialized this as JSON before persisting; we keep it as a string
   * at the row level to avoid double-parsing in the store hot path. */
  payload: string;
}

export interface AgentTranscript {
  agent: AgentRow;
  events: AgentEventRow[];
}

// ────────────────────────────────────────────────────────────────────
// AgentEvent discriminated union — the live payload broadcast on the
// `agent://lifecycle` Tauri channel.
// ────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | {
      kind: "spawn";
      agentId: string;
      parentId: string | null;
      role: string;
      task: string;
      model: string;
      conversationId: string | null;
    }
  | {
      kind: "message";
      agentId: string;
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      kind: "toolCall";
      agentId: string;
      toolCallId: string;
      tool: string;
      args: unknown;
    }
  | {
      kind: "toolResult";
      agentId: string;
      toolCallId: string;
      result: unknown;
      error?: string;
    }
  | {
      kind: "delta";
      agentId: string;
      chunk: string;
      deltaKind: "content" | "reasoning";
    }
  | {
      kind: "complete";
      agentId: string;
      output: string;
      tokensUsed?: number;
      ms: number;
    }
  | { kind: "error"; agentId: string; error: string }
  | {
      kind: "harnessEvolved";
      agentId: string;
      role: string;
      /** "evolving" = Refiner call started (5-30s); "applied" = new generation
       * active; "failed" = Refiner errored, current harness kept. */
      status: "evolving" | "applied" | "failed";
      reason?: string;
      fromGeneration?: number;
      toGeneration?: number;
      summary?: string;
    };

// ────────────────────────────────────────────────────────────────────
// Command wrappers
// ────────────────────────────────────────────────────────────────────

export interface SpawnArgs {
  role: AgentRole | (string & {}); // accept extensions, IDE helps for the known set
  task: string;
  model: string;
  parentId?: string;
  conversationId?: string;
  // Phase 1 — provider routing for the real LLM call. The caller resolves
  // these via `resolveProvider(modelId)` + `loadProviderConfig(providerId)`
  // before spawning, so the Rust runner doesn't need keychain access of
  // its own. Empty/undefined values fall through to the Rust-side env-var
  // resolution (anthropic = required key, openai = optional, ollama = none).
  protocol?: "anthropic" | "openai" | "ollama" | "custom" | (string & {});
  baseUrl?: string;
  apiKey?: string;
  /** Forwarded to the chat-completion body as `chat_template_kwargs` —
   * mainly used to toggle `{enable_thinking: false}` per request on
   * Qwen 3.5 / DeepSeek-R1 templates. */
  chatTemplateKwargs?: Record<string, unknown>;
  /** Phase A (Design Studio) — design-system context prepended to the agent's
   * system prompt so it generates a styled project on disk. Only the Studio
   * "Generate" sets this; chat delegation leaves it undefined (no impact on
   * the normal delegate path). Serializes to the Rust `design_context` field. */
  designContext?: string;
}

/** Spawn an agent. Returns the freshly minted agent id (UUID v4 string).
 * Rejects with `"agent capacity reached: 4 active"` when the in-memory
 * registry is full, or `"invalid role: X"` for roles outside the allowed
 * set. */
export async function spawnAgent(args: SpawnArgs): Promise<string> {
  return invoke<string>("agent_spawn", { args });
}

/** Kill a running agent. Non-cascading in Phase 0 — Phase 1+ must add
 * child-cascade when sub-agent spawning lands. */
export async function killAgent(agentId: string): Promise<void> {
  return invoke<void>("agent_kill", { agentId });
}

/** Currently active agents (status pending | running). Reads from SQLite
 * so a freshly-mounted window still sees what was running before the
 * mount. */
export async function listActiveAgents(): Promise<AgentRow[]> {
  return invoke<AgentRow[]>("agent_list_active");
}

/** Full transcript: the agent row + every persisted event in
 * chronological order. */
export async function getAgentTranscript(agentId: string): Promise<AgentTranscript> {
  return invoke<AgentTranscript>("agent_get_transcript", { agentId });
}

/** Every agent (any status) tied to a conversation, chronological. */
export async function listAgentsByConversation(
  conversationId: string,
): Promise<AgentRow[]> {
  return invoke<AgentRow[]>("agent_list_by_conversation", { conversationId });
}

// ────────────────────────────────────────────────────────────────────
// Phase 1 — high-level helpers for the chat delegation flow
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve once the targeted agent reaches a terminal state (Complete
 * or Error). The listener attaches BEFORE this function returns — the
 * caller must `await spawnAgent(args)` to obtain the agentId, then
 * immediately call `awaitAgentComplete(id)`. Between Rust's `agent_spawn`
 * return and the LLM's first emission there is enough latency (HTTP
 * round-trip to the provider, hundreds of ms) for the listener to
 * attach without missing the Complete event.
 *
 * Default timeout: 5 minutes — long enough for a single orchestrator
 * turn on a remote API, short enough that a wedged provider doesn't
 * pin the chat UI forever. Override via `opts.timeoutMs` if you have
 * a long-running task.
 *
 * Returns a tuple of [`waitPromise`, `cancelFn`]. `cancelFn` detaches
 * the listener without rejecting the promise — useful when the caller
 * decides to abandon the wait via a separate signal (e.g. user clicks
 * "Stop" elsewhere, or the conversation switches mid-flight).
 */
export function awaitAgentComplete(
  agentId: string,
  opts: { timeoutMs?: number } = {},
): [Promise<{ output: string }>, () => void] {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  let unlisten: (() => void) | null = null;
  let settled = false;

  const cancel = () => {
    unlisten?.();
    unlisten = null;
  };

  const waitPromise = new Promise<{ output: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancel();
      reject(new Error("agent timeout"));
    }, timeoutMs);

    const attachT0 = performance.now();
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlisten = await mod.listen<AgentEvent>("agent://lifecycle", (e) => {
          if (settled) return;
          const ev = e.payload;
          if (ev.agentId !== agentId) return;
          if (ev.kind === "complete") {
            const elapsed = Math.round(performance.now() - attachT0);
            diag(
              "delegate",
              `awaitAgent complete agent=${agentId.slice(0, 8)} attachToComplete=${elapsed}ms`,
            );
            settled = true;
            clearTimeout(timer);
            cancel();
            resolve({ output: ev.output });
          } else if (ev.kind === "error") {
            const elapsed = Math.round(performance.now() - attachT0);
            diag(
              "delegate",
              `awaitAgent error agent=${agentId.slice(0, 8)} attachToError=${elapsed}ms`,
            );
            settled = true;
            clearTimeout(timer);
            cancel();
            reject(new Error(ev.error));
          }
        });
        const attachElapsed = Math.round(performance.now() - attachT0);
        diag(
          "delegate",
          `awaitAgent listener attached agent=${agentId.slice(0, 8)} attachLatency=${attachElapsed}ms`,
        );
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });

  return [waitPromise, cancel];
}

/**
 * Cross-component "open this agent in the panel" signal. Decoupled from
 * any React store / context — uses the Tauri event bus so the main IDE
 * and the mascot window both receive it. The respective panel hosts
 * (RootLayout for main, ChatPanel for mascot) listen on this event and
 * navigate to the agents tab + set the selected agent.
 */
export async function revealAgent(agentId: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/event");
    await mod.emit("app://reveal-agent", { agentId });
  } catch (err) {
    console.warn("[agents] revealAgent emit failed:", err);
  }
}

// ────────────────────────────────────────────────────────────────────
// Continual Harness (lot 1) — generation log, metrics, edit/rollback,
// Refiner config, run feedback. Mirrors commands::agents::harness.
// ────────────────────────────────────────────────────────────────────

/** One immutable snapshot of a role's harness (mirror HarnessGenerationRow). */
export interface HarnessGeneration {
  id: string;
  role: string;
  generation: number;
  parentGeneration: number | null;
  /** "seed" | "manual" | "stuck:<reason>" — why this generation exists. */
  triggerReason: string | null;
  /** "seed" | "user" | "refiner:<model>" | "fallback:<model>". */
  createdBy: string | null;
  systemPrompt: string;
  /** JSON array string of memory entries. */
  memory: string;
  /** 1 = the generation currently served to the agent. */
  active: number;
  createdAt: number;
}

/** Per-generation outcome metrics (mirror HarnessMetricRow). */
export interface HarnessMetric {
  generation: number | null;
  runs: number;
  successes: number;
  stuckCount: number;
  avgIterations: number;
}

/** Every generation of a role's harness, newest first. */
export async function listHarnessGenerations(role: string): Promise<HarnessGeneration[]> {
  return invoke<HarnessGeneration[]>("harness_list_generations", { role });
}

/** Per-generation metrics for a role. */
export async function harnessMetrics(role: string): Promise<HarnessMetric[]> {
  return invoke<HarnessMetric[]>("harness_metrics", { role });
}

/** Make an earlier generation active again (rollback). */
export async function rollbackHarness(role: string, generation: number): Promise<void> {
  return invoke<void>("harness_rollback", { role, generation });
}

/** Persist a user-authored harness as a new active generation. */
export async function saveManualHarness(
  role: string,
  systemPrompt: string,
  memory: string,
): Promise<void> {
  return invoke<void>("harness_save_manual", { role, systemPrompt, memory });
}

/** Read the configured Refiner provider JSON (null = self-fallback). */
export async function getHarnessRefiner(): Promise<string | null> {
  return invoke<string | null>("harness_get_refiner");
}

/** Set the Refiner provider config JSON `{protocol, baseUrl, model, apiKey?}`. */
export async function setHarnessRefiner(value: string): Promise<void> {
  return invoke<void>("harness_set_refiner", { value });
}

/** Record accept/reject feedback on a run's outcome (null clears it). */
export async function setOutcomeFeedback(
  agentId: string,
  feedback: string | null,
): Promise<void> {
  return invoke<void>("outcome_set_feedback", { agentId, feedback });
}
