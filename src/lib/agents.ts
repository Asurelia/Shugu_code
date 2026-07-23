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
export type ExecutionProfile = "chat" | "plan" | "auto" | "fullAccess";
export type AgentRole =
  | "mascot"
  | "orchestrator"
  | "coder"
  | "researcher"
  | "tester"
  | "atelier"
  | "grounded";
export type AgentEventKind =
  | "spawn"
  | "message"
  | "promptComposed"
  | "toolCall"
  | "toolResult"
  | "delta"
  | "complete"
  | "error"
  | "skillLearned"
  | "lessonsInjected"
  | "memoryRecalled"
  | "memoryCompacted"
  | "write"
  | "screenshot"
  | "worktreeStarted"
  | "worktreeFinalized"
  | "worktreeSkipped"
  | "questionAsked"
  | "planSubmitted";

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
  executionProfile: ExecutionProfile;
  isolate: boolean;
  /** False for runs created before the enforced profile contract existed. */
  profileVerified: boolean;
  isolationStatus:
    | "none"
    | "pending"
    | "active"
    | "failed"
    | "review"
    | "finalized"
    | "discarded"
    | "unknown";
  /** Durable high-level objective this run belongs to, when launched in Goal mode. */
  goalId?: string | null;
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
      /** Optional for transcripts created before schema V20. */
      executionProfile?: ExecutionProfile;
      isolate?: boolean;
      goalId?: string;
    }
  | {
      kind: "message";
      agentId: string;
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      kind: "promptComposed";
      agentId: string;
      version: string;
      fingerprint: string;
      executionProfile: ExecutionProfile;
      protocol: string;
      toolNames: string[];
      ruleSources: string[];
      packageManager: string | null;
      contextTruncated: boolean;
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
      reasoning?: string;
      ms: number;
    }
  | { kind: "error"; agentId: string; error: string }
  | {
      kind: "skillLearned";
      agentId: string;
      role: string;
      /** Name of the reusable skill the agent just saved — VERIFIED by a real
       * passing test (the env gate). The chat UI shows an inline "🎓 appris" badge. */
      name: string;
      /** Who created this skill: "agent" (via skill_save tool during a run) or
       * "advisor" (distilled by the external reviewer via skill_save_advisor). */
      source: "agent" | "advisor";
    }
  | {
      kind: "lessonsInjected";
      agentId: string;
      role: string;
      /** Number of validated past-review lessons re-injected into this run's
       * context at start (S3 closed loop). The Agents panel shows a
       * "📚 N leçons réinjectées" badge. */
      count: number;
    }
  | {
      // AM-2 — orchestrated-memory RECALL. The `recall()` hook injected past
      // facts/episodes (from the `memory` vector collection) relevant to this
      // task into the agent's context. Distinct from `lessonsInjected`
      // (validated reviews) — these are the agent's own remembered facts +
      // compaction summaries.
      kind: "memoryRecalled";
      agentId: string;
      role: string;
      /** How many memories were surfaced — the UI shows a
       * "🧠 N souvenir(s) rappelé(s)" badge. */
      count: number;
    }
  | {
      // AM-2 — history COMPACTION. The loop summarised its oldest turns into one
      // episodic memory (written to the `memory` collection) and replaced them
      // with a single recap, to stay within context.
      kind: "memoryCompacted";
      agentId: string;
      role: string;
      /** How many turns were collapsed into the summary — the UI shows a
       * "🗜 N tours compactés" note instead of a silent message drop. */
      folded: number;
    }
  | {
      kind: "write";
      agentId: string;
      /** Workspace-relative path the agent wrote (fs_write_file / fs_edit). */
      path: string;
      /** Pre-write content for diff + undo. Undefined/absent = file was CREATED
       *  this run (the chat's "Annuler" then deletes it). */
      before?: string;
    }
  | {
      kind: "screenshot";
      agentId: string;
      /** toolCallId de l'appel `capture_screen` correspondant — la timeline
       *  attache la miniature à cette ligne d'activité. */
      toolCallId: string;
      /** Chemin absolu du JPEG plein format (app_data_dir/captures/). */
      path: string;
      /** Miniature 512 px en data URL — affichée dans le fil (persistée dans
       *  agent_events, survit au reload). */
      thumbDataUrl: string;
    }
  | {
      kind: "worktreeStarted";
      agentId: string;
      /** Working dir of the fresh worktree the isolated agent runs in. */
      path: string;
      /** The fresh branch the worktree checked out (off the committed HEAD). */
      branch: string;
    }
  | {
      kind: "worktreeFinalized";
      agentId: string;
      /** "merged" | "no-changes" | "discarded" | "diff" — see the Rust doc on
       *  `AgentEvent::WorktreeFinalized`. */
      outcome: "merged" | "no-changes" | "discarded" | "diff" | (string & {});
      /** Present on "diff": the kept worktree's branch (for manual review). */
      branch?: string;
      /** Present on "diff": the kept worktree's working dir. */
      path?: string;
      /** Present on "merged": the merge commit OID landed in the user's tree. */
      commit?: string;
      /** Present on "diff": a `git diff --stat` summary of the kept changes. */
      diff?: string;
      /** Present on "diff": why the changes weren't auto-merged (conflict / dirty
       *  target / error). */
      reason?: string;
    }
  | {
      // Phase 7 #4 — l'isolation a été DEMANDÉE mais n'a pas pu démarrer (pas de
      // dépôt git, pas de workspace, ou échec `git worktree add`). Le run est
      // arrêté avant mutation : aucune retombée silencieuse sur le checkout.
      kind: "worktreeSkipped";
      agentId: string;
      /** Pourquoi l'isolation n'a pas pu démarrer (affiché tel quel à l'user). */
      reason: string;
    }
  | {
      // Human-in-the-loop — l'agent a appelé `ask_user`. Rendu en carte cliquable
      // dans le fil ; la réponse relance l'agent via `agentContinue`.
      kind: "questionAsked";
      agentId: string;
      toolCallId: string;
      /** Le JSON brut de l'outil `ask_user` : 1 à 4 questions à choix. */
      questions: {
        id?: string;
        question: string;
        multiSelect?: boolean;
        options: { label: string; description?: string }[];
      }[];
    }
  | {
      // Human-in-the-loop — l'agent a appelé `submit_plan`. Rendu en carte avec
      // « Approuver et exécuter » / « Continuer à planifier ».
      kind: "planSubmitted";
      agentId: string;
      toolCallId: string;
      /** Plan final en Markdown à présenter dans la carte d'approbation. */
      plan: string;
      title?: string;
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
  /** Path absolu d'un fichier `.md` (format Claude Code) définissant un
   *  agent personnalisé. Si fourni, son frontmatter remplace `role`/`model`
   *  et son body devient le system prompt. Voir [src/lib/agentDefs.ts]. */
  agentDefPath?: string;
  /** Mode du sélecteur de chat. `"plan"` ⇒ l'agent tourne en LECTURE SEULE
   *  (le runner retire fs_write_file/fs_edit/run_command du manifest et refuse
   *  toute mutation). `"agent"` (ou absent) ⇒ exécution directe complète.
   *  Sérialise vers le champ Rust `mode` (SpawnArgs). */
  mode?: "chat" | "plan" | "agent" | "goal" | (string & {});
  executionProfile?: ExecutionProfile;
  /** Modèle CONSEILLER distinct pour l'outil `advisor` in-loop (v2). Résolu
   *  côté appelant depuis `routing.advisorModel` (provider compris). Quand
   *  fourni, le runner consulte CE modèle au lieu de l'exécuteur (sinon
   *  auto-consultation). Les 4 champs vont ensemble. Sérialisent vers les
   *  champs Rust `advisor_model`/`advisor_protocol`/`advisor_base_url`/
   *  `advisor_api_key`. */
  advisorModel?: string;
  advisorProtocol?: string;
  advisorBaseUrl?: string;
  advisorApiKey?: string;
  /** Phase 3 — worktree-per-agent isolation opt-in. When `true`, the agent runs
   *  inside a fresh git worktree on its own branch (off the committed HEAD) and
   *  its changes are merged back at the end (or kept for manual review on
   *  conflict). For a FUTURE chat fan-out where multiple agents run in parallel
   *  without clobbering each other. Defaults to `false`/undefined — the
   *  single-agent in-place flow does NOT set it, so behaviour is unchanged.
   *  Ignored in Plan mode (read-only never mutates). Serializes to the Rust
   *  `isolate` field (SpawnArgs). */
  isolate?: boolean;
  /** Existing Goal to resume, or omitted to create one when mode="goal". */
  goalId?: string;
  goalTitle?: string;
  goalObjective?: string;
}

/** Spawn an agent. Returns the freshly minted agent id (UUID v4 string).
 * Rejects with `"agent capacity reached: 4 active"` when the in-memory
 * registry is full, or `"invalid role: X"` for roles outside the allowed
 * set. */
export async function spawnAgent(args: SpawnArgs): Promise<string> {
  return invoke<string>("agent_spawn", { args });
}

/** Args pour `agentContinue` — relance human-in-the-loop après une réponse à
 *  `ask_user` ou l'approbation/le refus d'un `submit_plan`. Sérialise vers le
 *  Rust `ContinueArgs` (camelCase). */
export interface ContinueArgs {
  conversationId: string;
  model: string;
  /** Message user synthétique injecté (réponse aux questions, ou « exécute le
   *  plan approuvé » avec le plan réinjecté). Devient la `task` du nouveau run. */
  answer: string;
  /** "plan" (relance après ask_user) ou "agent" (approbation → exécution). */
  mode?: "chat" | "plan" | "agent";
  executionProfile?: ExecutionProfile;
  isolate?: boolean;
  /** tool_call_id de l'interaction consommée — clé d'idempotence de la relance. */
  interactionId?: string;
  kind?: "ask_user" | "submit_plan";
  response?: string;
  verdict?: "approved" | "continue";
  // Provider routing — miroir de SpawnArgs (résolu côté TS avant l'appel).
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  chatTemplateKwargs?: Record<string, unknown>;
  advisorModel?: string;
  advisorProtocol?: string;
  advisorBaseUrl?: string;
  advisorApiKey?: string;
}

/** Relance un agent après une réponse de l'utilisateur (`ask_user`) ou l'approbation
 *  d'un plan (`submit_plan`). Renvoie l'id du NOUVEL agent. Idempotent : une
 *  interaction déjà consommée rejette (« Cette interaction a déjà été traitée. »). */
export async function agentContinue(args: ContinueArgs): Promise<string> {
  return invoke<string>("agent_continue", { args });
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

// ── Skill library (Voyager / Hermes) — mirrors commands::agents::skills ──

/** One reusable skill the agent has learned (Voyager/Hermes), mirror of SkillRow. */
export interface SkillRow {
  name: string;
  whenToUse: string;
  body: string;
  createdAt: number;
  /** Who created this skill: "agent" (via skill_save) or "advisor" (distilled by
   * the external reviewer). Undefined until Rust's load_skills SELECT includes
   * the created_by column. */
  createdBy?: string;
}

/** List the skills a role has learned + saved (loaded into its context each run). */
export async function skillsList(role: string): Promise<SkillRow[]> {
  return invoke<SkillRow[]>("skills_list", { role });
}

/** Wipe a role's learned skills (demo reset / cleanup). */
export async function skillsClear(role: string): Promise<void> {
  return invoke<void>("skills_clear", { role });
}

// ── Atelier (env-grounded build → test → learn loop) — mirrors agent_atelier_run ──

/** Launch an Atelier run: an `atelier` agent builds a small web UI in a THROWAWAY
 *  creation dir, drives it with a real browser (Playwright, exec directe sur la
 *  machine), iterates on real failures, and saves a skill once its test passes
 *  (exit 0). Returns the agent id — stream it in the SAME transcript UI as any
 *  agent. Provider routing mirrors `spawnAgent`: the key is resolved by the
 *  caller from the keychain (never cleartext at rest). */
export async function atelierRun(args: {
  task: string;
  model: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  chatTemplateKwargs?: Record<string, unknown>;
}): Promise<string> {
  return invoke<string>("agent_atelier_run", { args });
}

// ── Grounded Run (exec DIRECTE sur le vrai projet — le filet est git) ──

/** Git-safety-net report (mirror of Rust `ExecCapability`). Execution is always
 *  available (exec directe, pivot 2026-06-10) — this drives the NON-blocking
 *  warning shown before an agent run when the net is missing or partial. */
export interface ExecCapability {
  /** A workspace is open — execution can target it. */
  ready: boolean;
  /** The workspace is a git repository (the safety net exists). */
  gitRepo: boolean;
  /** Uncommitted changes present — the net only protects what's committed. */
  hasUncommitted: boolean;
  /** Human-readable, non-blocking warning; absent when the net is solid. */
  warning?: string;
}

/** Probe the git safety net for the open workspace. Rejects if the IPC itself
 *  is unreachable; the caller treats that as "unknown" and shows no warning. */
export async function execPreflight(): Promise<ExecCapability> {
  return invoke<ExecCapability>("agent_exec_preflight");
}

/** Launch a Grounded Run: a `grounded` agent works DIRECTLY on the user's real
 *  project with execution enabled, runs the project's checks, and iterates on
 *  real failures. Changes land on the live tree as they happen — follow and
 *  revert them in the Git panel (the git watcher refreshes it live).
 *  Provider routing mirrors `spawnAgent` (key resolved from the keychain). */
export async function groundedRun(args: {
  task: string;
  model: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  chatTemplateKwargs?: Record<string, unknown>;
  /** The project's verification command, e.g. "pnpm typecheck". */
  testCommand?: string;
}): Promise<string> {
  return invoke<string>("agent_grounded_run", { args });
}
