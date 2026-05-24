// Shugu Forge — chat synchronization between the main IDE window and the
// floating mascot window. Mirrors the architecture established by
// features/mascot/calibration.ts:
//
//   - SQLite is the single source of truth (db.messages).
//   - Cross-window notification rides on the Tauri custom event bus.
//   - The `storage` browser event is wired as a best-effort second channel
//     for state that ALSO lives in localStorage (active conv id only).
//
// Public API:
//   useMessages(convId)       — React hook, returns the live message list
//                               and refetches when chat://messages-changed
//                               fires for that convId.
//   appendMessage(convId, m)  — write a single message: SQLite insert +
//                               broadcast event.
//   sendChatMessage(...)      — high-level helper used by both ChatView and
//                               FloatChat: appends user prompt, awaits the
//                               chat_send invoke, appends AI reply.
//   useActiveConv()           — [active, setActive] hook that syncs the
//                               active conv id across windows via the same
//                               dual-channel pattern.
//   createConversation(title) — insert a fresh conversation row + return id.
//
// IMPORTANT — event payload SHAPE. Every chat://messages-changed event
// carries { conversationId } so the receiver can short-circuit if the
// changed conv isn't the one it's currently displaying. Without that
// filter, every keystroke in any conv would refetch in every window.

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";
import { invoke } from "@/lib/tauri";
import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { parseAiReply } from "@/lib/markdown";
import { parseThinkingMode, resolveThinking } from "@/lib/thinkingHeuristic";
import { resolveRoute, parseDelegateOverride } from "@/lib/routingHeuristic";
import { spawnAgent, awaitAgentComplete } from "@/lib/agents";
import { getActiveDesignSystem, buildDesignSystemPrompt } from "@/features/design/activeDesignSystem";
import { queryClient } from "@/lib/queryClient";
import { diag } from "@/lib/diag";
import { chatKeys } from "./keys";
import { agentKeys } from "@/features/agents/keys";
import type { ParsedAgentTranscript } from "@/features/agents/queries";
import type { AgentRow } from "@/lib/agents";
import type { Message } from "@/lib/types";

// ─── Event names + storage keys (centralized to prevent drift) ─────────
const EVT_MESSAGES     = "chat://messages-changed";
const EVT_ACTIVE       = "chat://active-changed";
const EVT_ACTIVE_MODEL = "chat://active-model-changed";
const KEY_ACTIVE       = "shugu.chat.activeConv.v1";
const KEY_ACTIVE_MODEL = "shugu.chat.activeModel.v1";

// Fallback when no model has ever been chosen. We default to llama.cpp local
// because (a) it doesn't need an API key, (b) it's the smoke-test target, and
// (c) anything cloud-shaped would fail silently without a configured key,
// which is a worse first-run UX. If llama-server isn't running the user will
// see a connection-refused error and can switch from the picker.
const DEFAULT_ACTIVE_MODEL = "llamacpp/local";

// ─── Shape mapping (DB row ↔ UI Message) ───────────────────────────────
// Row uses unix-ms timestamps; UI renders "HH:MM" clock strings. We
// compute HH:MM at read time so a relocalized clock or a future
// per-message "Today / Yesterday" header can re-derive without schema
// changes.
function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  text: string | null;
  body: string | null;
  code_lang: string | null;
  code_text: string | null;
  /** `<think>` trace from thinking-enabled models (V3 schema). NULL for
   * messages persisted before V3 and for non-reasoning models. */
  reasoning: string | null;
  image: number;
  ts: number;
  /** UUID of the agent that produced this message (V5 schema). NULL for
   * regular chat messages. */
  agent_id: string | null;
  /** 1 = verbatim orchestrator relay; 0 = direct chat message (V5 schema). */
  via_agent: number;
  /** Unix ms timestamp of last edit. NULL if never edited (V6 schema). */
  edited_at: number | null;
  /** Unix ms timestamp of soft-delete. NULL = live (V6 schema). */
  deleted_at: number | null;
  /** UUID of the message this is a re-generation of (V6 schema). */
  parent_id: string | null;
}

function rowToMessage(r: DbMessageRow): Message {
  return {
    id: r.id,
    role: (r.role as Message["role"]),
    text: r.text ?? undefined,
    body: r.body ?? undefined,
    code: r.code_lang && r.code_text ? { lang: r.code_lang, text: r.code_text } : undefined,
    reasoning: r.reasoning ?? undefined,
    image: r.image === 1 ? true : undefined,
    ts: fmtClock(r.ts),
    viaAgent: r.via_agent === 1 ? true : undefined,
    agentId: r.agent_id ?? undefined,
  };
}

function messageToRow(m: Message, convId: string): DbMessageRow {
  return {
    id: String(m.id),
    conversation_id: convId,
    role: m.role,
    text: m.text ?? null,
    body: m.body ?? null,
    code_lang: m.code?.lang ?? null,
    code_text: m.code?.text ?? null,
    reasoning: m.reasoning ?? null,
    image: m.image ? 1 : 0,
    // m.ts is the rendered HH:MM string in the UI shape; we don't try to
    // parse it back — the insertion moment is what matters and Date.now()
    // captures it accurately. The clock string is re-derived on read.
    ts: Date.now(),
    agent_id: m.agentId ?? null,
    via_agent: m.viaAgent ? 1 : 0,
    // V6 columns — new messages written through appendMessage are always
    // unedited and undeleted at creation time; parent_id is set externally
    // (e.g. by useRegenerateFrom) when the message is a re-generation.
    edited_at: null,
    deleted_at: null,
    parent_id: null,
  };
}

// ─── useMessages hook ──────────────────────────────────────────────────
// Returns the live message list for the given conversation. Refetches
// whenever a chat://messages-changed event arrives for that conv. Convex
// is intentionally NOT consulted here: SQLite is the source of truth
// (LOCAL-FIRST mandate — see CLAUDE.md).
export interface MessagesResult {
  data: Message[];
  isLoading: boolean;
  source: "sqlite";
}

/**
 * Live message list pour une conversation. Refactor 2026-05-17 :
 * useEffect+useState+listener manuel → TanStack useQuery + invalidation
 * via `useChatMessageEvents` (mount dans ChatPanel).
 *
 * Bénéfices :
 *  - Cache automatique : naviguer entre 2 conv ne re-fetch pas si fresh.
 *  - Pas de listener à clean dans un useEffect — l'invalidation est wired
 *    en un seul point (useEvents.ts), pas dispersée dans chaque hook.
 *  - React 18 batching natif quand plusieurs events arrivent rapidement.
 */
export function useMessages(convId: string | null): MessagesResult {
  const { data = [], isLoading } = useQuery<Message[]>({
    queryKey: chatKeys.messagesByConv(convId ?? "__none__"),
    queryFn: async () => {
      if (!convId) return [];
      const rows = await db.messages.listByConversation(convId);
      return rows.map((r) => rowToMessage(r as DbMessageRow));
    },
    enabled: !!convId,
    staleTime: 0,
  });
  return { data, isLoading, source: "sqlite" };
}

// ─── appendMessage — single-message write + broadcast ──────────────────
export async function appendMessage(convId: string, msg: Message): Promise<void> {
  await db.messages.append(messageToRow(msg, convId));

  // VEC1 — best-effort index for semantic search. FIRE-AND-FORGET so the
  // user-visible appendMessage returns as soon as the SQL INSERT lands.
  // Awaiting vecIndex blocks the chat flow for 5-30s on the very first call
  // (fastembed downloads/loads the 87 MB ONNX model lazily). Skipping the
  // await is safe: the chat UI re-renders from the SQL invalidation, not
  // from the vector index.
  const indexText = (msg.text ?? msg.body ?? "").trim();
  if (indexText && !indexText.startsWith("data:image")) {
    void (async () => {
      try {
        const { vecIndex } = await import("@/lib/vector");
        await vecIndex("messages", String(msg.id), indexText);
      } catch (err) {
        console.warn("[chat-sync] vecIndex messages failed:", err);
      }
    })();
  }

  try {
    const mod = await import("@tauri-apps/api/event");
    await mod.emit(EVT_MESSAGES, { conversationId: convId });
  } catch (err) {
    console.warn("[chat-sync] emit messages failed:", err);
  }
}

// ─── sendChatMessage — high-level user→provider→ai round-trip ──────────
// Invariant: the user message is persisted BEFORE the invoke is made, so
// it always appears in both windows even if the provider call hangs or
// fails. The AI message (real or error) is persisted on completion.
// Streaming partials are NOT broadcast — useChatStream remains local to
// whichever window initiated the send (documented v1 trade-off).
export async function sendChatMessage(
  convId: string,
  text: string,
  modelId: string,
  imageDataUrl?: string,
): Promise<void> {
  const trimmed = text.trim();
  // Allow empty text when an image is provided (image-only messages are valid).
  if (!trimmed && !imageDataUrl) return;

  const userId = newMessageId("u");
  const userMsg: Message = {
    id: userId,
    role: "user",
    ts: nowHHMM(),
  };
  if (trimmed) userMsg.text = trimmed;
  if (imageDataUrl) {
    // The data URL IS the message body when image=true. The image flag tells
    // renderers to show an <img> instead of interpreting body as markdown text.
    userMsg.body = imageDataUrl;
    userMsg.image = true;
  }
  await appendMessage(convId, userMsg);

  // ── Phase 1: routing classification ────────────────────────────────
  // The mascot's send path forks into three routes:
  //   - chat-direct  : existing fast path (force think OFF below)
  //   - chat-think   : existing path with thinking auto/on
  //   - delegate     : spawn an orchestrator agent + relay verbatim
  // The heuristic is in routingHeuristic.ts. Settings can override via
  // `routing.delegateOverride` ("always-delegate" / "never-delegate").
  const overrideRaw = await db.settings.get("routing.delegateOverride");
  const delegateOverride = parseDelegateOverride(overrideRaw);
  const route = resolveRoute(trimmed, delegateOverride);

  if (route === "delegate") {
    await handleDelegate(convId, trimmed);
    return;
  }
  // Below: chat-direct + chat-think continue the existing chat flow.
  // chat-direct callers will want thinking OFF; we annotate that intent
  // into `forceThinkingOff` so the chat_template_kwargs resolution below
  // honours it without depending on the per-provider toggle.
  const forceThinkingOff = route === "chat-direct";

  // Default to anthropic if the caller passed a bare model id (no prefix).
  const id = modelId?.includes("/") ? modelId : "anthropic/claude-haiku-4-5";
  const { providerId, protocol: defaultProtocol, baseUrl: defaultBaseUrl, model: realModel } = resolveProvider(id);

  // STRICT MODE — a provider must be explicitly enabled by the user (i.e. a
  // Save in Settings → Connections has happened) before chat can route to it.
  // The previous "auto-probe local endpoints" behavior caused the bug where
  // a llama.cpp marked DISCONNECTED in Settings still served chat requests
  // because the registry's default baseUrl was reachable. Now: no Save → no
  // chat, and the user gets a clear pointer to where to fix it.
  const enabled = await getProviderEnabled(providerId);
  if (enabled !== "true") {
    const reason = enabled === "false"
      ? `est désactivé (Disconnect dans Settings → Connections)`
      : `n'est pas configuré`;
    await appendMessage(convId, {
      id: newMessageId("e"),
      role: "ai",
      body: `⚠ Le provider "${providerId}" ${reason}. Va dans Settings → Connections, ouvre la carte ${providerId}, renseigne ce qu'il faut puis clique Save — ou choisis un autre modèle dans le picker.`,
      ts: nowHHMM(),
    });
    return;
  }

  // Pull persisted credentials + endpoint overrides for this providerId.
  // For built-in providers, only `apiKey` + an optional `baseUrl` override
  // are meaningful. For user-added "custom-*" providers, also pick up the
  // stored `protocol` (set at creation time by AddProviderModal) since
  // those are NOT in the registry and resolveProvider returns "custom" by
  // default — which Rust would reject.
  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defaultProtocol;
  if (defaultProtocol === "custom") {
    const storedProtocol = await getConfig(providerId, "protocol");
    if (storedProtocol === "anthropic" || storedProtocol === "openai" || storedProtocol === "ollama" || storedProtocol === "custom") {
      protocol = storedProtocol;
    }
  }
  const baseUrl: string = (cfg.baseUrl && cfg.baseUrl !== "") ? cfg.baseUrl : defaultBaseUrl;
  const apiKey: string | undefined = (cfg.apiKey && cfg.apiKey !== "") ? cfg.apiKey : undefined;

  // Per-provider thinking-mode router. Three values:
  //   - "auto"  (default): run a cheap regex heuristic on `trimmed` to
  //                        decide. Casual messages get fast direct answers,
  //                        substantive ones get the reasoning phase.
  //   - "on"               : always reason (model's untouched default).
  //   - "off"              : never reason, direct answers only.
  // See src/lib/thinkingHeuristic.ts for the decision tree. The resolved
  // boolean is forwarded to llama-server as chat_template_kwargs so the
  // chat template either injects or omits the `<think>` prefix on a
  // per-request basis (no server restart needed). Anthropic / OpenAI /
  // Ollama ignore unknown body fields, so the kwarg is safe to send
  // everywhere.
  const thinkingMode = parseThinkingMode(await getConfig(providerId, "enableThinking"));
  // chat-direct route forces thinking OFF regardless of the per-provider
  // toggle — that's the whole point of the route classification (casual
  // messages skip the reasoning phase). chat-think defers to the provider
  // toggle.
  const thinkingEnabled = forceThinkingOff ? false : resolveThinking(thinkingMode, trimmed);
  // We only inject the kwarg when we want to FORCE OFF — leaving the field
  // absent means "use the chat template's default", which on Qwen 3.5 is
  // thinking-on. Forcing on with `{enable_thinking: true}` is harmless but
  // redundant.
  const chatTemplateKwargs: Record<string, unknown> | undefined =
    thinkingEnabled ? undefined : { enable_thinking: false };

  // Build the full conversation history from SQLite so the LLM has context
  // for follow-up questions. Without this, every message was treated as a
  // fresh conversation — Gemma even confidently claimed it had "memory of
  // our conversation" while having literally none.
  //
  // The user message we just appendMessage'd above is already in the table,
  // so iterating the rows gives us [...prior turns, this fresh user turn]
  // in the exact order the API expects. Empty / image-only rows are skipped
  // because the OpenAI / Anthropic / Ollama APIs all reject empty content.
  const rows = await db.messages.listByConversation(convId);
  const apiMessages = rows
    .map((r) => {
      // SQLite row: role is "user" / "ai"; map to API expectation "assistant".
      // V5: messages with via_agent=1 are verbatim orchestrator output.
      // We map them as role:"assistant" rather than as a synthetic system
      // injection — the orchestrator IS the assistant of this conversation
      // at that turn (the mascot has explicitly delegated), and the user's
      // follow-ups will reference "what you just produced". Treating them
      // as the previous assistant turn preserves multi-turn coherence at
      // the cost of letting the chat model "see" content from a more
      // capable model — acceptable per the Phase 1 trade-offs.
      const role = r.role === "ai" ? "assistant" : r.role;
      // Image rows: r.body is a base64 dataURL (potentially MBs). Never send
      // it to the LLM API — use the user-visible text or a compact placeholder.
      const text = r.image === 1
        ? ((r.text ?? "").trim() || "[image attached]")
        : ((r.text ?? "").trim() || (r.body ?? "").trim() || (r.code_text ?? "").trim());
      return { role, content: text };
    })
    .filter((m) => m.content !== "");

  // Defensive: if the SQLite read returned nothing (which shouldn't happen
  // since we just inserted the user message), at least send the current prompt.
  if (apiMessages.length === 0) {
    apiMessages.push({ role: "user", content: trimmed });
  }

  // Design-system context (open-design). When the user activated a system in
  // the Design view ("Utiliser dans le chat"), prepend it as a leading system
  // message so generated UIs follow that style. INVOKE-ONLY: this is NEVER
  // written to db.messages — it's rebuilt per send from the active-system
  // store and truncated to fit modest local context windows. chat_send folds
  // role:"system" into Anthropic's top-level `system` param (chat.rs:241/273)
  // and passes it inline for OpenAI-compat (chat.rs:440), so no Rust change is
  // needed. Absent an active system this is a no-op (zero impact on chat).
  const activeDs = getActiveDesignSystem();
  if (activeDs && (activeDs.designMd.trim() || activeDs.tokensCss.trim())) {
    apiMessages.unshift({ role: "system", content: buildDesignSystemPrompt(activeDs) });
  }

  // Capture the reasoning trace for persistence. The streaming UI hooks
  // (useChatStream in ChatView / ChatPanel) already consume `chat://delta`
  // events for live rendering — we attach a SECOND, persistence-oriented
  // listener here so the reasoning is durable across reloads and the user
  // can re-consult what the model "thought". The two listeners are
  // independent: Tauri broadcasts each event to every subscriber.
  //
  // We `await` the listener attach BEFORE the invoke so the subscription
  // is guaranteed live when Rust starts emitting (otherwise the first
  // 50-200 ms of reasoning would race the listener registration).
  let reasoningAcc = "";
  let unlistenReasoning: (() => void) | null = null;
  try {
    const mod = await import("@tauri-apps/api/event");
    unlistenReasoning = await mod.listen<{ kind?: string; chunk: string; done: boolean }>(
      "chat://delta",
      (e) => {
        const p = e.payload;
        if (p?.done) return;
        if (p?.kind === "reasoning" && typeof p.chunk === "string") {
          reasoningAcc += p.chunk;
        }
      },
    );
  } catch (err) {
    console.warn("[chat-sync] reasoning listener attach failed:", err);
  }

  try {
    // imageDataUrl is persisted in the SQLite row (r.body, r.image=1) but
    // apiMessages strips it to "[image attached]" placeholder to avoid token
    // bloat in conversation history. We pass the CURRENT message's image
    // separately via `attachedImage`: Rust injects it as a multimodal content
    // block on the LAST user message so vision-capable models (Claude 3.5+,
    // GPT-4o) actually see it.
    const reply = await invoke<string>("chat_send", {
      messages: apiMessages,
      model: realModel,
      protocol,
      baseUrl,
      apiKey,
      conversationId: convId,
      chatTemplateKwargs,
      attachedImage: imageDataUrl,
    });
    // Parse fenced ```code blocks``` out of the reply so the UI gets the
    // structured Message.code shape (CodeBlock component highlights + the
    // "Open in editor" button works). v1 keeps only the FIRST extracted
    // block because Message.code is singleton; surplus blocks remain in
    // prose. See src/lib/markdown.ts header for the rationale.
    const parsed = parseAiReply(reply);
    const aiMsg: Message = {
      id: newMessageId("a"),
      role: "ai",
      ts: nowHHMM(),
    };
    if (parsed.prose) aiMsg.body = parsed.prose;
    if (parsed.codeBlocks.length > 0) aiMsg.code = parsed.codeBlocks[0];
    // Safety: a reply that was JUST whitespace would produce neither body
    // nor code — fall back to the raw text so the user sees SOMETHING.
    if (!aiMsg.body && !aiMsg.code) aiMsg.body = reply;
    if (reasoningAcc) aiMsg.reasoning = reasoningAcc;
    await appendMessage(convId, aiMsg);
  } catch (err) {
    await appendMessage(convId, {
      id: newMessageId("e"),
      role: "ai",
      body: "⚠ chat_send failed: " + String(err),
      reasoning: reasoningAcc || undefined,
      ts: nowHHMM(),
    });
  } finally {
    unlistenReasoning?.();
  }
}

// ─── Phase 1: delegation path ─────────────────────────────────────────
//
// When the routing heuristic returns "delegate", the user's task is
// handed off to a separately-configured orchestrator agent (Claude
// Sonnet, OpenCode, Codex, …). The orchestrator's output is appended
// to the chat VERBATIM — no LLM re-wrapping, no parseAiReply pass,
// just `output → message.body`. A "via orchestrator" badge on the
// rendered message links back to the agent's transcript in the
// Agents panel.
//
// CTA path: if no `routing.orchestratorModel` is configured (or the
// associated provider is disabled), we append a short instructional
// message instead and emit `app://navigate` so the main IDE jumps to
// Settings → Connections.
/**
 * Resolve the configured orchestrator's model + provider config. Shared by
 * the chat delegate path (handleDelegate) and the Design Studio "Generate"
 * (StudioView) so both spawn agents through the SAME provider resolution.
 * Returns a discriminated result; callers map the failure reasons to their
 * own UX (chat message vs Studio banner).
 */
export type OrchestratorResolution =
  | { kind: "ok"; model: string; protocol: Protocol; baseUrl: string; apiKey?: string }
  | { kind: "no-orchestrator" }
  | { kind: "disabled"; providerId: string };

export async function resolveOrchestrator(): Promise<OrchestratorResolution> {
  const orchestratorModelRaw = await db.settings.get("routing.orchestratorModel");
  const orchestratorModel = orchestratorModelRaw && orchestratorModelRaw.trim();
  if (!orchestratorModel) return { kind: "no-orchestrator" };

  // Prefix the id with `openai/` if no slash so resolveProvider doesn't fall
  // through to "unknown provider".
  const fullId = orchestratorModel.includes("/") ? orchestratorModel : `openai/${orchestratorModel}`;
  const { providerId, protocol: defaultProtocol, baseUrl: defaultBaseUrl, model: realModel } =
    resolveProvider(fullId);

  const enabled = await getProviderEnabled(providerId);
  if (enabled !== "true") return { kind: "disabled", providerId };

  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defaultProtocol;
  if (defaultProtocol === "custom") {
    const storedProtocol = await getConfig(providerId, "protocol");
    if (
      storedProtocol === "anthropic" ||
      storedProtocol === "openai" ||
      storedProtocol === "ollama" ||
      storedProtocol === "custom"
    ) {
      protocol = storedProtocol;
    }
  }
  const baseUrl: string = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defaultBaseUrl;
  const apiKey: string | undefined = cfg.apiKey && cfg.apiKey !== "" ? cfg.apiKey : undefined;
  return { kind: "ok", model: realModel, protocol, baseUrl, apiKey };
}

async function handleDelegate(convId: string, task: string): Promise<void> {
  const orch = await resolveOrchestrator();
  if (orch.kind !== "ok") {
    if (orch.kind === "no-orchestrator") {
      await appendMessage(convId, {
        id: newMessageId("e"),
        role: "ai",
        body:
          "⚠ Cette demande ressemble à une tâche de développement, mais aucun **orchestrator** n'est configuré.\n\n" +
          "Configure-le dans **Settings → Connections** (section Routing) pour activer la délégation — par exemple un Claude Sonnet via API, ou un OpenCode/Codex local.",
        ts: nowHHMM(),
      });
      try {
        const mod = await import("@tauri-apps/api/event");
        await mod.emit("app://navigate", { path: "/connections" });
      } catch (err) {
        console.warn("[chat-sync] navigate emit failed", err);
      }
    } else {
      await appendMessage(convId, {
        id: newMessageId("e"),
        role: "ai",
        body: `⚠ Le provider orchestrator "${orch.providerId}" n'est pas activé. Ouvre Settings → Connections, configure-le et clique Save.`,
        ts: nowHHMM(),
      });
    }
    return;
  }

  const { model: realModel, protocol, baseUrl, apiKey } = orch;

  // Spawn the agent FIRST. We need the agentId to attach to the placeholder
  // so the reconciler (on mount) can match an orphan placeholder back to
  // its (possibly already-completed) agent. Without this link, an orphan
  // "Orchestrateur au travail…" message stays forever even though its
  // output is sitting in the agents table.
  let agentId: string;
  try {
    agentId = await spawnAgent({
      role: "orchestrator",
      task,
      model: realModel,
      conversationId: convId,
      protocol,
      baseUrl,
      apiKey,
    });
  } catch (err) {
    await appendMessage(convId, {
      id: newMessageId("e"),
      role: "ai",
      body: `⚠ Impossible de lancer l'orchestrator : ${String(err)}`,
      ts: nowHHMM(),
    });
    return;
  }

  // Plan v4 — pré-populer le cache `agentKeys.detail(agentId)` AVEC un
  // transcript vide AVANT que les premiers deltas n'arrivent. Sans ça,
  // useAgentEvents.setQueryData verrait `prev === undefined` et dropperait
  // les premiers deltas (cf. comment dans useEvents.ts:43-52). Le queryFn
  // de useAgentTranscript (passif, staleTime: Infinity) ne refetchera
  // jamais, donc on doit fournir un container valide dès maintenant.
  // useAgentEvents appendra les deltas / non-delta events au fur et à
  // mesure ; quand un consumer mount useAgentTranscript(agentId), le
  // cache est déjà initialisé donc pas de fetch déclenché.
  const placeholderAgentRow: AgentRow = {
    id: agentId,
    role: "orchestrator",
    status: "running",
    parentId: null,
    model: realModel,
    task,
    conversationId: convId,
    createdAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
  };
  queryClient.setQueryData<ParsedAgentTranscript>(
    agentKeys.detail(agentId),
    (prev) => prev ?? { agent: placeholderAgentRow, events: [] },
  );

  // Placeholder message linked to the agent. Same id reused on overwrite
  // below so we hit `INSERT OR REPLACE` in `db.messages.append`. The
  // `agentId` is critical: it lets the reconciler at mount time find this
  // placeholder, query its agent's status, and replace the body with the
  // final output if the JS-side listener missed the `complete` event
  // (e.g. window crash during streaming, 5-min timeout race, HMR reload).
  const placeholderId = newMessageId("a");
  const placeholderTs = nowHHMM();
  const placeholderMsg: Message = {
    id: placeholderId,
    role: "ai",
    body: "Orchestrateur au travail…",
    ts: placeholderTs,
    viaAgent: true,
    agentId,
  };

  // SYNCHRONOUS pre-populate du cache TanStack AVANT le SQLite write. Sans
  // ça, le premier delta de l'agent peut arriver entre `appendMessage` et
  // le refetch déclenché par `chat://messages-changed` — la map `messages.map`
  // dans `useChatEvents` ne trouve pas le placeholder, le delta se perd dans
  // un buffer module-scope sans jamais s'attacher à un message visible.
  // En pré-populant le cache, on garantit que dès le tout premier delta, le
  // placeholder est déjà accessible via getQueriesData → setQueryData partiel.
  queryClient.setQueryData<Message[]>(
    chatKeys.messagesByConv(convId),
    (prev = []) => {
      if (prev.some((m) => m.id === placeholderId)) return prev;
      return [...prev, placeholderMsg];
    },
  );

  await appendMessage(convId, placeholderMsg);

  diag("delegate", `placeholder injected agent=${agentId.slice(0, 8)} conv=${convId}`);
  const delegateT0 = performance.now();
  const [waitPromise] = awaitAgentComplete(agentId, { timeoutMs: 5 * 60 * 1000 });

  try {
    const { output } = await waitPromise;
    const elapsed = Math.round(performance.now() - delegateT0);
    diag(
      "delegate",
      `complete agent=${agentId.slice(0, 8)} elapsed=${elapsed}ms outputLen=${output.length}`,
    );
    // VERBATIM relay — no parseAiReply, no code-block splitting, no
    // mascot re-wrapping. The orchestrator's output goes straight into
    // the message body, with the agent_id link so the chip can deep-
    // link to the transcript.
    await appendMessage(convId, {
      id: placeholderId,
      role: "ai",
      body: output,
      ts: placeholderTs,
      viaAgent: true,
      agentId,
    });
  } catch (err) {
    // The JS listener gave up (timeout, window thrash, etc.) — but the
    // Rust agent may have completed anyway. Do ONE last SQLite check
    // before declaring failure to the user. This is the path that
    // recovers the "Orchestrateur au travail…" stuck-placeholder bug we
    // saw in production: agent.status=complete with a 2.5KB output sat
    // in the DB while the chat displayed "agent timeout".
    try {
      const { getAgentTranscript } = await import("@/lib/agents");
      const transcript = await getAgentTranscript(agentId);
      if (transcript.agent.status === "complete" && transcript.agent.output) {
        await appendMessage(convId, {
          id: placeholderId,
          role: "ai",
          body: transcript.agent.output,
          ts: placeholderTs,
          viaAgent: true,
          agentId,
        });
        return;
      }
    } catch (probeErr) {
      console.warn("[chat-sync] final transcript probe failed:", probeErr);
    }
    await appendMessage(convId, {
      id: placeholderId,
      role: "ai",
      body: `⚠ Orchestrator a échoué : ${String(err)}`,
      ts: placeholderTs,
      viaAgent: true,
      agentId,
    });
  }
}

/**
 * Sweep the conversation for orphan "Orchestrateur au travail…" placeholders
 * left behind when the JS listener died before the `complete` event arrived
 * (window crash mid-stream, 5-min timeout race, HMR reload during a run,
 * pre-agentId-in-placeholder legacy rows). For each, query the agent's
 * current status — if it's `complete`, replace the placeholder body with
 * the durable output sitting in `agents.output`.
 *
 * Safe to call multiple times: the placeholder check is exact-string, so
 * any message that has already been reconciled (body now contains the
 * real output) is skipped.
 *
 * Pre-agentId-in-placeholder messages have `agentId == null` — those we
 * can still recover by finding the latest complete agent in the same
 * conversation that has no message linking to it. We only attempt that
 * for the SINGLE most-recent unlinked complete agent to avoid cross-
 * matching multiple historical placeholders to the wrong agent.
 */
export async function reconcileOrphanPlaceholders(convId: string): Promise<void> {
  try {
    const messages = await db.messages.listByConversation(convId);
    const { getAgentTranscript, listAgentsByConversation } = await import("@/lib/agents");

    // Pass 1: placeholders with an explicit agentId (post-fix runs).
    // Note: MessageRow uses snake_case (`agent_id`), while the UI-side
    // Message type uses camelCase (`agentId`). MessageRow.ts is a number
    // (epoch ms) while Message.ts is the HH:MM display string — for the
    // overwrite we just use `nowHHMM()` since the placeholderId stays
    // stable (INSERT OR REPLACE), so ordering is preserved by id, not ts.
    for (const msg of messages) {
      if (msg.role !== "ai") continue;
      if (msg.body !== "Orchestrateur au travail…") continue;
      if (!msg.agent_id) continue;
      try {
        const t = await getAgentTranscript(msg.agent_id);
        if (t.agent.status === "complete" && t.agent.output) {
          await appendMessage(convId, {
            id: msg.id,
            role: "ai",
            body: t.agent.output,
            ts: nowHHMM(),
            viaAgent: true,
            agentId: msg.agent_id,
          });
        } else if (t.agent.status === "error" || t.agent.status === "killed") {
          await appendMessage(convId, {
            id: msg.id,
            role: "ai",
            body: `⚠ Orchestrator a échoué : ${t.agent.error || t.agent.status}`,
            ts: nowHHMM(),
            viaAgent: true,
            agentId: msg.agent_id,
          });
        }
        // pending/running: leave the placeholder; awaitAgentComplete or
        // the next reconcile pass will catch it.
      } catch {
        // Transcript fetch failed (agent row gone?) — leave the placeholder.
      }
    }

    // Pass 2: legacy placeholders without an agentId. Match to the
    // single most-recent complete agent of this conv that no message
    // currently links to.
    const orphanLegacy = messages.find(
      (m) => m.role === "ai" && m.body === "Orchestrateur au travail…" && !m.agent_id,
    );
    if (orphanLegacy) {
      try {
        const agents = await listAgentsByConversation(convId);
        const linkedIds = new Set(
          messages.map((m) => m.agent_id).filter((x): x is string => !!x),
        );
        const candidate = agents
          .filter((a) => a.status === "complete" && a.output && !linkedIds.has(a.id))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (candidate) {
          await appendMessage(convId, {
            id: orphanLegacy.id,
            role: "ai",
            body: candidate.output as string,
            ts: nowHHMM(),
            viaAgent: true,
            agentId: candidate.id,
          });
        }
      } catch (err) {
        console.warn("[chat-sync] legacy reconcile failed:", err);
      }
    }
  } catch (err) {
    console.warn("[chat-sync] reconcileOrphanPlaceholders failed:", err);
  }
}

function newMessageId(kind: "u" | "a" | "e"): string {
  const uuid =
    typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
      ? (crypto as any).randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `m-${kind}-${uuid}`;
}

// ─── Active conversation sync (one-way: main IDE → mascot) ─────────────
// FloatChat in the mascot window has no conv switcher, so writes happen
// only from the main IDE's ChatSidebar. Reads happen in both windows.
// Persist via localStorage so a fresh mascot window finds the right
// conv before any event fires.
function loadActive(): string {
  try {
    const raw = localStorage.getItem(KEY_ACTIVE);
    if (raw) return raw;
  } catch {
    // localStorage unavailable — fall through.
  }
  return "c1";
}

export function getActiveConv(): string {
  return loadActive();
}

/**
 * useActiveConv (TanStack) — id de la conversation actuellement ouverte.
 *
 * Persistance localStorage + sync cross-window via Tauri event. Le state
 * vit dans le QueryClient (queryKey synthétique). Le setter écrit dans
 * localStorage + emit Tauri event ; le listener (mount dans useChatEvents)
 * cross-window setQueryData. Pas de useState, pas d'useEffect dispersé.
 */
export function useActiveConv(): [string, (id: string) => void] {
  const { data: active = loadActive() } = useQuery<string>({
    queryKey: chatKeys.activeConv(),
    queryFn: () => loadActive(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setActive = useCallback((id: string) => {
    queryClient.setQueryData<string>(chatKeys.activeConv(), id);
    try { localStorage.setItem(KEY_ACTIVE, id); } catch { /* quota */ }
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        await mod.emit(EVT_ACTIVE, { conversationId: id });
      } catch (err) {
        console.warn("[chat-sync] emit active failed:", err);
      }
    })();
  }, []);

  return [active, setActive];
}

// ─── Active model sync (same dual-channel pattern as useActiveConv) ────
// Persisted so the selected model survives an app restart, and broadcast so
// the main IDE composer and the mascot's FloatChat stay in sync when one
// of them switches model. Same caveats as the active-conv hook: localStorage
// is the fast path; the Tauri custom event guarantees cross-WebviewWindow
// delivery (the `storage` browser event is best-effort across windows).
function loadActiveModel(initial?: string): string {
  try {
    const raw = localStorage.getItem(KEY_ACTIVE_MODEL);
    if (raw) return raw;
  } catch {
    // localStorage unavailable — fall through.
  }
  // If the caller supplied a sensible initial (e.g. a legacy ChatView prop),
  // honor it on first load — but never persist it: subsequent renders will
  // read from localStorage. This avoids a flash-of-default on first ever
  // app start while still letting the picker's setActive overwrite later.
  if (initial && initial.includes("/")) return initial;
  return DEFAULT_ACTIVE_MODEL;
}

export function useActiveModel(initial?: string): [string, (m: string) => void] {
  const { data: active = loadActiveModel(initial) } = useQuery<string>({
    queryKey: chatKeys.activeModel(),
    queryFn: () => loadActiveModel(initial),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setActive = useCallback((m: string) => {
    queryClient.setQueryData<string>(chatKeys.activeModel(), m);
    try { localStorage.setItem(KEY_ACTIVE_MODEL, m); } catch { /* quota */ }
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        await mod.emit(EVT_ACTIVE_MODEL, { model: m });
      } catch (err) {
        console.warn("[chat-sync] emit active-model failed:", err);
      }
    })();
  }, []);

  return [active, setActive];
}

// ─── createConversation — insert a fresh conv row + return its id ──────
export async function createConversation(title: string = "New chat"): Promise<string> {
  const id = `c${Date.now()}`;
  await db.conversations.create({
    id,
    title,
    project_id: null,
    pinned: 0,
    archived: 0,
    unread: 0,
    env: null,
    parent_id: null,
    updated_at: Date.now(),
  });
  return id;
}
