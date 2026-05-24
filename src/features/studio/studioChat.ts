// Shugu Forge — Design Studio conversation (Phase F).
//
// The Studio "Créer" surface is a CONVERSATION: after the first generation the
// user keeps chatting ("rends le hero plus grand") and each message is a new
// orchestrator turn that reads + edits the existing .shugu-forge/preview/
// files. This store holds the UI turn log only — the agent transcripts (the
// live activity) live in the agents query cache keyed by agentId; we keep
// references.
//
// Pattern: synthetic-query store, like studioDraft / activeDesignSystem. In
// memory: it survives sub-tab navigation (route unmount) but resets on app
// reload — the generated files on disk are the durable artefact, the chat log
// is not.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { ActiveDesignSystem } from "@/features/design/activeDesignSystem";
import type { DiscoveryAnswers } from "./generationContext";
import type { StudioDraft } from "./studioDraft";

export interface StudioTurn {
  id: string;
  /** The user's instruction for this turn (brief for turn 1, follow-up after). */
  userText: string;
  /** The spawned orchestrator agent — its transcript drives the activity card. */
  agentId: string;
  /** Turn-1 only: a short human summary of the chosen base / direction / prefs. */
  context?: string;
}

const KEY = ["studio", "chat"] as const;

export function useStudioChat(): StudioTurn[] {
  return (
    useQuery<StudioTurn[]>({
      queryKey: KEY,
      queryFn: () => [],
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? []
  );
}

export function appendStudioTurn(turn: StudioTurn): void {
  const cur = queryClient.getQueryData<StudioTurn[]>(KEY) ?? [];
  queryClient.setQueryData<StudioTurn[]>(KEY, [...cur, turn]);
}

export function clearStudioChat(): void {
  queryClient.setQueryData<StudioTurn[]>(KEY, []);
}

const PREF_LABELS: Record<keyof DiscoveryAnswers, string> = {
  palette: "palette",
  typography: "typo",
  layout: "layout",
  mood: "ambiance",
  density: "densité",
  audience: "audience",
  tone: "ton",
  constraints: "contraintes",
};

/** Turn-1 summary line: base system OR direction + count of preferences set. */
export function buildTurnContext(active: ActiveDesignSystem | null, draft: StudioDraft): string | undefined {
  const bits: string[] = [];
  if (active) bits.push(`Base : ${active.name}`);
  else if (draft.direction) bits.push(`Direction : ${draft.direction.name}`);
  const prefs = (Object.keys(PREF_LABELS) as (keyof DiscoveryAnswers)[]).filter(
    (k) => (draft.discovery[k] ?? "").trim(),
  );
  if (prefs.length) bits.push(`${prefs.length} préférence${prefs.length > 1 ? "s" : ""}`);
  return bits.length ? bits.join(" · ") : undefined;
}

/**
 * Build the task for an iteration turn. The disk files are the source of truth
 * for visual state, but phrases like "undo that" or "like before but blue"
 * need intent history — so we include the last few user instructions for
 * continuity (capped to bound prompt growth).
 */
export function buildIterationTask(turns: StudioTurn[], instruction: string): string {
  const prior = turns.map((t) => t.userText).slice(-6);
  const history = prior.length
    ? `\n\nDemandes précédentes de cette session (plus ancienne → plus récente) :\n${prior
        .map((p, i) => `${i + 1}. ${p}`)
        .join("\n")}`
    : "";
  return (
    "Itère sur le projet existant dans .shugu-forge/preview/ — lis d'abord les fichiers " +
    `actuels, puis applique cette demande :\n\n${instruction}${history}`
  );
}

/** A DOM element the user picked in the preview (via the postMessage bridge). */
export interface SelectedElement {
  tag: string;
  selector: string;
  text: string;
  open: string;
}

/**
 * Task for a targeted edit of one previewed element. The descriptor (selector +
 * text + opening tag) lets the agent locate it in the source; kept focused (no
 * session history) since the change is local to that element.
 *
 * Note: `sel.text` / `sel.open` come from the user's OWN generated page (DOM),
 * so they're treated as element-identifying data here. The agent acts on them,
 * but it is workspace-bounded (fs tools only reach the open folder), so a quirky
 * element label can't escalate beyond editing the preview project.
 */
export function buildElementEditTask(instruction: string, sel: SelectedElement): string {
  const lines: (string | null)[] = [
    "Modifie un élément précis du projet existant dans .shugu-forge/preview/.",
    "Lis d'abord les fichiers actuels (index.html + CSS/JS), localise cet élément, puis applique la demande.",
    "",
    "Élément ciblé :",
    `- balise : ${sel.tag}`,
    `- sélecteur : ${sel.selector}`,
    sel.text ? `- texte : "${sel.text}"` : null,
    `- HTML : ${sel.open}`,
    "",
    `Demande : ${instruction}`,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
