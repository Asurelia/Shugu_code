// Shugu Forge — idle store (module-scope).
//
// Tracks the timestamp of the user's most recent interaction so the chibi's
// mood can transition to `sad` (long idle) or `smile` (fresh interaction)
// without coupling that timer to any specific panel.
//
// Multiple sites call bumpInteract():
//   - FloatShell on avatar click / drag (panel-agnostic interactions)
//   - ChatPanel on send / loadConvo / newConvo (chat-flavored interactions)
//   - Future panels (TaskPanel, AgentLog, ...) on their own actions
//
// useChibiMood reads useIdleMs() to drive its priority table. Keeping idle
// in a module-scope store means all the bump sites share one clock instead
// of each maintaining its own.

import { useEffect, useState } from "react";

const TICK_MS = 5_000;

let lastInteract = Date.now();
const subscribers = new Set<() => void>();

function notify(): void {
  subscribers.forEach(fn => fn());
}

export function bumpInteract(): void {
  lastInteract = Date.now();
  notify();
}

export function getLastInteract(): number {
  return lastInteract;
}

export function subscribeIdle(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** React-reactive ms-since-last-interaction. Ticks every 5s so idle-driven moods update. */
export function useIdleMs(): number {
  const [last, setLast] = useState(lastInteract);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const unsub = subscribeIdle(() => setLast(lastInteract));
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => { unsub(); clearInterval(t); };
  }, []);

  return now - last;
}
