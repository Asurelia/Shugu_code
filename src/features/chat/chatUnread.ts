// Shugu Forge — chat unread store (module-scope).
//
// `hasUnread` is "an AI reply arrived while the panel was closed or tucked
// at an edge". It used to be local state inside FloatChat. After Phase 5,
// ChatPanel is the sole writer (it owns the msgs/input/mode context needed
// to set/clear it) and ChibiWithMood is the sole reader (it factors hasUnread
// into the peek_open vs peek_closed mood decision).

import { useEffect, useState } from "react";

let unread = false;
const subscribers = new Set<() => void>();

function notify(): void {
  subscribers.forEach(fn => fn());
}

export function setChatUnread(value: boolean): void {
  if (unread === value) return;
  unread = value;
  notify();
}

export function getChatUnread(): boolean {
  return unread;
}

export function subscribeChatUnread(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function useChatUnread(): boolean {
  const [value, setValue] = useState(unread);
  useEffect(() => subscribeChatUnread(() => setValue(unread)), []);
  return value;
}
