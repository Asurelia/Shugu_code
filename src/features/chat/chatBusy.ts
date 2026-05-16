// Shugu Forge — chat busy store (module-scope).
//
// `busy` is the "the model is generating right now" flag set by ChatPanel
// when send() fires and cleared when sendChatMessage() resolves. It used to
// be local state inside FloatChat — Phase 5 split it out so the ChibiWithMood
// anchor (which lives next to ChatPanel inside FloatShell) can read it for
// mood derivation without prop drilling through the shell.
//
// Single-window store: each window (main IDE + mascot) has its own busy
// flag because each window's ChatPanel maintains its own composer. Cross-
// window chat sync happens at the message-broadcast level (chat-sync.ts) —
// not here.

import { useEffect, useState } from "react";

let busy = false;
const subscribers = new Set<() => void>();

function notify(): void {
  subscribers.forEach(fn => fn());
}

export function setChatBusy(value: boolean): void {
  if (busy === value) return;
  busy = value;
  notify();
}

export function getChatBusy(): boolean {
  return busy;
}

export function subscribeChatBusy(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** React-reactive read of the chat-busy flag. */
export function useChatBusy(): boolean {
  const [value, setValue] = useState(busy);
  useEffect(() => subscribeChatBusy(() => setValue(busy)), []);
  return value;
}
