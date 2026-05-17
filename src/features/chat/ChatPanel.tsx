// Shugu Forge — ChatPanel (default panel content for FloatShell).
//
// Phase 5 split this out of FloatChat. ChatPanel owns the chat-specific
// state (msgs, input, tab/history, pinnedAnno display) and renders the
// floating panel's body (history shell + tabs + composer). It reads
// `mode` and `edge` from useFloatShell() so it can hide the history in
// compact mode and track hasUnread when tucked.
//
// Cross-store writes:
//   - setChatBusy(true)  on send start; setChatBusy(false) on send done
//     → ChibiWithMood reads this to switch the chibi to `joy`
//   - setChatUnread(true) on AI msg arrival while not-visible
//     setChatUnread(false) on mode === "full" or user typing
//     → ChibiWithMood reads this to choose peek_open vs peek_closed

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import {
  useMessages,
  useActiveConv,
  useActiveModel,
  sendChatMessage,
  createConversation,
  reconcileOrphanPlaceholders,
} from "@/features/chat/chat-sync";
import { useChatStream } from "@/features/chat/useChatStream";
import { db } from "@/lib/db";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { AgentsPanel } from "@/features/agents/AgentsPanel";
import { useActiveAgents } from "@/features/agents/queries";
import { revealAgent } from "@/lib/agents";
import { useFloatShell } from "@/features/floating/FloatShell";
import { setChatBusy, useChatBusy } from "@/features/chat/chatBusy";
import { setChatUnread } from "@/features/chat/chatUnread";
import { bumpInteract } from "@/features/mascot/idleStore";
import { useMessageDisplay } from "./useMessageDisplay";
import type { Message } from "@/lib/types";

// Bulle d'un message dans le chat mascotte (variant compact).
//
// La LOGIQUE data (placeholder agent → live streaming, reasoning extraction)
// est partagée avec le main IDE chat via `useMessageDisplay`. Seul le STYLE
// diverge — la mascotte est en mode bulle compacte (fonts 8-10px, padding
// serré) là où views-chat.tsx utilise un layout full panel avec avatars.
function MascotMessage({ m }: { m: Message }) {
  const { displayBody, liveReasoning, isStreamingAgent } = useMessageDisplay(m);

  return (
    <div className={"fm " + (m.role === "user" ? "you" : "ai")}>
      {m.role !== "user" && m.viaAgent && m.agentId && (
        <button
          type="button"
          onClick={() => void revealAgent(m.agentId!)}
          title="Voir la trace de l'orchestrator"
          style={{
            display: "inline-block",
            marginBottom: 4,
            padding: "1px 6px",
            borderRadius: 99,
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            background: "rgba(124, 58, 237, 0.18)",
            color: "var(--primary, #7c3aed)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
          }}
        >
          via orchestrator
        </button>
      )}
      {isStreamingAgent && liveReasoning && !m.reasoning && (
        <details
          open
          style={{
            marginBottom: 4,
            padding: "4px 6px",
            borderLeft: "2px solid rgba(124, 58, 237, 0.35)",
            background: "rgba(124, 58, 237, 0.04)",
            borderRadius: 3,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
        >
          <summary style={{ cursor: "pointer", color: "var(--on-surface-muted)", fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase" }}>
            Thinking…
          </summary>
          <div style={{ marginTop: 4, fontStyle: "italic", color: "var(--on-surface-muted)", whiteSpace: "pre-wrap" }}>
            {liveReasoning}
          </div>
        </details>
      )}
      {m.role !== "user" && m.reasoning && (
        <details
          style={{
            marginBottom: 4,
            padding: "4px 6px",
            borderLeft: "2px solid rgba(124, 58, 237, 0.35)",
            background: "rgba(124, 58, 237, 0.04)",
            borderRadius: 3,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
        >
          <summary style={{ cursor: "pointer", color: "var(--on-surface-muted)", fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase" }}>
            Thinking ({m.reasoning.length} chars)
          </summary>
          <div style={{ marginTop: 4, fontStyle: "italic", color: "var(--on-surface-muted)", whiteSpace: "pre-wrap" }}>
            {m.reasoning}
          </div>
        </details>
      )}
      <span style={{whiteSpace: "pre-wrap"}}>{displayBody}</span>
    </div>
  );
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

export interface ChatPanelProps {
  pinnedAnno?: any;
  clearPinned?: () => void;
}

export function ChatPanel({ pinnedAnno, clearPinned }: ChatPanelProps) {
  const { mode, setMode, edge } = useFloatShell();
  const { data: discoveredModels } = useDiscoveredModels();
  const hasKey = discoveredModels.length > 0;
  const [model] = useActiveModel();
  const [activeConv, setActiveConv] = useActiveConv();
  const { data: msgs } = useMessages(activeConv);
  const [lastMsgCount, setLastMsgCount] = useState(0);
  const [input, setInput] = useState("");
  const busy = useChatBusy();
  const chatStream = useChatStream();
  // Listener is owned by the window root (RootLayout on the main IDE,
  // MascotApp on the mascot). Calling useAgents() here would double-
  // subscribe in the SAME window context — both RootLayout and ChatPanel
  // live in the main window's JS context when /chat is open, so two
  // listeners would have fired per delta event, causing visible freezes
  // on reasoning-heavy LLM runs (~400 chunks × 2 = ~800 store updates).
  // We only READ from the store here; the wiring is done upstream.
  const { data: agentsData } = useActiveAgents();
  const agentsCount = agentsData?.length ?? 0;
  const [tab, setTab] = useState<"feed" | "history" | "agents">("feed");
  const [historyConvs, setHistoryConvs] = useState<{ id: string; title: string; ts: number }[]>([]);
  const [histRefresh, setHistRefresh] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);

  // Track new AI replies arriving while the panel is closed or tucked, so
  // the chibi can pop the peek_open expression. Cleared when the user
  // either expands to full or starts typing again.
  useEffect(() => {
    if (msgs.length > lastMsgCount) {
      const newest = msgs[msgs.length - 1];
      if (newest?.role === "ai" && (mode !== "full" || edge)) {
        setChatUnread(true);
      }
    }
    setLastMsgCount(msgs.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);

  useEffect(() => {
    if (mode === "full") setChatUnread(false);
  }, [mode]);

  useEffect(() => {
    if (input) setChatUnread(false);
  }, [input]);

  // History tab: lazy-load past conversations only when the tab is visible
  // and the panel is open. Web mode (no Tauri / no SQLite) returns [] —
  // empty-state UI takes over.
  useEffect(() => {
    if (mode !== "full" || tab !== "history") return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await db.conversations.list();
        if (cancelled) return;
        const mapped = rows
          .filter((r: any) => r.id !== activeConv && !r.archived)
          .map((r: any) => ({
            id: r.id as string,
            title: (r.title as string) || "Untitled",
            ts: (r.updated_at as number) ?? Date.now(),
          }));
        setHistoryConvs(mapped);
      } catch {
        if (!cancelled) setHistoryConvs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, tab, activeConv, histRefresh]);

  useEffect(() => {
    if (mode === "full" && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [msgs, mode]);

  // Réconcilie les placeholders "Orchestrateur au travail…" laissés
  // orphelins par un freeze/crash précédent (l'agent a fini côté Rust
  // mais le listener JS a manqué le complete event). Innocent du freeze
  // récent (testé Plan v2 Step C).
  useEffect(() => {
    if (!activeConv) return;
    void reconcileOrphanPlaceholders(activeConv);
  }, [activeConv]);

  const newConvo = async () => {
    if (msgs.length === 0) {
      setTab("feed");
      setMode("full");
      return;
    }
    const id = await createConversation("New chat");
    if (id) setActiveConv(id);
    setInput("");
    bumpInteract();
    setTab("feed");
    setMode("full");
    setHistRefresh(n => n + 1);
  };

  const loadConvo = (id: string) => {
    setActiveConv(id);
    setTab("feed");
    setMode("full");
    bumpInteract();
  };

  const deleteConvo = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try { await db.conversations.remove(id); } catch { /* no-op */ }
    setHistoryConvs(h => h.filter(c => c.id !== id));
    setHistRefresh(n => n + 1);
  };

  const send = () => {
    const t = input.trim();
    if (!t || !hasKey) return;
    setInput("");
    setChatBusy(true);
    setMode("full");
    bumpInteract();
    chatStream.start();
    void (async () => {
      try {
        await sendChatMessage(activeConv, t, model);
      } finally {
        setChatBusy(false);
        chatStream.stop();
        bumpInteract();
      }
    })();
  };

  return (
    <>
      {mode === "full" && (
        <div className="float-history-shell">
          {tab === "feed" ? (
            <div className="float-history" ref={historyRef}>
              {msgs.length === 0 && (
                <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                  No conversation yet — say something.
                </div>
              )}
              {msgs.map((m) => (
                <MascotMessage key={String(m.id)} m={m} />
              ))}
              {/* Live streaming preview — shows the reasoning trace (Qwen 3.5 /
                  DeepSeek-style `<think>` block) above the visible answer as
                  they're generated. Disappears the moment the message is
                  persisted to SQLite (chatStream.stop in the send finally). */}
              {chatStream.streaming && (chatStream.partial || chatStream.partialReasoning) && (
                <div className="fm ai">
                  {chatStream.partialReasoning && (
                    <details
                      open
                      style={{
                        marginBottom: 4,
                        padding: "4px 6px",
                        borderLeft: "2px solid rgba(124, 58, 237, 0.35)",
                        background: "rgba(124, 58, 237, 0.04)",
                        borderRadius: 3,
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <summary style={{ cursor: "pointer", color: "var(--on-surface-muted)", fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase" }}>
                        Thinking…
                      </summary>
                      <div style={{ marginTop: 4, fontStyle: "italic", color: "var(--on-surface-muted)", whiteSpace: "pre-wrap" }}>
                        {chatStream.partialReasoning}
                      </div>
                    </details>
                  )}
                  {chatStream.partial && <span style={{ whiteSpace: "pre-wrap" }}>{chatStream.partial}</span>}
                </div>
              )}
            </div>
          ) : tab === "history" ? (
            <div className="float-history-list">
              {historyConvs.length === 0 ? (
                <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                  Pas encore d'historique.
                </div>
              ) : (
                historyConvs.map((h) => (
                  <div key={h.id} className="fhl-item" onClick={() => loadConvo(h.id)}>
                    <div className="fhl-info">
                      <span className="t">{h.title}</span>
                      <span className="m">{fmtAgo(h.ts)}</span>
                    </div>
                    <button className="fhl-del" onClick={(e) => deleteConvo(h.id, e)} title="Supprimer">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : (
            // Agents observability — the third tab, sibling of Chat and Historique.
            // Renders the multi-agent live view (tree of running agents, their
            // status, transcript drawer). The useAgents() call at the top of
            // this component keeps the underlying listener alive even when this
            // tab isn't visible, so agents spawned while the user is on the
            // Chat tab appear instantly when they switch over.
            <div className="float-history-list" style={{ padding: 0 }}>
              <AgentsPanel />
            </div>
          )}
        </div>
      )}

      {mode === "full" && (
        <div className="float-tabs">
          <button className={"float-tab" + (tab === "feed" ? " on" : "")} onClick={() => setTab("feed")} title="Chat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Chat</span>
            {msgs.length > 0 && <span className="float-tab-count">{msgs.length}</span>}
          </button>
          <button className="float-tab new" onClick={() => { void newConvo(); }} title="Nouvelle conversation">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Nouveau</span>
          </button>
          <button className={"float-tab" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")} title="Historique">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span>Historique</span>
            {historyConvs.length > 0 && <span className="float-tab-count">{historyConvs.length}</span>}
          </button>
          {/* Agents tab — third sibling, shows the multi-agent observability
              view (runtime tree, transcripts). Org-chart-style icon to read
              instantly as "agent hierarchy" without needing a label scan. */}
          <button className={"float-tab" + (tab === "agents" ? " on" : "")} onClick={() => setTab("agents")} title="Agents">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="5" rx="1"/>
              <rect x="2" y="17" width="6" height="5" rx="1"/>
              <rect x="16" y="17" width="6" height="5" rx="1"/>
              <path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>
            </svg>
            <span>Agents</span>
            {agentsCount > 0 && <span className="float-tab-count">{agentsCount}</span>}
          </button>
        </div>
      )}

      <div className="float-panel cchrome-naked cstyle-pill csize-thin csend-kbd cfoot-hidden">
        {pinnedAnno && (
          <div className="float-pinned-note">
            pinned
            <span className="target">"{pinnedAnno.label || pinnedAnno.text}"</span>
            <span className="x" onClick={clearPinned}>×</span>
          </div>
        )}

        <div className="float-composer">
          <div style={{position:"relative", minWidth:0}}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={busy ? "…" : "Message Shugu…"}
              rows={1}
            />
            {!input && !hasKey && (
              <button
                className="float-api-badge"
                type="button"
                title="Aucun provider configuré — ouvre Settings → Connections dans la fenêtre principale"
                onClick={async () => {
                  // Cross-window deep-link to Settings → Connections. Each
                  // step is best-effort and logs on failure.
                  try {
                    const eventMod = await import("@tauri-apps/api/event");
                    await eventMod.emit("app://navigate", { path: "/settings/connections" });
                  } catch (err) {
                    console.warn("[chibi] emit navigate failed", err);
                  }
                  try {
                    const winMod = await import("@tauri-apps/api/webviewWindow");
                    const main = await winMod.WebviewWindow.getByLabel("main");
                    if (main) {
                      await main.show();
                      await main.unminimize();
                      await main.setFocus();
                    }
                  } catch (err) {
                    console.warn("[chibi] focus main window failed", err);
                  }
                }}
              >
                Set API key
              </button>
            )}
          </div>
          <div className="float-actions-col">
            <span className={"float-kbd-hint" + (input.trim() && hasKey && !busy ? " ready" : "")} onClick={send} title="Send (Enter)">
              <span className="k">↵</span>
            </span>
            <button className="float-icon-btn attach" title="Attach a file or screenshot">
              <Icon name="attach" size={13}/>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
