// Shared types shared across features.

export type Role = "user" | "ai" | "system";

export interface CodeAttachment { lang: string; text: string }

export interface Message {
  id: number | string;
  role: Role;
  text?: string;
  body?: string;
  ts?: string;
  code?: CodeAttachment;
  image?: boolean;
  /** `<think>...</think>` reasoning trace from thinking-enabled models
   * (Qwen 3.5, DeepSeek-R1, Llama-3.3-R). Captured live during streaming,
   * persisted alongside the message so it stays consultable later. NOT
   * sent back to the model as conversation history — chat-sync rebuilds
   * history from `text`/`body`/`code` only. */
  reasoning?: string;
  /** True when this message is a verbatim relay of an orchestrator agent's
   * output. Drives the "via orchestrator" chip + click-to-transcript flow. */
  viaAgent?: boolean;
  /** Agent id for the badge click handler (open the transcript drawer). */
  agentId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  group?: string;
  pinned?: boolean;
  unread?: boolean;
  status: "active" | "archived";
  env?: "dev" | "prod";
  updated: number;
  children?: Conversation[];
}

export interface Generation {
  id: number | string;
  prompt: string;
  ratio: string;
  hue: number;
  ts: string;
  model?: string;
  seed?: number;
  steps?: number;
  guidance?: number;
  style?: string;
}

export interface FileNode {
  name: string;
  path: string;
  open?: boolean;
  git?: "M" | "A" | "D";
  children?: FileNode[];
}

export interface FileContent {
  lang: string;
  text: string;
  original?: string;
  dirty?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  icon: string;
  color: string;
  status: "running" | "done" | "idle";
  desc: string;
  log: string;
  elapsed: string;
  progress: number;
}

export interface GalleryFolder {
  id: string;
  name: string;
  count: number;
}

export interface DockTab {
  id: string;
  kind: "term" | "agent" | "output" | "problems";
  name: string;
  /** Which pane the tab belongs to: 0 = main pane, 1 = split pane.
   *  Undefined is treated as 0 for backwards compatibility. */
  pane?: 0 | 1;
}
export interface DockState {
  side: "bottom" | "top" | "left" | "right" | "hidden";
  size: number;            // legacy px size (no longer used for layout — kept for compat)
  sizePct?: number;        // dock panel size as a % of the workspace (react-resizable-panels)
  resizeNonce?: number;    // bump to force the PanelGroup to remount at sizePct (Reset/Maximize)
  tabs: DockTab[];
  activeId: string | null;       // active tab id in pane 0
  splitActiveId: string | null;  // active tab id in pane 1 (null when not split)
  split: boolean;
  /** @deprecated use splitActiveId. Kept transiently for migration of in-memory state. */
  splitId?: string | null;
  splitRatio: number;
  _lastSide?: string;
}
