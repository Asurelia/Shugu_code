// Shugu Forge — Lot mascotte-avatar (2026-06-10) — store de la bulle de parole.
//
// La mascotte ne fait plus que changer d'expression : elle PARLE. sayMascot()
// pose un MascotSpeech dans le cache TanStack + programme son auto-effacement
// après le TTL — même pattern fire/expire que moodReactionStore (un nouvel
// énoncé n'est jamais effacé par le timer d'un ancien, comparaison firedAt).
//
// Cross-window : chaque webview a son propre QueryClient ; les events Tauri
// (agent://lifecycle…) sont broadcast aux deux fenêtres, donc chacune alimente
// SON cache. Seule la fenêtre mascotte rend <SpeechBubble/> — les say() émis
// depuis la fenêtre main y restent silencieux par construction.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

const SPEECH_KEY = ["mascot", "speech"] as const;

/** Ton de l'énoncé — pilote l'accent visuel de la bulle (liseré/teinte). Le
 * SENS ne repose jamais sur la couleur seule : le texte porte l'info. */
export type SpeechTone = "info" | "success" | "error" | "proud";

export interface MascotSpeech {
  text: string;
  tone: SpeechTone;
  firedAt: number;
  ttlMs: number;
  /** Quand l'énoncé concerne un agent : un clic sur la bulle l'ouvre. */
  agentId?: string;
}

/** La mascotte dit quelque chose (fire-and-forget, TTL auto). */
export function sayMascot(
  text: string,
  opts: { tone?: SpeechTone; ttlMs?: number; agentId?: string } = {},
): void {
  const speech: MascotSpeech = {
    text,
    tone: opts.tone ?? "info",
    firedAt: Date.now(),
    ttlMs: opts.ttlMs ?? 5000,
    agentId: opts.agentId,
  };
  queryClient.setQueryData<MascotSpeech>(SPEECH_KEY, speech);
  setTimeout(() => {
    const cur = getMascotSpeech();
    if (cur && cur.firedAt === speech.firedAt) {
      queryClient.setQueryData<MascotSpeech | null>(SPEECH_KEY, null);
    }
  }, speech.ttlMs);
}

/** Efface la bulle immédiatement (clic utilisateur). */
export function clearMascotSpeech(): void {
  queryClient.setQueryData<MascotSpeech | null>(SPEECH_KEY, null);
}

/** Lecture non-réactive (snapshot ponctuel). */
export function getMascotSpeech(): MascotSpeech | null {
  return queryClient.getQueryData<MascotSpeech>(SPEECH_KEY) ?? null;
}

/** Hook réactif : l'énoncé courant (ou null). Re-render au say + à l'expire. */
export function useMascotSpeech(): MascotSpeech | null {
  const { data = null } = useQuery<MascotSpeech | null>({
    queryKey: SPEECH_KEY,
    queryFn: () => getMascotSpeech(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

/** Tronque un texte pour la bulle (l'énoncé doit rester lisible en un éclair). */
export function truncateSpeech(s: string, max = 80): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
