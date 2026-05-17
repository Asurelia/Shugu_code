// Shugu Forge — frontend diagnostic helper.
//
// Pourquoi ce module :
//   Pendant le debug du Plan v4 (mai 2026), on a découvert que les events
//   Tauri agent://lifecycle arrivaient avec des fields en snake_case
//   (agent_id) au lieu de camelCase (agentId) à cause d'un bug serde —
//   le `.slice(0,8)` sur undefined throwait silently dans la callback, sans
//   aucun signal visible. Plusieurs heures perdues parce qu'il n'y avait
//   aucun moyen de tracer ce qui se passait côté JS sans ouvrir DevTools
//   (qui sont peu accessibles dans la Tauri WebView2).
//
// Solution : un canal de diag qui mirror les logs JS sur le stdout Rust
// (via la commande `js_diag`). Du coup, en lançant Tauri avec stdout
// redirigé vers un fichier, on capture TOUT (Rust + JS) dans un seul
// trace facile à `grep`. Couplé à des compteurs côté Rust (emit) et
// JS (receive), on peut diagnostiquer toute désync entre les deux.
//
// Usage :
//   import { diag } from "@/lib/diag";
//   diag("agent-events", `event=${event.kind} agent=${id}`);
//
// Activation :
//   Auto-activé en mode dev (import.meta.env.DEV).
//   Catégories filtrables via DIAG_CATEGORIES — passer à `null` pour ALL.
//
// Capture du trace dans un fichier (HORS workspace pour éviter feedback
// loop avec le watcher fs) :
//   PowerShell> $trace = "$env:TEMP\shugu-trace.log"
//               Start-Process -FilePath 'cmd.exe' `
//                 -ArgumentList '/d', '/c', `
//                   "tauri-dev.cmd > `"$trace`" 2>&1" `
//                 -WindowStyle Hidden
//   Puis : `tail -f "$env:TEMP\shugu-trace.log"` ou
//          `grep [agent-events] "$env:TEMP\shugu-trace.log"`

import { invoke } from "@/lib/tauri";

/** Active en dev seulement. Toggle à `false` ici pour silencer même
 *  en dev (utile quand on debug autre chose et que le bruit gêne). */
const DIAG_ENABLED = import.meta.env.DEV;

/** Catégories acceptées. `null` = toutes. Sinon Set de strings. Permet
 *  de tracer juste une feature sans noyer le terminal. */
const DIAG_CATEGORIES: Set<string> | null = null;

/**
 * Log diagnostic — mirror console.log + envoi au stdout Rust via la
 * commande Tauri `js_diag`. Le format final dans le trace est :
 *   [js:agent-events] event=spawn agent=abc12345
 *
 * @param category — courte (kebab-case), e.g. "agent-events", "chat-stream"
 * @param msg      — message libre, déjà formatté côté caller
 */
export function diag(category: string, msg: string): void {
  if (!DIAG_ENABLED) return;
  if (DIAG_CATEGORIES && !DIAG_CATEGORIES.has(category)) return;
  const line = `[${category}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  void invoke("js_diag", { category, msg }).catch(() => {
    // Silently ignore — Rust diag is best-effort. Console log still
    // works for DevTools debugging even if invoke fails (e.g. command
    // not registered on older builds).
  });
}

/**
 * Counter helper — utile pour rate-limiter les diag dans une boucle
 * chaude (e.g. logguer 1 fois sur 50 deltas streaming). Retourne le
 * compteur post-incrément ; le caller décide s'il loggue.
 */
const counters = new Map<string, number>();
export function diagCount(key: string): number {
  const c = (counters.get(key) ?? 0) + 1;
  counters.set(key, c);
  return c;
}

/** Helper combiné : log tous les N events de la même clé. */
export function diagEveryN(category: string, key: string, every: number, msgFn: (count: number) => string): void {
  const c = diagCount(key);
  if (c === 1 || c % every === 0) {
    diag(category, msgFn(c));
  }
}
