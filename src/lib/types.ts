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

export interface DockTab { id: string; kind: "term" | "agent" | "output" | "problems"; name: string }
export interface DockState {
  side: "bottom" | "top" | "left" | "right" | "hidden";
  size: number;            // legacy px size (no longer used for layout — kept for compat)
  sizePct?: number;        // dock panel size as a % of the workspace (react-resizable-panels)
  resizeNonce?: number;    // bump to force the PanelGroup to remount at sizePct (Reset/Maximize)
  tabs: DockTab[];
  activeId: string | null;
  split: boolean;
  splitId: string | null;
  splitRatio: number;
  _lastSide?: string;
}
