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
import { resolveProvider } from "@/lib/providers";
import type { Message } from "@/lib/types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ─── Event names + storage keys (centralized to prevent drift) ─────────
const EVT_MESSAGES = "chat://messages-changed";
const EVT_ACTIVE   = "chat://active-changed";
const KEY_ACTIVE   = "shugu.chat.activeConv.v1";

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
  const { protocol, baseUrl, model: realModel } = resolveProvider(id);

  try {
    const reply = await invoke<string>("chat_send", {
      prompt: trimmed,
      model: realModel,
      protocol,
      baseUrl,
    });
    await appendMessage(convId, {
      id: newMessageId("a"),
      role: "ai",
      body: reply,
      ts: nowHHMM(),
    });
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
