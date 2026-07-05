// Shugu Forge — affect.ts : source UNIQUE du mapping émotionnel de la mascotte.
//
// Un seul enum `ShuguEmotion` (aligné sur l'API MiniMax T2A v2) se projette sur
// DEUX cibles synchronisées :
//   - la VOIX   : EMOTION_TO_VOICE → { emotion, speed, pitch, vol } pour le
//                 `voice_setting` envoyé à voice_tts ;
//   - le VISAGE : EMOTION_TO_MOOD  → ChibiMood pour fireMoodDirect.
// Ainsi la voix et l'expression du chibi ne divergent JAMAIS. Toute valeur
// inattendue (hallucination LLM en Palier 2, entrée de cache périmée…) retombe
// sur "neutral" → la voix ne casse pas le flux visuel (invariant du useTts).
//
// Réf API : `voice_setting.emotion` ∈ {happy, sad, angry, fearful, disgusted,
// surprised, calm, fluent, whisper} — platform.minimax.io/docs/api-reference/
// speech-t2a-http. « neutral » N'EST PAS une valeur MiniMax : c'est notre
// sentinelle « omettre le champ emotion » (l'API auto-sélectionne alors d'après
// le texte). On n'envoie JAMAIS la string littérale « auto » (non garantie).

import type { ChibiMood } from "./Chibi";

/** État affectif unifié. Les 9 premières valeurs = enum MiniMax exact ;
 *  "neutral" = sentinelle interne « pas d'émotion forcée » (champ omis). */
export type ShuguEmotion =
  | "happy" | "sad" | "angry" | "fearful" | "disgusted"
  | "surprised" | "calm" | "fluent" | "whisper" | "neutral";

/** Valeurs réellement acceptées par l'API MiniMax (sans "neutral").
 *  ⚠ SYNCHRO : doit rester identique à `VALID_EMOTIONS` dans
 *  src-tauri/src/commands/voice.rs — le Rust re-valide et DROPPE silencieusement
 *  toute valeur absente de sa liste (champ omis → auto-sélection). Si tu ajoutes
 *  une émotion ici, ajoute-la aussi là-bas. */
export const MINIMAX_EMOTIONS: readonly ShuguEmotion[] = [
  "happy", "sad", "angry", "fearful", "disgusted",
  "surprised", "calm", "fluent", "whisper",
];

const ALL_EMOTIONS: ReadonlySet<string> = new Set<string>([
  ...MINIMAX_EMOTIONS, "neutral",
]);

/** Paramètres de synthèse passés à voice_tts. `emotion` undefined ⇒ le champ est
 *  omis côté Rust (l'API auto-sélectionne). speed ∈ [0.5, 2], pitch entier
 *  ∈ [-12, 12], vol ∈ (0, 10] — les bornes sont re-clampées côté Rust en
 *  défense en profondeur. */
export interface VoiceParams {
  emotion?: string;
  speed: number;
  pitch: number;
  vol?: number;
}

/** Émotion → réglages voix. Deltas VOLONTAIREMENT faibles (une mascotte de dev,
 *  pas un dessin animé) — à affiner en A/B sur la voix female-shaonv avant de
 *  figer. angry/fearful/disgusted restent discrets : rares pour une assistante,
 *  on ne veut pas d'une voix caricaturale. */
export const EMOTION_TO_VOICE: Record<ShuguEmotion, VoiceParams> = {
  happy:     { emotion: "happy",     speed: 1.05, pitch: 2 },
  surprised: { emotion: "surprised", speed: 1.08, pitch: 2 },
  sad:       { emotion: "sad",       speed: 0.9,  pitch: -2 },
  fearful:   { emotion: "fearful",   speed: 1.03, pitch: 1 },
  angry:     { emotion: "angry",     speed: 1.0,  pitch: 0 },
  disgusted: { emotion: "disgusted", speed: 0.95, pitch: -1 },
  calm:      { emotion: "calm",      speed: 0.97, pitch: 0 },
  fluent:    { emotion: "fluent",    speed: 1.0,  pitch: 0 },
  whisper:   { emotion: "whisper",   speed: 0.95, pitch: 0, vol: 0.8 },
  neutral:   { speed: 1.0, pitch: 0 }, // emotion omis → auto MiniMax
};

/** Émotion → expression du chibi. Les 5 poses « chat » (neutral/smile/joy/sad/
 *  cry) absorbent les 9 émotions MiniMax + la sentinelle. */
export const EMOTION_TO_MOOD: Record<ShuguEmotion, ChibiMood> = {
  happy:     "joy",
  surprised: "smile",
  sad:       "sad",
  fearful:   "sad",
  angry:     "sad",
  disgusted: "sad",
  calm:      "neutral",
  fluent:    "neutral",
  whisper:   "neutral",
  neutral:   "neutral",
};

/** Ramène n'importe quelle entrée (string LLM, valeur de cache, undefined) sur
 *  une ShuguEmotion sûre. Défaut « neutral ». */
export function coerceEmotion(x: unknown): ShuguEmotion {
  return typeof x === "string" && ALL_EMOTIONS.has(x)
    ? (x as ShuguEmotion)
    : "neutral";
}

/** Réglages voix d'une émotion (toujours définis). */
export function voiceParamsFor(emotion: ShuguEmotion): VoiceParams {
  return EMOTION_TO_VOICE[emotion] ?? EMOTION_TO_VOICE.neutral;
}

/** Expression du chibi d'une émotion. */
export function moodFor(emotion: ShuguEmotion): ChibiMood {
  return EMOTION_TO_MOOD[emotion] ?? "neutral";
}

/**
 * Dérivation d'émotion SANS LLM (Palier 1 + fallback du Palier 2). Volontairement
 * prudente : on ne signale une émotion (sad) que sur des marqueurs d'échec FIABLES
 * (préfixes ⚠/❌ des messages d'erreur système, mots « failed/échec/erreur » en
 * tête) ; tout le reste reste « neutral » (MiniMax auto-sélectionne d'après le
 * texte). Le vrai appraisal contextuel est fait par speakableRewrite au Palier 2.
 */
export function deriveEmotionHeuristic(text: string): ShuguEmotion {
  const head = text.slice(0, 48);
  if (/[⚠❌]/.test(head) || /\b(failed|échec|erreur)\b/i.test(head)) return "sad";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Nettoyage texte-écran → texte parlable (Palier 1 + secours du Palier 2)
// ---------------------------------------------------------------------------

/**
 * Transforme un texte ÉCRAN (markdown, transcript verbatim d'orchestrateur) en
 * texte parlable minimal : retire les blocs de code, le markdown inline, les
 * URLs et les puces. Ne RÉSUME pas — condenser sémantiquement est le rôle de
 * speakableRewrite (Palier 2). Ici on évite seulement que la voix récite des
 * symboles (« astérisque astérisque… ») ou lise du code.
 *
 * Pur + idempotent : ré-appliqué en Palier 2 sur un texte déjà propre, c'est un
 * quasi no-op.
 */
export function stripMarkdownForSpeech(input: string): string {
  let t = input;
  // Blocs de code entiers → retirés (on ne lit pas du code à voix haute).
  t = t.replace(/```[\s\S]*?```/g, " ");
  // Code inline `x` → retiré (souvent un identifiant technique imprononçable).
  t = t.replace(/`[^`]*`/g, " ");
  // Images ![alt](url) et liens [texte](url) → on garde le libellé lisible.
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // URLs nues.
  t = t.replace(/https?:\/\/\S+/g, " ");
  // Titres #, citations >, puces -, *, +, listes numérotées — en début de ligne.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s{0,3}>\s?/gm, "");
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, "");
  t = t.replace(/^\s{0,3}\d+[.)]\s+/gm, "");
  // Emphase **gras** *ital* __ _ ~~barré~~ → contenu seul.
  t = t.replace(/(\*\*|__|~~)(.*?)\1/g, "$2");
  t = t.replace(/(^|[^\w*])[*_]([^*_]+)[*_]([^\w*]|$)/g, "$1$2$3");
  // Séparateurs de tableau markdown.
  t = t.replace(/\|/g, " ");
  // Espaces / sauts de ligne condensés.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Découpe un texte parlé en fragments jouables SÉPARÉMENT, à des frontières de
 * phrase, chacun ≤ maxLen. Permet de jouer la 1re phrase pendant que les
 * suivantes se synthétisent (« sentence-splitting » — le time-to-first-audio
 * tombe à la durée de synthèse d'UNE phrase courte au lieu de tout l'énoncé).
 *
 * Ne coupe jamais au milieu d'un mot ; une phrase seule plus longue que maxLen
 * est coupée sur un espace. Pur + testable.
 */
export function splitIntoSpeechChunks(text: string, maxLen = 240): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  // Segmente en phrases en conservant la ponctuation finale ; le dernier
  // fragment sans ponctuation est capturé par la seconde alternative.
  const sentences = clean.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const c = cur.trim();
    if (c) chunks.push(c);
    cur = "";
  };
  for (const raw of sentences) {
    const sent = raw.trim();
    if (!sent) continue;
    if (sent.length > maxLen) {
      // Phrase trop longue : on vide le tampon puis on coupe sur les espaces.
      flush();
      let rest = sent;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(" ", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      cur = rest;
    } else if (!cur) {
      cur = sent;
    } else if ((cur + " " + sent).length <= maxLen) {
      cur = cur + " " + sent;
    } else {
      flush();
      cur = sent;
    }
  }
  flush();
  return chunks;
}
