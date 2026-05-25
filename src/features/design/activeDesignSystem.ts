// Shugu Forge — active design system (open-design catalogue).
//
// The design system the user picked "Utiliser dans le chat" from the Design
// view. When set, sendChatMessage threads its spec + tokens into the
// orchestrator's system prompt so generated UIs follow that style.
//
// Pattern: TanStack "synthetic query as global state" (same as
// useSelectedAgentId in features/agents/queries.ts) — no Zustand for one
// shared primitive; readable imperatively (sendChatMessage) and reactively
// (the active-system chip / Design view).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export interface ActiveDesignSystem {
  id: string;
  name: string;
  /** Raw DESIGN.md (design direction + rules). */
  designMd: string;
  /** Raw tokens.css (CSS custom properties). */
  tokensCss: string;
}

const KEY = ["design", "active-system"] as const;

/** Reactive read — components re-render when the active system changes. */
export function useActiveDesignSystem(): ActiveDesignSystem | null {
  return (
    useQuery<ActiveDesignSystem | null>({
      queryKey: KEY,
      queryFn: () => null, // value is only ever written via setActiveDesignSystem
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? null
  );
}

/** Imperative read — for sendChatMessage (outside React render). */
export function getActiveDesignSystem(): ActiveDesignSystem | null {
  return queryClient.getQueryData<ActiveDesignSystem | null>(KEY) ?? null;
}

export function setActiveDesignSystem(ds: ActiveDesignSystem | null): void {
  queryClient.setQueryData<ActiveDesignSystem | null>(KEY, ds);
}

/**
 * Format the active design system as a system-prompt prefix for chat
 * generation. Truncated to fit modest context windows — a full DESIGN.md +
 * tokens.css can reach 40–60 KB, which silently overflows llama.cpp's default
 * 8K–32K local context. DESIGN.md (the agent-readable direction) is favoured
 * over tokens.css when over budget; an explicit marker shows what was cut so
 * the LLM (and a human reading the prompt) knows it's partial.
 *
 * Called at SEND time (sendChatMessage), never at SET time — the store keeps
 * the FULL text so the Design view's Tokens/Spec tabs stay complete and a
 * future "send full spec" toggle is one branch away.
 */
export function buildDesignSystemPrompt(ds: ActiveDesignSystem, maxChars = 14000): string {
  const header =
    `You are generating UI that must adhere to the "${ds.name}" design system. ` +
    `Follow its visual direction and use its design tokens (reference them as var(--name)).`;
  const designMd = ds.designMd.trim();
  const tokensCss = ds.tokensCss.trim();

  const clip = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n)}\n\n[…truncated, ${s.length - n} chars omitted]`;

  // Reserve room for the header + section labels, then split the remainder
  // favouring DESIGN.md (65%) over tokens.css (35%). When DESIGN.md is short,
  // tokens.css absorbs the slack rather than wasting the budget.
  const budget = Math.max(0, maxChars - header.length - 200);
  const designBudget = Math.min(designMd.length, Math.floor(budget * 0.65));
  const tokensBudget = Math.max(0, budget - designBudget);

  const parts = [header];
  if (designMd) parts.push(`# Design direction\n${clip(designMd, designBudget)}`);
  if (tokensCss) parts.push(`# Tokens (CSS custom properties)\n${clip(tokensCss, tokensBudget)}`);
  return parts.join("\n\n");
}
