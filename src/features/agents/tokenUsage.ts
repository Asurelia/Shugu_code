// Shugu Forge — P6.2 : agrégation tokens + jauge de fenêtre de contexte.
//
// Helpers PURS (aucune I/O) extraits pour rester testables en Vitest, dans la
// lignée de useMessageDisplay.parsePlan / followUpQueue.ts. Consomme les
// events persistés `tokenUsage` / `contextWindowUsage` / `memoryCompacted`
// d'un transcript agent — fonctionne donc aussi APRÈS reload, pas juste live.
//
// Contrat d'honnêteté : un champ undefined = non rapporté par le provider.
// On ne fabrique jamais de zéro ; l'UI distingue « mesuré » (provider) et
// « estimé » (estimateur local) via `source`.

import type { AgentEvent } from "@/lib/agents";

/** Agrégat des events `tokenUsage` d'un run. Champ undefined = jamais
 *  rapporté par le provider sur AUCUN tour (≠ 0). */
export interface AggregatedUsage {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  /** Nombre de tours ayant rapporté au moins un champ. */
  turns: number;
}

/** Somme Option-aware des events tokenUsage du transcript (dans l'ordre). */
export function aggregateTokenUsage(events: AgentEvent[]): AggregatedUsage {
  const out: AggregatedUsage = { turns: 0 };
  for (const ev of events) {
    if (ev.kind !== "tokenUsage") continue;
    out.turns += 1;
    if (ev.inputTokens != null) out.input = (out.input ?? 0) + ev.inputTokens;
    if (ev.outputTokens != null) out.output = (out.output ?? 0) + ev.outputTokens;
    if (ev.cacheCreationInputTokens != null) {
      out.cacheCreation = (out.cacheCreation ?? 0) + ev.cacheCreationInputTokens;
    }
    if (ev.cacheReadInputTokens != null) {
      out.cacheRead = (out.cacheRead ?? 0) + ev.cacheReadInputTokens;
    }
  }
  return out;
}

/** Total tous canaux (entrée cache incluse + sortie) — undefined si rien de
 *  rapporté. Anthropic rapporte le cache HORS input_tokens : l'additionner
 *  n'est donc pas un double compte. */
export function totalTokens(u: AggregatedUsage): number | undefined {
  const sum = (u.input ?? 0) + (u.output ?? 0) + (u.cacheCreation ?? 0) + (u.cacheRead ?? 0);
  return sum > 0 ? sum : undefined;
}

/** Format compact FR : 950 → "950", 12 340 → "12,3 k", 1 250 000 → "1,25 M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const fr = (v: number, digits: number) => v.toFixed(digits).replace(".", ",");
  if (n < 100_000) return `${fr(n / 1000, 1)} k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} k`;
  return `${fr(n / 1_000_000, 2)} M`;
}

/** Seuil de teinte d'alerte de la jauge = fraction du budget de compaction. */
export const CONTEXT_WARN_FRACTION = 0.75;

export interface ContextFill {
  /** Pourcentage 0-100 (borné — un dépassement reste lisible : >100 possible
   *  quand l'estimateur surestime avant compaction ; on borne à 100 pour la
   *  barre mais on garde le ratio brut dans `over`). */
  pct: number;
  /** true dès 75 % — zone où la compaction token-aware peut se déclencher. */
  warn: boolean;
  /** used > window (la compaction n'a pas encore tourné ou l'estimation dépasse). */
  over: boolean;
}

export function contextFill(used: number, window: number): ContextFill {
  if (window <= 0) return { pct: 0, warn: false, over: false };
  const ratio = used / window;
  return {
    pct: Math.min(100, Math.round(ratio * 100)),
    warn: ratio >= CONTEXT_WARN_FRACTION,
    over: ratio > 1,
  };
}

/** Libellé honnête de la source de la jauge (contrat : jamais « mesuré »
 *  pour une estimation). */
export function usageSourceLabel(source: "provider" | "estimate"): string {
  return source === "provider" ? "mesuré (provider)" : "estimé";
}

/** Dernier état `contextWindowUsage` du transcript (le plus récent gagne). */
export function latestContextUsage(
  events: AgentEvent[],
): { used: number; window: number; source: "provider" | "estimate" } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === "contextWindowUsage") {
      return { used: ev.used, window: ev.window, source: ev.source };
    }
  }
  return null;
}

/** Résumé des compactions du run (`memoryCompacted`) — count = combien de
 *  fois, folded = total des tours repliés. null si jamais compacté. */
export function compactionInfo(
  events: AgentEvent[],
): { count: number; folded: number } | null {
  let count = 0;
  let folded = 0;
  for (const ev of events) {
    if (ev.kind === "memoryCompacted") {
      count += 1;
      folded += ev.folded;
    }
  }
  return count > 0 ? { count, folded } : null;
}
