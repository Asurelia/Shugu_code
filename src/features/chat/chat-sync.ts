// Shugu Forge — chat synchronization between the main IDE window and the
// floating mascot window. Mirrors the architecture established by
// features/mascot/calibration.ts:
//
//   - SQLite is the single source of truth (db.messages).
//   - Cross-window notification rides on the Tauri custom event bus.
//   - The `storage` browser event is wired as a best-effort second channel
//     for state that ALSO lives in localStorage (active conv id only).
//   - Web mode (pnpm dev, no Tauri) degrades to an in-memory module-level
//     cache + subscriber set, so the chat UI stays interactive without
//     SQLite / without a second window.
//
// Public API:
//   useMessages(convId)       — React hook, returns the live message list
//                               and refetches when chat://messages-changed
//                               fires for that convId.
//   appendMessage(convId, m)  — write a single message: SQLite insert +
//                               broadcast event (or web-cache push +
//                               local notify).
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
import { db } from "@/lib/db";
import { invoke } from "@/lib/tauri";
import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { parseAiReply } from "@/lib/markdown";
import type { Message } from "@/lib/types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

// ─── Web-mode in-memory cache ──────────────────────────────────────────
// In pnpm dev (no Tauri), db.messages.append is a no-op. To keep the chat
// UI functional anyway we mirror appends in a module-level Map and notify
// a local subscriber set. This branch is dormant under Tauri.
const webCache = new Map<string, Message[]>();
const webSubscribers = new Set<(convId: string) => void>();
function notifyWeb(convId: string): void {
  for (const fn of webSubscribers) fn(convId);
}

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
  image: number;
  ts: number;
}

function rowToMessage(r: DbMessageRow): Message {
  return {
    id: r.id,
    role: (r.role as Message["role"]),
    text: r.text ?? undefined,
    body: r.body ?? undefined,
    code: r.code_lang && r.code_text ? { lang: r.code_lang, text: r.code_text } : undefined,
    image: r.image === 1 ? true : undefined,
    ts: fmtClock(r.ts),
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
    image: m.image ? 1 : 0,
    // m.ts is the rendered HH:MM string in the UI shape; we don't try to
    // parse it back — the insertion moment is what matters and Date.now()
    // captures it accurately. The clock string is re-derived on read.
    ts: Date.now(),
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
  source: "sqlite" | "web-cache" | "seed";
}

export function useMessages(convId: string | null): MessagesResult {
  const [data, setData] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(!!convId);
  const [source, setSource] = useState<MessagesResult["source"]>("seed");

  useEffect(() => {
    if (!convId) {
      setData([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;

    const refetch = async () => {
      if (inTauri) {
        const rows = await db.messages.listByConversation(convId);
        if (cancelled) return;
        setData(rows.map((r) => rowToMessage(r as DbMessageRow)));
        setSource("sqlite");
        setIsLoading(false);
        return;
      }
      // Web mode: lazy-seed c1 from prototype data, otherwise blank.
      if (!webCache.has(convId)) {
        if (convId === "c1") {
          const seed = await import("@/mocks/seedMessages");
          if (cancelled) return;
          webCache.set(convId, [...seed.seedMessages]);
        } else {
          webCache.set(convId, []);
        }
      }
      if (cancelled) return;
      setData([...(webCache.get(convId) ?? [])]);
      setSource(convId === "c1" ? "seed" : "web-cache");
      setIsLoading(false);
    };

    void refetch();

    // Subscribe to incoming change events.
    let unlisten: (() => void) | null = null;
    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          unlisten = await mod.listen<{ conversationId: string }>(EVT_MESSAGES, (e) => {
            if (cancelled) return;
            // Short-circuit when the change isn't for our conv — keeps the
            // mascot's chat panel from re-rendering on every main-window
            // edit in another conversation.
            if (e.payload?.conversationId !== convId) return;
            void refetch();
          });
        } catch (err) {
          console.warn("[chat-sync] listen messages failed:", err);
        }
      })();
    } else {
      const sub = (changed: string) => {
        if (changed === convId) void refetch();
      };
      webSubscribers.add(sub);
      unlisten = () => { webSubscribers.delete(sub); };
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [convId]);

  return { data, isLoading, source };
}

// ─── appendMessage — single-message write + broadcast ──────────────────
export async function appendMessage(convId: string, msg: Message): Promise<void> {
  if (inTauri) {
    await db.messages.append(messageToRow(msg, convId));
    try {
      const mod = await import("@tauri-apps/api/event");
      await mod.emit(EVT_MESSAGES, { conversationId: convId });
    } catch (err) {
      console.warn("[chat-sync] emit messages failed:", err);
    }
    return;
  }
  // Web mode: mutate the in-memory cache and notify local subscribers.
  if (!webCache.has(convId)) webCache.set(convId, []);
  webCache.get(convId)!.push(msg);
  notifyWeb(convId);
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
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const userId = newMessageId("u");
  await appendMessage(convId, {
    id: userId,
    role: "user",
    text: trimmed,
    ts: nowHHMM(),
  });

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

  // Build the full conversation history from SQLite so the LLM has context
  // for follow-up questions. Without this, every message was treated as a
  // fresh conversation — Gemma even confidently claimed it had "memory of
  // our conversation" while having literally none.
  //
  // The user message we just appendMessage'd above is already in the table,
  // so iterating the rows gives us [...prior turns, this fresh user turn]
  // in the exact order the API expects. Empty / image-only rows are skipped
  // because the OpenAI / Anthropic / Ollama APIs all reject empty content.
  const rows = inTauri ? await db.messages.listByConversation(convId) : (webCache.get(convId) ?? []).map((m) => messageToRow(m, convId));
  const apiMessages = rows
    .map((r) => {
      // SQLite row: role is "user" / "ai"; map to API expectation "assistant".
      const role = r.role === "ai" ? "assistant" : r.role;
      // Prefer `text` (user), fall back to `body` (AI prose), then to nothing.
      // If a row only has a `code` block we still send its text content so
      // the LLM can reason about its own prior code suggestions.
      const text = (r.text ?? "").trim()
        || (r.body ?? "").trim()
        || (r.code_text ?? "").trim();
      return { role, content: text };
    })
    .filter((m) => m.content !== "");

  // Defensive: if the SQLite read returned nothing (which shouldn't happen
  // since we just inserted the user message), at least send the current prompt.
  if (apiMessages.length === 0) {
    apiMessages.push({ role: "user", content: trimmed });
  }

  try {
    const reply = await invoke<string>("chat_send", {
      messages: apiMessages,
      model: realModel,
      protocol,
      baseUrl,
      apiKey,
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
    await appendMessage(convId, aiMsg);
  } catch (err) {
    await appendMessage(convId, {
      id: newMessageId("e"),
      role: "ai",
      body: "⚠ chat_send failed: " + String(err),
      ts: nowHHMM(),
    });
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

export function useActiveConv(): [string, (id: string) => void] {
  const [active, setActiveLocal] = useState<string>(() => loadActive());

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    // Channel 1: storage event — fires when the OTHER window writes to
    // localStorage. Best-effort across Tauri WebviewWindows (see
    // calibration.ts for the same caveat).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY_ACTIVE) return;
      if (typeof e.newValue === "string" && e.newValue) {
        setActiveLocal(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);

    // Channel 2: Tauri custom event — guaranteed cross-window.
    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          unlisten = await mod.listen<{ conversationId: string }>(EVT_ACTIVE, (e) => {
            const id = e.payload?.conversationId;
            if (typeof id === "string" && id) setActiveLocal(id);
          });
        } catch (err) {
          console.warn("[chat-sync] listen active failed:", err);
        }
      })();
    }

    return () => {
      window.removeEventListener("storage", onStorage);
      unlisten?.();
    };
  }, []);

  const setActive = useCallback((id: string) => {
    setActiveLocal(id);
    try { localStorage.setItem(KEY_ACTIVE, id); } catch { /* quota */ }
    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          await mod.emit(EVT_ACTIVE, { conversationId: id });
        } catch (err) {
          console.warn("[chat-sync] emit active failed:", err);
        }
      })();
    }
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
  const [active, setActiveLocal] = useState<string>(() => loadActiveModel(initial));

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY_ACTIVE_MODEL) return;
      if (typeof e.newValue === "string" && e.newValue) setActiveLocal(e.newValue);
    };
    window.addEventListener("storage", onStorage);

    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          unlisten = await mod.listen<{ model: string }>(EVT_ACTIVE_MODEL, (e) => {
            const m = e.payload?.model;
            if (typeof m === "string" && m) setActiveLocal(m);
          });
        } catch (err) {
          console.warn("[chat-sync] listen active-model failed:", err);
        }
      })();
    }

    return () => {
      window.removeEventListener("storage", onStorage);
      unlisten?.();
    };
  }, []);

  const setActive = useCallback((m: string) => {
    setActiveLocal(m);
    try { localStorage.setItem(KEY_ACTIVE_MODEL, m); } catch { /* quota */ }
    if (inTauri) {
      void (async () => {
        try {
          const mod = await import("@tauri-apps/api/event");
          await mod.emit(EVT_ACTIVE_MODEL, { model: m });
        } catch (err) {
          console.warn("[chat-sync] emit active-model failed:", err);
        }
      })();
    }
  }, []);

  return [active, setActive];
}

// ─── createConversation — insert a fresh conv row + return its id ──────
export async function createConversation(title: string = "New chat"): Promise<string> {
  const id = `c${Date.now()}`;
  if (inTauri) {
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
  }
  return id;
}
