// Shugu Forge — speakableRewrite.ts : la couche de SYNTHÈSE ORALE (Palier 2).
//
// Le maillon manquant entre « ce que Shugu écrit à l'écran » et « ce qu'elle dit
// à voix haute ». Après une réponse AI, un appel `chat_send` one-shot (même
// provider/modèle que le chat, réutilisé via resolveActiveChatProvider) renvoie
// un JSON {spoken_text, emotion} :
//   - spoken_text = version PARLABLE, condensée, sans markdown ni code ;
//   - emotion     = une valeur de l'enum affectif (appraisal léger par le LLM).
// L'EXPRESSION du chibi est DÉRIVÉE de l'émotion (moodFor) plutôt que demandée
// au LLM : une SEULE source d'émotion pilote voix ET visage → ils ne peuvent
// pas se contredire (principe de la boucle affective, cf. affect.ts).
//
// Robustesse : la fonction ne rejette JAMAIS. Tout échec (provider absent, appel
// réseau, JSON invalide, texte vide) retombe sur un plan DÉTERMINISTE (strip
// markdown + émotion heuristique) — la voix ne casse jamais le flux (invariant
// hérité du useTts). Coût borné : speakReply ne lance l'appel LLM que si la voix
// est ON.

import { invoke } from "@/lib/tauri";
import { resolveActiveChatProvider } from "@/features/chat/resolveProvider";
import { getActiveModel } from "@/features/chat/chat-sync";
import { SHUGU_SPEAKABLE_PROMPT } from "@/features/chat/persona";
import { SPEAK_CONV_PREFIX } from "@/features/code/ai-edit/types";
import {
  coerceEmotion,
  deriveEmotionHeuristic,
  moodFor,
  stripMarkdownForSpeech,
  type ShuguEmotion,
} from "./affect";
import { ttsSpeak, isTtsEnabled } from "./useTts";
import { fireMoodDirect } from "./moodReactionStore";
import type { ChibiMood } from "./Chibi";

/** Plan de lecture : quoi dire, avec quelle émotion, et quelle tête faire. */
export interface SpokenPlan {
  spokenText: string;
  emotion: ShuguEmotion;
  expression: ChibiMood;
}

/** Borne le contexte envoyé au LLM de synthèse (une réponse énorme n'a pas
 *  besoin d'être transmise en entier pour en tirer 2 phrases). */
const MAX_CONTEXT_CHARS = 4000;
/** Longueur max du texte parlé retourné (le TTS re-tronque à 400). */
const MAX_SPOKEN_CHARS = 500;

/** Séquence pour un conversationId UNIQUE par appel (comme aiedit:* utilise
 *  genId()) : évite toute collision de deux one-shots concurrents dans le
 *  registre d'abort Rust keyé par id. Le préfixe reste `speak:` → toujours
 *  reconnu hors-flux par isOutOfBandConvId. */
let speakSeq = 0;

// ---------------------------------------------------------------------------
// Déclenchement de la vocalisation (corrige le trou orchestrateur)
// ---------------------------------------------------------------------------

/** Message minimal observé par la vocalisation (sous-ensemble de Message). */
export interface SpeakableMessage {
  id: string | number;
  role: string;
  body?: string;
  text?: string;
  image?: boolean;
}

export interface SpeechTrigger {
  /** Faut-il vocaliser ce message maintenant ? */
  speak: boolean;
  /** Clé (id + body) de l'état courant du dernier message — à mémoriser pour le
   *  prochain calcul (dédup + détection de la transition placeholder→final). */
  key: string;
  /** Texte à vocaliser (défini seulement si speak). */
  text?: string;
}

/**
 * Décide s'il faut vocaliser le DERNIER message, à partir de son état courant et
 * de la clé du dernier énoncé déjà émis. Pur + testable.
 *
 * Corrige le trou orchestrateur : le message-placeholder est remplacé EN PLACE
 * (même id → longueur du tableau inchangée) ; un déclencheur sur `msgs.length`
 * rate donc la vraie réponse. On suit à la place une clé `id + body` — le
 * placeholder n'est jamais « prêt » (garde), et quand le body devient final la
 * clé change → on lit UNE fois. Le body ne prend jamais d'états partiels (le
 * streaming live de l'agent est rendu depuis un cache séparé, pas via msgs),
 * donc aucun risque de vocaliser un fragment.
 */
export function computeSpeechTrigger(
  newest: SpeakableMessage | undefined,
  lastSpokenKey: string | null,
  placeholder: string,
): SpeechTrigger {
  const key = newest ? String(newest.id) + " " + (newest.body ?? "") : "";
  const ready =
    !!newest &&
    newest.role === "ai" &&
    newest.image !== true &&
    !!newest.body &&
    newest.body !== placeholder;
  const speak = ready && key !== lastSpokenKey;
  return speak
    ? { speak: true, key, text: String(newest!.text ?? newest!.body) }
    : { speak: false, key };
}

/** Plan de secours SANS LLM : nettoyage markdown + émotion heuristique. Toujours
 *  disponible, jamais en échec. */
export function deterministicPlan(reply: string): SpokenPlan {
  const spokenText = stripMarkdownForSpeech(reply).slice(0, MAX_SPOKEN_CHARS);
  const emotion = deriveEmotionHeuristic(reply);
  return { spokenText, emotion, expression: moodFor(emotion) };
}

/** Tronque au besoin le texte source transmis au LLM. */
function clampContext(s: string): string {
  return s.length <= MAX_CONTEXT_CHARS
    ? s
    : s.slice(0, MAX_CONTEXT_CHARS) + "\n[… réponse tronquée …]";
}

/** Bloc « user » : la réponse à résumer + éventuellement la demande d'origine
 *  (aide le modèle à cibler l'essentiel), séparés par des repères clairs. */
function buildContext(reply: string, userPrompt?: string): string {
  const parts: string[] = [];
  if (userPrompt && userPrompt.trim()) {
    parts.push("DEMANDE DE L'UTILISATEUR :\n" + clampContext(userPrompt.trim()));
  }
  parts.push("RÉPONSE À RÉSUMER À VOIX HAUTE :\n" + clampContext(reply.trim()));
  return parts.join("\n\n");
}

/** Extrait un objet JSON d'une sortie LLM, même entourée de texte ou de fences. */
function extractJson(raw: string): unknown | null {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : t).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* le modèle a entouré le JSON de prose — on isole les accolades */
  }
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      /* toujours invalide → null */
    }
  }
  return null;
}

/** Parse la sortie LLM en SpokenPlan, ou null si inexploitable. */
export function parseSpokenPlan(raw: string): SpokenPlan | null {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const rawSpoken =
    typeof rec.spoken_text === "string"
      ? rec.spoken_text
      : typeof rec.spokenText === "string"
        ? rec.spokenText
        : "";
  // Sécurité : même si le modèle glisse du markdown malgré la consigne, on nettoie.
  const spokenText = stripMarkdownForSpeech(rawSpoken).slice(0, MAX_SPOKEN_CHARS);
  if (!spokenText) return null; // pas de texte → laisser le fallback déterministe
  const emotion = coerceEmotion(rec.emotion);
  return { spokenText, emotion, expression: moodFor(emotion) };
}

/**
 * Produit le plan de lecture d'une réponse AI. Un appel LLM de synthèse orale ;
 * fallback déterministe garanti sur le moindre échec. Ne throw jamais.
 */
export async function speakableRewrite(
  reply: string,
  opts?: { userPrompt?: string },
): Promise<SpokenPlan> {
  const fallback = deterministicPlan(reply);
  try {
    if (!reply.trim()) return fallback;
    const resolved = await resolveActiveChatProvider(getActiveModel());
    if (!resolved) return fallback; // aucun provider activé
    const { protocol, baseUrl, apiKey, model } = resolved;
    const raw = await invoke<string>("chat_send", {
      messages: [
        { role: "system", content: SHUGU_SPEAKABLE_PROMPT },
        { role: "user", content: buildContext(reply, opts?.userPrompt) },
      ],
      model,
      protocol,
      baseUrl,
      apiKey,
      // conversationId HORS-FLUX (`speak:*`), UNIQUE par appel : les deltas de ce
      // one-shot NE doivent PAS alimenter le streaming du chat principal (sinon
      // leur `done` reset STREAM_KEY et coupe un vrai message en cours), et l'id
      // unique évite toute collision dans le registre d'abort Rust. isOutOfBandConvId
      // couvre ce préfixe côté listeners. Cf. useChatStream / chatToolActivityStore.
      conversationId: SPEAK_CONV_PREFIX + "mascot-" + ++speakSeq,
      // Synthèse pure : aucun outil (pas de lecture/écriture fs).
      readTools: false,
      writeTools: false,
    });
    return parseSpokenPlan(raw) ?? fallback;
  } catch (err) {
    // Fallback légitime (la voix ne casse jamais le flux) MAIS on LOG : une clé
    // morte / un quota MiniMax épuisé / un provider mal configuré remontent ici
    // comme une exception, et sans trace l'utilisateur croirait que « la synthèse
    // affective est nulle » alors que c'est une panne d'auth/quota diagnosticable.
    console.warn("[speakableRewrite] synthèse orale échouée (fallback déterministe):", err);
    return fallback;
  }
}

/** Dédoublonnage de l'appel LLM de synthèse : la même réponse relue en < 4 s ne
 *  paie pas un second appel `chat_send` (le dédup de ttsSpeak, lui, ne protège
 *  QUE le TTS — l'appel LLM est en amont). Borne le coût sur les re-render /
 *  régénérations rapprochées. */
let lastSpokenReply = "";
let lastSpokenAt = 0;

/**
 * Orchestrateur voix de bout en bout : garde-coût → synthèse orale → voix +
 * expression synchronisées. Fire-and-forget depuis ChatPanel. Ne throw jamais
 * (fire-and-forget en `void` : un rejet deviendrait un unhandledrejection).
 *
 * - Ne lance l'appel LLM que si la voix est ON (sinon zéro coût) et pas en
 *   double sur le même contenu (dédup 4 s → coût LLM borné).
 * - L'émotion pilote la voix (ttsSpeak) ET le visage (fireMoodDirect) à partir
 *   du MÊME plan → synchronisation garantie.
 * - On ne force l'expression que si l'émotion n'est pas « neutral » : une
 *   réponse au ton neutre laisse l'humeur dérivée/événementielle tranquille.
 */
export async function speakReply(reply: string, userPrompt?: string): Promise<void> {
  try {
    if (!(await isTtsEnabled())) return; // voix OFF → pas d'appel LLM (coût borné)
    const now = Date.now();
    if (reply === lastSpokenReply && now - lastSpokenAt < 4000) return;
    lastSpokenReply = reply;
    lastSpokenAt = now;
    const plan = await speakableRewrite(reply, { userPrompt });
    ttsSpeak(plan.spokenText, plan.emotion);
    if (plan.emotion !== "neutral") fireMoodDirect(plan.expression);
  } catch (err) {
    console.warn("[speakReply] échec inattendu:", err);
  }
}
