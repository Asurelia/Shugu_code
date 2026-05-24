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

/** Replace the whole turn log — used when reopening a saved project. */
export function setStudioChat(turns: StudioTurn[]): void {
  queryClient.setQueryData<StudioTurn[]>(KEY, turns);
}

/**
 * Recover the user's instruction from an agent's stored `task`. Turn-1 briefs
 * are stored raw; iteration tasks wrap the instruction (buildIterationTask /
 * buildElementEditTask), so we strip the known wrappers. Falls back to the raw
 * task (covers the tweak-bake task and anything unrecognised).
 */
export function instructionFromTask(task: string): string {
  const iter = task.match(/applique cette demande\s*:\s*\n+([\s\S]*?)(?:\n+Demandes précédentes|$)/i);
  if (iter) return iter[1].trim();
  const elem = task.match(/\nDemande\s*:\s*([\s\S]*)$/i);
  if (elem) return elem[1].trim();
  return task.trim();
}

/**
 * Rebuild the turn log from a conversation's orchestrator agents (persisted in
 * SQLite) — used when reopening a project. `userText` is recovered from each
 * agent's `task`; `agentId` drives the live transcript card as usual. Pass the
 * agents oldest→newest (the order `listAgentsByConversation` returns).
 */
export function turnsFromAgents(agents: { id: string; task: string }[]): StudioTurn[] {
  return agents.map((a) => ({ id: a.id, userText: instructionFromTask(a.task), agentId: a.id }));
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

/**
 * Task for baking live Tweaks into the project source. In the preview the user
 * nudges CSS custom properties and the injected controller applies them inline
 * at runtime (`style.setProperty` on :root) — instant, but runtime-only. This
 * turn makes them durable by rewriting the `:root` declarations in the actual
 * stylesheet, then the live-reload shows the baked result.
 *
 * `overrides` keys are `--token` names and values are CSS values (may be oklch,
 * hsl, hex, lengths…) read from the user's OWN generated stylesheet, so they're
 * token DATA the agent edits — and it stays workspace-bounded (fs tools only
 * reach the open folder), so a quirky token value can't escalate.
 */
export function buildTweakBakeTask(overrides: Record<string, string>): string {
  const list = Object.entries(overrides)
    .map(([name, value]) => `- ${name}: ${value};`)
    .join("\n");
  return [
    "Applique des ajustements visuels au projet existant dans .shugu-forge/preview/.",
    "Lis d'abord le(s) fichier(s) CSS, puis mets à jour UNIQUEMENT ces variables CSS",
    "dans le bloc :root (garde tout le reste à l'identique) :",
    "",
    list,
    "",
    "Si une variable n'existe pas encore dans :root, ajoute-la. Ne touche ni au HTML ni au JS.",
  ].join("\n");
}
